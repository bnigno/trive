// "Me ajuda a escolher?": a rodada das amigas. A cliente em dúvida pede à
// Lia; a Lia cria a rodada e devolve o cartão com o link /v/<token>. Quem
// recebe vota com um toque (sem telefone, sem cadastro) e pode deixar um
// recado; o placar volta para a cliente pela Lia — um resumo 10 min depois
// do primeiro voto e o fechamento em 24 h (os dois na janela de envio). Quem
// votou e quer ver peças abre o WhatsApp DELA com a Lia pela ponte (origem
// "amigas") — a loja nunca escreve primeiro para quem não pediu.
import { createHash } from "node:crypto";

import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import type { MessagingProvider } from "@/adapters/zapi";
import {
  ANSWER_RETENTION_MS,
  closesLabel,
  closingLine,
  DECISION_MAX_OPTIONS,
  DECISION_MIN_OPTIONS,
  isRoundOpen,
  normalizeDisplayName,
  normalizeNickname,
  normalizeNote,
  notesBlock,
  NOTES_IN_CLOSING,
  NOTES_PER_MESSAGE,
  optionLabel,
  ROUND_MAX_VOTES,
  roundClosesAt,
  scoreboardLine,
  SUMMARY_DELAY_MS,
  tallyRound,
  type RoundOptionLabel,
  type RoundTally,
} from "@/core/friends/decision";
import { friendAnswers, friendRounds, waConversations } from "@/db/schema";
import { enqueueOutboxEvent, type DbOrTx } from "@/queue/enqueue";
import { getSettingsMap } from "@/services/settings";
import { createSiteCart, loadBridgeSettings, plainBridgeUrl } from "@/services/site-carts";
import { publicMdUrl } from "@/services/store-catalog";
import { sendTemplateMessage, siteBaseUrl } from "@/services/wa-messaging";
import { deferOutsideSendWindow, loadSendPolicy } from "@/services/wa-send-policy";

export const FRIENDS_SUMMARY_EVENT = "friends.summary";
export const FRIENDS_CLOSE_EVENT = "friends.close";
export const FRIENDS_PURGE_EVENT = "friends.purge";
export const FRIENDS_SUMMARY_TEMPLATE = "friends_summary";
export const FRIENDS_CLOSED_TEMPLATE = "friends_closed";
/** O nome que fica na rodada depois da limpeza (a coluna não aceita vazio). */
const PURGED_NAME = "cliente";

export class FriendRoundError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "FriendRoundError";
    this.code = code;
  }
}

/** Setting friends_vote_enabled: ausente = desligado (tudo nasce desligado). */
export async function isFriendsVoteEnabled(db: DbOrTx): Promise<boolean> {
  const map = await getSettingsMap(db, ["friends_vote_enabled"]);
  return map["friends_vote_enabled"] === true;
}

export type RoundOptionInput = { productId: string; name: string; detail: string | null; slug: string; imagePath: string | null };

export function roundPublicUrl(token: string): string {
  return `${siteBaseUrl()}/v/${token}`;
}

/**
 * O token sai da chave de criação (a mensagem da cliente + as peças): o
 * retry do turno — mesmo depois de a transação desfazer — gera o MESMO link
 * que já pode ter chegado a ela. A chave tem um uuid que ninguém de fora vê.
 */
function tokenFor(createKey: string): string {
  return createHash("sha256").update(`friend-round:${createKey}`).digest("base64url").slice(0, 16);
}

const createSchema = z.object({
  conversationId: z.uuid(),
  /** Idempotência: a mesma mensagem com as mesmas peças devolve a mesma rodada. */
  createKey: z.string().min(1).max(200),
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

/** A chave de criação: a mensagem que pediu + as peças (outra escolha no mesmo turno = outra rodada). */
export function roundCreateKey(lastInboundId: string, options: readonly Pick<RoundOptionInput, "productId" | "detail">[]): string {
  const pieces = createHash("sha256")
    .update(options.map((option) => `${option.productId}:${option.detail ?? ""}`).join("|"))
    .digest("hex")
    .slice(0, 16);
  return `turn:${lastInboundId}:${pieces}`;
}

/**
 * Cria a rodada (dentro da transação do turno da Lia) e já agenda o
 * fechamento: o placar final sai sozinho, votem ou não.
 */
export async function createDecisionRound(
  tx: DbOrTx,
  input: z.input<typeof createSchema>,
): Promise<{ roundId: string; token: string; url: string; closesAt: Date; displayName: string }> {
  const parsed = createSchema.parse(input);
  // Retry do turno: a rodada deste pedido já existe — devolve a mesma, antes de qualquer validação.
  const [existing] = await tx
    .select({ id: friendRounds.id, token: friendRounds.token, closesAt: friendRounds.closesAt, displayName: friendRounds.displayName })
    .from(friendRounds)
    .where(eq(friendRounds.createKey, parsed.createKey))
    .limit(1);
  if (existing) {
    return { roundId: existing.id, token: existing.token, url: roundPublicUrl(existing.token), closesAt: existing.closesAt, displayName: existing.displayName };
  }

  const displayName = normalizeDisplayName(parsed.displayName);
  if (!displayName) throw new FriendRoundError("nome_invalido", "Diga o primeiro nome que as amigas vão ver.");
  const distinct = new Set(parsed.options.map((option) => `${option.productId}:${option.detail ?? ""}`));
  if (distinct.size !== parsed.options.length) throw new FriendRoundError("opcoes_repetidas", "As opções precisam ser diferentes.");

  const token = tokenFor(parsed.createKey);
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
  return { roundId: round.id, token, url: roundPublicUrl(token), closesAt, displayName };
}

/**
 * SAIR da cliente: as rodadas dela param sem mandar mais nada — inclusive a
 * que já fechou de noite e está com o resultado esperando a manhã.
 */
export async function cancelFriendRoundsForConversation(tx: DbOrTx, input: { conversationId: string; now: Date }): Promise<number> {
  const canceled = await tx
    .update(friendRounds)
    .set({ canceledAt: input.now, closedAt: sql`coalesce(${friendRounds.closedAt}, ${input.now.toISOString()}::timestamptz)` })
    .where(and(eq(friendRounds.conversationId, input.conversationId), isNull(friendRounds.canceledAt)))
    .returning({ id: friendRounds.id });
  return canceled.length;
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
  closesLabel: string;
  tally: RoundTally;
};

function safeImageUrl(path: string | null): string | null {
  if (!path) return null;
  try {
    // A média (800 px): a grade mostra ~100–240 px; a cheia (1600 px) pesava três vezes.
    return publicMdUrl(path);
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
    .select({
      id: friendAnswers.id,
      choice: friendAnswers.choice,
      note: friendAnswers.note,
      nickname: friendAnswers.nickname,
      forwardedAt: friendAnswers.forwardedAt,
      createdAt: friendAnswers.createdAt,
    })
    .from(friendAnswers)
    .where(eq(friendAnswers.roundId, roundId))
    .orderBy(desc(friendAnswers.createdAt));
}

/** Rodada que já passou da limpeza (30 dias depois do fim): a página não existe mais. */
function isPurged(round: { closedAt: Date | null }, now: Date): boolean {
  return round.closedAt !== null && now.getTime() - round.closedAt.getTime() > ANSWER_RETENTION_MS;
}

export async function getPublicRound(db: DbOrTx, token: string, now: Date = new Date()): Promise<PublicRound | null> {
  const round = await loadRoundByToken(db, token);
  if (!round || isPurged(round, now)) return null;
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
    open: isRoundOpen(round, now) && round.canceledAt === null,
    closesAt: round.closesAt,
    closesLabel: closesLabel(round.closesAt, now),
    tally: tallyRound(round.options.length, answers),
  };
}

// ---------------------------------------------------------------------------
// O voto e o recado
// ---------------------------------------------------------------------------

const voteSchema = z.object({
  token: z.string().min(8).max(40),
  choice: z.number().int().min(0).max(DECISION_MAX_OPTIONS - 1),
  /** Identificador aleatório do aparelho (guardado no navegador dela); só o hash vai para o banco. */
  voterId: z.uuid(),
  now: z.date(),
});

export type VoteResult =
  | { ok: true; tally: RoundTally }
  /** ja_votou traz a escolha que ficou gravada (o aparelho mostra a verdadeira). */
  | { ok: false; reason: "ja_votou"; choice: number; tally: RoundTally }
  | { ok: false; reason: "inexistente" | "fechada" | "opcao_invalida" | "cheia"; tally?: RoundTally };

function voterKeyFor(roundId: string, voterId: string): string {
  return createHash("sha256").update(`${roundId}:${voterId}`).digest("hex");
}

export async function voteInRound(db: DbOrTx, input: z.input<typeof voteSchema>): Promise<VoteResult> {
  const parsed = voteSchema.parse(input);
  const round = await loadRoundByToken(db, parsed.token);
  if (!round || isPurged(round, parsed.now)) return { ok: false, reason: "inexistente" };
  const current = await loadAnswers(db, round.id);
  const tallyNow = tallyRound(round.options.length, current);
  const voterKey = voterKeyFor(round.id, parsed.voterId);
  const previous = await existingChoice(db, round.id, voterKey);
  if (previous !== null) return { ok: false, reason: "ja_votou", choice: previous, tally: tallyNow };
  if (!isRoundOpen(round, parsed.now) || round.canceledAt !== null) return { ok: false, reason: "fechada", tally: tallyNow };
  if (parsed.choice >= round.options.length) return { ok: false, reason: "opcao_invalida" };
  if (current.length >= ROUND_MAX_VOTES) return { ok: false, reason: "cheia", tally: tallyNow };

  const inserted = await db.transaction(async (tx) => {
    const rows = await tx
      .insert(friendAnswers)
      .values({ roundId: round.id, voterKey, choice: parsed.choice, createdAt: parsed.now })
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
  if (inserted) return { ok: true, tally };
  // Dois toques quase juntos: o outro gravou primeiro.
  return { ok: false, reason: "ja_votou", choice: (await existingChoice(db, round.id, voterKey)) ?? parsed.choice, tally };
}

async function existingChoice(db: DbOrTx, roundId: string, voterKey: string): Promise<number | null> {
  const [row] = await db
    .select({ choice: friendAnswers.choice })
    .from(friendAnswers)
    .where(and(eq(friendAnswers.roundId, roundId), eq(friendAnswers.voterKey, voterKey)))
    .limit(1);
  return row?.choice ?? null;
}

const noteSchema = z.object({
  token: z.string().min(8).max(40),
  voterId: z.uuid(),
  note: z.string().max(500),
  nickname: z.string().max(100).nullish(),
  now: z.date(),
});

export type NoteResult = { ok: true } | { ok: false; reason: "inexistente" | "fechada" | "vazio" | "sem_voto" | "ja_deixou" };

/**
 * Depois do voto, o recado (opcional) — vai para a cliente pelo WhatsApp da
 * loja no próximo placar. Um por voto; só enquanto a rodada está aberta.
 */
export async function addNoteToVote(db: DbOrTx, input: z.input<typeof noteSchema>): Promise<NoteResult> {
  const parsed = noteSchema.parse(input);
  const round = await loadRoundByToken(db, parsed.token);
  if (!round || isPurged(round, parsed.now)) return { ok: false, reason: "inexistente" };
  if (!isRoundOpen(round, parsed.now) || round.canceledAt !== null) return { ok: false, reason: "fechada" };
  const note = normalizeNote(parsed.note);
  if (!note) return { ok: false, reason: "vazio" };
  const voterKey = voterKeyFor(round.id, parsed.voterId);
  const updated = await db
    .update(friendAnswers)
    .set({ note, nickname: normalizeNickname(parsed.nickname) })
    .where(and(eq(friendAnswers.roundId, round.id), eq(friendAnswers.voterKey, voterKey), isNull(friendAnswers.note)))
    .returning({ id: friendAnswers.id });
  if (updated.length > 0) return { ok: true };
  return { ok: false, reason: (await existingChoice(db, round.id, voterKey)) === null ? "sem_voto" : "ja_deixou" };
}

/** "Quero ver peças no meu estilo" abre o WhatsApp DELA com a Lia. */
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

/** Os recados ainda não repassados (os mais recentes primeiro). */
function pendingNotes(answers: Awaited<ReturnType<typeof loadAnswers>>, limit: number) {
  return answers.filter((answer) => answer.note && !answer.forwardedAt).slice(0, limit);
}

async function markForwarded(db: DbOrTx, ids: string[], now: Date): Promise<void> {
  if (ids.length === 0) return;
  await db.update(friendAnswers).set({ forwardedAt: now }).where(inArray(friendAnswers.id, ids));
}

function notesVar(labels: RoundOptionLabel[], notes: ReturnType<typeof pendingNotes>): string {
  return notesBlock(
    labels,
    notes.map((answer) => ({ nickname: answer.nickname, note: answer.note as string, choice: answer.choice })),
    notes.length,
  );
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
  if (row.round.canceledAt !== null) return { skipped: "cancelada" };
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
  const notes = pendingNotes(answers, NOTES_PER_MESSAGE);
  const result = await sendTemplateMessage(db, provider, {
    templateKey: FRIENDS_SUMMARY_TEMPLATE,
    phoneE164: row.phoneE164,
    vars: {
      placar: scoreboardLine(labels, tally),
      recados: notesVar(labels, notes),
      fecha: closesLabel(row.round.closesAt, now),
      link: roundPublicUrl(row.round.token),
    },
    ...(row.customerId ? { customerId: row.customerId } : {}),
    dedupeKey: `wa.friends_summary:${roundId}`,
    // Ela mesma pediu o placar: é a resposta ao pedido dela, não novidade.
    requireOptIn: false,
  });
  if (!("sent" in result)) return { skipped: result.skipped };
  await markForwarded(db, notes.map((answer) => answer.id), now);
  return { sent: true };
}

/** Fim das 24 h: fecha, manda o resultado (com os recados que ainda não foram) e agenda a limpeza. */
export async function closeFriendRound(
  db: DbOrTx,
  provider: MessagingProvider,
  input: z.input<typeof friendRoundPayloadSchema> & { now?: Date },
): Promise<FriendRoundNoticeResult> {
  const { roundId } = friendRoundPayloadSchema.parse(input);
  const now = input.now ?? new Date();
  const row = await loadRoundForNotice(db, roundId);
  if (!row) return { skipped: "inexistente" };

  await db.transaction(async (tx) => {
    // Fecha (se ainda aberta) e agenda a limpeza uma vez só — vale também
    // para a rodada cancelada pelo SAIR, que já nasceu fechada.
    if (row.round.closedAt === null) {
      await tx.update(friendRounds).set({ closedAt: now }).where(and(eq(friendRounds.id, roundId), isNull(friendRounds.closedAt)));
    }
    await enqueueOutboxEvent(tx, {
      eventType: FRIENDS_PURGE_EVENT,
      dedupeKey: `friends.purge:${roundId}`,
      aggregateType: "friend_round",
      aggregateId: roundId,
      payload: { roundId },
      nextAttemptAt: new Date((row.round.closedAt ?? now).getTime() + ANSWER_RETENTION_MS),
    });
  });
  // Ela mandou SAIR: a rodada fecha e some no prazo, sem mensagem.
  if (row.round.canceledAt !== null) return { skipped: "cancelada" };

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
  const notes = pendingNotes(answers, NOTES_IN_CLOSING);
  const result = await sendTemplateMessage(db, provider, {
    templateKey: FRIENDS_CLOSED_TEMPLATE,
    phoneE164: row.phoneE164,
    vars: {
      placar: tally.total > 0 ? `\n${scoreboardLine(labels, tally)}` : "",
      recados: notesVar(labels, notes),
      fecho: closingLine(labels, tally),
    },
    ...(row.customerId ? { customerId: row.customerId } : {}),
    dedupeKey: `wa.friends_closed:${roundId}`,
    requireOptIn: false,
  });
  if (!("sent" in result)) return { skipped: result.skipped };
  await markForwarded(db, notes.map((answer) => answer.id), now);
  return { sent: true };
}

/** 30 dias depois do fim: votos e recados somem, e o nome dela sai da rodada. */
export async function purgeFriendRound(db: DbOrTx, input: z.input<typeof friendRoundPayloadSchema>): Promise<{ deleted: number }> {
  const { roundId } = friendRoundPayloadSchema.parse(input);
  const deleted = await db.delete(friendAnswers).where(eq(friendAnswers.roundId, roundId)).returning({ id: friendAnswers.id });
  await db.update(friendRounds).set({ displayName: PURGED_NAME }).where(eq(friendRounds.id, roundId));
  return { deleted: deleted.length };
}

/**
 * O caderninho da Lia: as rodadas desta conversa dos últimos 3 dias — a
 * vencedora com o slug, para o "sim" dela virar reserva sem redescobrir a peça.
 */
export async function friendRoundMemoryLines(db: DbOrTx, input: { conversationId: string; now: Date }): Promise<string[]> {
  const since = new Date(input.now.getTime() - 3 * 24 * 60 * 60 * 1000);
  const rounds = await db
    .select()
    .from(friendRounds)
    .where(
      and(
        eq(friendRounds.conversationId, input.conversationId),
        isNull(friendRounds.canceledAt),
        sql`${friendRounds.createdAt} >= ${since.toISOString()}::timestamptz`,
      ),
    )
    .orderBy(desc(friendRounds.createdAt), asc(friendRounds.id))
    .limit(2);
  const lines: string[] = [];
  for (const round of rounds) {
    const labels = labelsOf(round);
    const tally = tallyRound(labels.length, await loadAnswers(db, round.id));
    const options = round.options.map((option, index) => `${labels[index].letter} = ${labels[index].name} (${option.slug})`).join("; ");
    if (isRoundOpen(round, input.now)) {
      lines.push(
        `Votação das amigas aberta até ${closesLabel(round.closesAt, input.now)} (link: ${roundPublicUrl(round.token)}): ${options}. Placar: ${tally.total > 0 ? scoreboardLine(labels, tally) : "nenhum voto ainda"}. Se ela pedir o link de novo, é este — não abra outra votação.`,
      );
      continue;
    }
    if (tally.leader !== null) {
      const winner = labels[tally.leader];
      lines.push(
        `Votação das amigas encerrada: ganhou ${winner.letter} = ${winner.name} (${round.options[tally.leader].slug}). Se ela disser sim, detalhar_produto e reservar_peca no tamanho dela.`,
      );
    } else {
      lines.push(`Votação das amigas encerrada sem vencedora (${tally.total > 0 ? "empate" : "sem votos"}): ${options}.`);
    }
  }
  return lines;
}
