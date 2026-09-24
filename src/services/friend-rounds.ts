// "Me ajuda a escolher?": a rodada das amigas. A cliente em dúvida pede à
// Lia; a Lia cria a rodada e devolve o cartão + o link /v/<token>. As amigas
// votam com um toque (sem telefone, sem cadastro), e o placar volta para a
// cliente pela Lia: um resumo 10 min depois do primeiro voto e o fechamento
// em 24 h. Quem votou e quer ver peças abre o WhatsApp DELA com a Lia pela
// ponte (origem "amigas") — a loja nunca escreve primeiro para a amiga.
import { createHash, randomBytes } from "node:crypto";

import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import type { MessagingProvider } from "@/adapters/zapi";
import {
  ANSWER_RETENTION_MS,
  closingLine,
  DECISION_MAX_OPTIONS,
  DECISION_MIN_OPTIONS,
  isRoundOpen,
  normalizeDisplayName,
  normalizeNickname,
  normalizeNote,
  notesBlock,
  optionLabel,
  roundClosesAt,
  scoreboardLine,
  SUMMARY_DELAY_MS,
  tallyRound,
  type RoundOptionLabel,
  type RoundTally,
} from "@/core/friends/decision";
import { friendAnswers, friendRounds, waConversations } from "@/db/schema";
import { enqueueOutboxEvent, type DbOrTx } from "@/queue/enqueue";
import { createSiteCart, loadBridgeSettings, plainBridgeUrl } from "@/services/site-carts";
import { getSettingsMap } from "@/services/settings";
import { publicImageUrl } from "@/services/store-catalog";
import { sendTemplateMessage, siteBaseUrl } from "@/services/wa-messaging";
import { deferOutsideSendWindow, loadSendPolicy } from "@/services/wa-send-policy";

export const FRIENDS_SUMMARY_EVENT = "friends.summary";
export const FRIENDS_CLOSE_EVENT = "friends.close";
export const FRIENDS_PURGE_EVENT = "friends.purge";
export const FRIENDS_SUMMARY_TEMPLATE = "friends_summary";
export const FRIENDS_CLOSED_TEMPLATE = "friends_closed";

export class FriendRoundError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "FriendRoundError";
    this.code = code;
  }
}

export type RoundOptionInput = { productId: string; name: string; detail: string | null; slug: string; imagePath: string | null };

/** Setting friends_vote_enabled: ausente = desligado (tudo nasce desligado). */
export async function isFriendsVoteEnabled(db: DbOrTx): Promise<boolean> {
  const map = await getSettingsMap(db, ["friends_vote_enabled"]);
  return map["friends_vote_enabled"] === true;
}

export function roundPublicUrl(token: string): string {
  return `${siteBaseUrl()}/v/${token}`;
}

const createSchema = z.object({
  conversationId: z.uuid(),
  /** Idempotência: o mesmo pedido (retry do turno) devolve a mesma rodada. */
  createKey: z.string().min(1).max(120),
  displayName: z.string(),
  options: z
    .array(
      z.object({
        productId: z.uuid(),
        name: z.string().min(1).max(200),
        detail: z.string().max(60).nullable(),
        slug: z.string().min(1).max(200),
        imagePath: z.string().nullable(),
      }),
    )
    .min(DECISION_MIN_OPTIONS)
    .max(DECISION_MAX_OPTIONS),
  now: z.date(),
});

/**
 * Cria a rodada (dentro da transação do turno da Lia) e já agenda o
 * fechamento: o placar final sai sozinho, votem ou não.
 */
export async function createDecisionRound(
  tx: DbOrTx,
  input: z.input<typeof createSchema>,
): Promise<{ roundId: string; token: string; url: string; closesAt: Date }> {
  const parsed = createSchema.parse(input);
  // Retry do turno: a rodada deste pedido já existe — devolve a mesma, antes de qualquer validação.
  const [existing] = await tx
    .select({ id: friendRounds.id, token: friendRounds.token, closesAt: friendRounds.closesAt })
    .from(friendRounds)
    .where(eq(friendRounds.createKey, parsed.createKey))
    .limit(1);
  if (existing) return { roundId: existing.id, token: existing.token, url: roundPublicUrl(existing.token), closesAt: existing.closesAt };

  const displayName = normalizeDisplayName(parsed.displayName);
  if (!displayName) throw new FriendRoundError("nome_invalido", "Diga o primeiro nome que as amigas vão ver.");
  const distinct = new Set(parsed.options.map((option) => `${option.productId}:${option.detail ?? ""}`));
  if (distinct.size !== parsed.options.length) throw new FriendRoundError("opcoes_repetidas", "As opções precisam ser diferentes.");

  const token = randomBytes(12).toString("base64url");
  const closesAt = roundClosesAt(parsed.now);
  const [round] = await tx
    .insert(friendRounds)
    .values({
      token,
      kind: "decisao",
      createKey: parsed.createKey,
      conversationId: parsed.conversationId,
      displayName,
      options: parsed.options,
      closesAt,
      createdAt: parsed.now,
    })
    .returning({ id: friendRounds.id });
  await enqueueOutboxEvent(tx, {
    eventType: FRIENDS_CLOSE_EVENT,
    dedupeKey: `friends.close:${round.id}`,
    aggregateType: "friend_round",
    aggregateId: round.id,
    payload: { roundId: round.id },
    nextAttemptAt: closesAt,
  });
  return { roundId: round.id, token, url: roundPublicUrl(token), closesAt };
}

// ---------------------------------------------------------------------------
// A página pública (/v/<token>)
// ---------------------------------------------------------------------------

export type PublicRound = {
  token: string;
  displayName: string;
  options: { letter: string; name: string; detail: string | null; imageUrl: string | null; slug: string }[];
  open: boolean;
  closesAt: Date;
  tally: RoundTally;
};

function safeImageUrl(path: string | null): string | null {
  if (!path) return null;
  try {
    return publicImageUrl(path);
  } catch {
    return null;
  }
}

async function loadRoundByToken(db: DbOrTx, token: string) {
  const parsed = z.string().regex(/^[A-Za-z0-9_-]{8,40}$/).safeParse(token);
  if (!parsed.success) return null;
  const [round] = await db.select().from(friendRounds).where(eq(friendRounds.token, parsed.data)).limit(1);
  return round ?? null;
}

async function loadAnswers(db: DbOrTx, roundId: string) {
  return db
    .select({ choice: friendAnswers.choice, note: friendAnswers.note, nickname: friendAnswers.nickname, createdAt: friendAnswers.createdAt })
    .from(friendAnswers)
    .where(eq(friendAnswers.roundId, roundId))
    .orderBy(desc(friendAnswers.createdAt));
}

export async function getPublicRound(db: DbOrTx, token: string, now: Date = new Date()): Promise<PublicRound | null> {
  const round = await loadRoundByToken(db, token);
  if (!round) return null;
  const answers = await loadAnswers(db, round.id);
  return {
    token: round.token,
    displayName: round.displayName,
    options: round.options.map((option, index) => ({
      letter: optionLabel(index, option.name, option.detail).letter,
      name: option.name,
      detail: option.detail,
      imageUrl: safeImageUrl(option.imagePath),
      slug: option.slug,
    })),
    open: isRoundOpen(round, now),
    closesAt: round.closesAt,
    tally: tallyRound(round.options.length, answers),
  };
}

// ---------------------------------------------------------------------------
// O voto
// ---------------------------------------------------------------------------

const voteSchema = z.object({
  token: z.string().min(8).max(40),
  choice: z.number().int().min(0).max(DECISION_MAX_OPTIONS - 1),
  /** Identificador aleatório do aparelho (guardado no navegador dela); só o hash vai para o banco. */
  voterId: z.uuid(),
  note: z.string().max(500).nullish(),
  nickname: z.string().max(100).nullish(),
  now: z.date(),
});

export type VoteResult =
  | { ok: true; tally: RoundTally }
  | { ok: false; reason: "inexistente" | "fechada" | "opcao_invalida" | "ja_votou"; tally?: RoundTally };

function voterKeyFor(roundId: string, voterId: string): string {
  return createHash("sha256").update(`${roundId}:${voterId}`).digest("hex");
}

export async function voteInRound(db: DbOrTx, input: z.input<typeof voteSchema>): Promise<VoteResult> {
  const parsed = voteSchema.parse(input);
  const round = await loadRoundByToken(db, parsed.token);
  if (!round) return { ok: false, reason: "inexistente" };
  if (!isRoundOpen(round, parsed.now)) return { ok: false, reason: "fechada", tally: tallyRound(round.options.length, await loadAnswers(db, round.id)) };
  if (parsed.choice >= round.options.length) return { ok: false, reason: "opcao_invalida" };

  const inserted = await db.transaction(async (tx) => {
    const rows = await tx
      .insert(friendAnswers)
      .values({
        roundId: round.id,
        voterKey: voterKeyFor(round.id, parsed.voterId),
        choice: parsed.choice,
        note: normalizeNote(parsed.note),
        nickname: normalizeNickname(parsed.nickname),
        createdAt: parsed.now,
      })
      .onConflictDoNothing()
      .returning({ id: friendAnswers.id });
    if (rows.length === 0) return false;
    // O resumo sai 10 min depois do PRIMEIRO voto (o dedupe segura os seguintes).
    await enqueueOutboxEvent(tx, {
      eventType: FRIENDS_SUMMARY_EVENT,
      dedupeKey: `friends.summary:${round.id}`,
      aggregateType: "friend_round",
      aggregateId: round.id,
      payload: { roundId: round.id },
      nextAttemptAt: new Date(parsed.now.getTime() + SUMMARY_DELAY_MS),
    });
    return true;
  });
  const tally = tallyRound(round.options.length, await loadAnswers(db, round.id));
  return inserted ? { ok: true, tally } : { ok: false, reason: "ja_votou", tally };
}

/** Depois de votar: "quero ver peças no meu estilo" abre o WhatsApp DELA com a Lia. */
export async function openRoundBridge(db: DbOrTx, input: { token: string }): Promise<{ url: string | null }> {
  const round = await loadRoundByToken(db, input.token);
  if (!round) return { url: plainBridgeUrl(await loadBridgeSettings(db)) };
  const link = await createSiteCart(db, { source: "amigas", roundId: round.id, friendName: round.displayName });
  return { url: link.waUrl };
}

// ---------------------------------------------------------------------------
// O placar pela Lia: resumo, fechamento e limpeza
// ---------------------------------------------------------------------------

export const friendRoundPayloadSchema = z.object({ roundId: z.uuid() });

export type FriendRoundNoticeResult = { sent: true } | { skipped: string };

async function loadRoundForNotice(db: DbOrTx, roundId: string) {
  const [row] = await db
    .select({ round: friendRounds, phoneE164: waConversations.phoneE164, customerId: waConversations.customerId })
    .from(friendRounds)
    .innerJoin(waConversations, eq(waConversations.id, friendRounds.conversationId))
    .where(eq(friendRounds.id, roundId))
    .limit(1);
  return row ?? null;
}

function labelsOf(round: { options: RoundOptionInput[] }): RoundOptionLabel[] {
  return round.options.map((option, index) => optionLabel(index, option.name, option.detail));
}

/** 10 min depois do primeiro voto: o placar parcial (se a rodada ainda estiver aberta). */
export async function sendRoundSummary(
  db: DbOrTx,
  provider: MessagingProvider,
  input: z.input<typeof friendRoundPayloadSchema> & { now?: Date },
): Promise<FriendRoundNoticeResult> {
  const { roundId } = friendRoundPayloadSchema.parse(input);
  const now = input.now ?? new Date();
  const row = await loadRoundForNotice(db, roundId);
  if (!row) return { skipped: "inexistente" };
  if (!isRoundOpen(row.round, now)) return { skipped: "fechada" };
  const policy = await loadSendPolicy(db);
  const deferred = await deferOutsideSendWindow(db, policy, {
    eventType: FRIENDS_SUMMARY_EVENT,
    dedupeBase: `friends.summary:${roundId}`,
    aggregateType: "friend_round",
    aggregateId: roundId,
    payload: { roundId },
    now,
  });
  if (deferred) return { skipped: "fora_da_janela" };
  const answers = await loadAnswers(db, roundId);
  const labels = labelsOf(row.round);
  const tally = tallyRound(labels.length, answers);
  const result = await sendTemplateMessage(db, provider, {
    templateKey: FRIENDS_SUMMARY_TEMPLATE,
    phoneE164: row.phoneE164,
    vars: {
      placar: scoreboardLine(labels, tally),
      recados: notesBlock(labels, answers.flatMap((answer) => (answer.note ? [{ nickname: answer.nickname, note: answer.note, choice: answer.choice }] : []))),
      link: roundPublicUrl(row.round.token),
    },
    ...(row.customerId ? { customerId: row.customerId } : {}),
    dedupeKey: `wa.friends_summary:${roundId}`,
    // Ela mesma pediu o placar: é a resposta ao pedido dela, não novidade.
    requireOptIn: false,
  });
  return "sent" in result ? { sent: true } : { skipped: result.skipped };
}

/** Fim das 24 h: fecha, manda o resultado e agenda a limpeza dos votos. */
export async function closeFriendRound(
  db: DbOrTx,
  provider: MessagingProvider,
  input: z.input<typeof friendRoundPayloadSchema> & { now?: Date },
): Promise<FriendRoundNoticeResult> {
  const { roundId } = friendRoundPayloadSchema.parse(input);
  const now = input.now ?? new Date();
  const row = await loadRoundForNotice(db, roundId);
  if (!row) return { skipped: "inexistente" };

  if (row.round.closedAt === null) {
    await db.transaction(async (tx) => {
      const closed = await tx
        .update(friendRounds)
        .set({ closedAt: now })
        .where(and(eq(friendRounds.id, roundId), isNull(friendRounds.closedAt)))
        .returning({ id: friendRounds.id });
      if (closed.length === 0) return;
      await enqueueOutboxEvent(tx, {
        eventType: FRIENDS_PURGE_EVENT,
        dedupeKey: `friends.purge:${roundId}`,
        aggregateType: "friend_round",
        aggregateId: roundId,
        payload: { roundId },
        nextAttemptAt: new Date(now.getTime() + ANSWER_RETENTION_MS),
      });
    });
  }

  const policy = await loadSendPolicy(db);
  const deferred = await deferOutsideSendWindow(db, policy, {
    eventType: FRIENDS_CLOSE_EVENT,
    dedupeBase: `friends.close:${roundId}`,
    aggregateType: "friend_round",
    aggregateId: roundId,
    payload: { roundId },
    now,
  });
  if (deferred) return { skipped: "fora_da_janela" };

  const answers = await loadAnswers(db, roundId);
  const labels = labelsOf(row.round);
  const tally = tallyRound(labels.length, answers);
  const result = await sendTemplateMessage(db, provider, {
    templateKey: FRIENDS_CLOSED_TEMPLATE,
    phoneE164: row.phoneE164,
    vars: {
      placar: tally.total > 0 ? scoreboardLine(labels, tally) : "nenhum voto",
      fecho: closingLine(labels, tally),
    },
    ...(row.customerId ? { customerId: row.customerId } : {}),
    dedupeKey: `wa.friends_closed:${roundId}`,
    requireOptIn: false,
  });
  return "sent" in result ? { sent: true } : { skipped: result.skipped };
}

/** 30 dias depois do fim: votos e recados somem (a rodada fica, sem ninguém nela). */
export async function purgeFriendRound(db: DbOrTx, input: z.input<typeof friendRoundPayloadSchema>): Promise<{ deleted: number }> {
  const { roundId } = friendRoundPayloadSchema.parse(input);
  const deleted = await db.delete(friendAnswers).where(eq(friendAnswers.roundId, roundId)).returning({ id: friendAnswers.id });
  return { deleted: deleted.length };
}

/** Para o painel: rodadas no período, votos e amigas que abriram conversa com a Lia. */
export async function friendRoundsFunnel(db: DbOrTx, input: { from: Date; to: Date }) {
  const [row] = await db
    .select({
      rounds: sql<number>`count(distinct ${friendRounds.id})::int`,
      votes: sql<number>`count(${friendAnswers.id})::int`,
    })
    .from(friendRounds)
    .leftJoin(friendAnswers, eq(friendAnswers.roundId, friendRounds.id))
    .where(and(sql`${friendRounds.createdAt} >= ${input.from.toISOString()}`, sql`${friendRounds.createdAt} < ${input.to.toISOString()}`));
  return { rounds: Number(row?.rounds ?? 0), votes: Number(row?.votes ?? 0) };
}

/** As rodadas da conversa, da mais nova para a mais velha (caderninho e painel). */
export async function listConversationRounds(db: DbOrTx, conversationId: string, limit = 3) {
  return db
    .select({ id: friendRounds.id, token: friendRounds.token, closesAt: friendRounds.closesAt, closedAt: friendRounds.closedAt, options: friendRounds.options })
    .from(friendRounds)
    .where(eq(friendRounds.conversationId, conversationId))
    .orderBy(desc(friendRounds.createdAt), asc(friendRounds.id))
    .limit(limit);
}
