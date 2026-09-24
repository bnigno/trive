// Entrevista da curadora: a Lia faz UMA pergunta por dia sobre UMA peça no
// WhatsApp da dona; a resposta (um ou mais áudios, ou texto começando com
// "resposta:") vira um rascunho de nota + duas legendas, e só entra na peça
// com o "ok" dela. É o caminho mais curto para a voz da dona chegar à Lia e
// aos posts: ninguém senta para escrever descrição, mas responder a uma
// pergunta por áudio leva 20 segundos.
//
// Fluxo: cron de hora em hora → curator.interview_ask (pergunta com a foto)
// → a resposta cai no webhook (routeInterviewReply): áudio entra na lista de
// pendentes e vai transcrever; cada parte ouvida soma à fala → rascunho pela
// fila (curator.interview_draft, só quando não há áudio pendente) → "ok",
// "ok voz", "corrige:", "nova:" ou "pula" → curator.interview_decide. Uma
// entrevista aberta por vez (índice parcial).
import { randomUUID } from "node:crypto";

import { and, asc, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";

import type { SalesAssistant } from "@/adapters/assistant";
import type { FileStorage } from "@/adapters/storage";
import { isTranscriptionConfigured } from "@/adapters/transcription";
import { getRetryPolicy } from "@/core/queue/retry-policy";
import type { MessagingProvider } from "@/adapters/zapi";
import { DEFAULT_SELLER_NAME } from "@/core/bot/prompt";
import {
  buildInterviewDraftPrompt,
  classifyInterviewReply,
  effectiveInterviewStatus,
  fallbackInterviewDraft,
  interviewCadence,
  interviewSourcesFor,
  INTERVIEW_DRAFT_JSON_SCHEMA,
  isInterviewOpen,
  isInterviewStatus,
  normalizeInterviewDraft,
  normalizeInterviewHour,
  OPEN_INTERVIEW_STATUSES,
  pickInterviewTarget,
  shouldAskNow,
  stripPriceSentences,
  voiceSourceFor,
  type InterviewClock,
  type InterviewDraft,
  type InterviewStatus,
} from "@/core/atelier/interview";
import {
  CURATOR_AUDIO_MAX_BYTES,
  CURATOR_AUDIO_MAX_SECONDS,
  curatorAudioFormat,
  curatorAudioStoragePath,
  fitCuratorNote,
} from "@/core/catalog/curator-note";
import { INBOUND_MEDIA_MARKERS, parseWaMediaMeta } from "@/core/whatsapp/media";
import { auditLog, cityEditionProducts, curatorInterviews, productImages, products, waMessages, waTemplates } from "@/db/schema";
import { isValidE164, toE164BR } from "@/lib/phone";
import { spDayKey, spMinutesOfDay, weekdayIndexSP } from "@/lib/sp-day";
import { enqueueOutboxEvent, type DbOrTx } from "@/queue/enqueue";
import { hasOpenAtelierBatch } from "@/services/atelier";
import { listPublicCityEditions } from "@/services/city-editions";
import { applyInterviewCuratorNote, removeReplacedCuratorAudio } from "@/services/curator-notes";
import { getSettingsMap, updateSetting, type ServiceDb } from "@/services/settings";
import { publicImageUrl } from "@/services/store-catalog";
import { isWaEnabled, sendToOwner, type SendWaMessageResult } from "@/services/wa-messaging";

export const INTERVIEW_TEMPLATES = {
  ask: "owner_interview_ask",
  draft: "owner_interview_draft",
  saved: "owner_interview_saved",
  skipped: "owner_interview_skipped",
  unheard: "owner_interview_unheard",
  rejected: "owner_interview_rejected",
} as const;

const DEFAULT_DRAFT_MODEL = "claude-sonnet-5";
/** A dona espera o rascunho no WhatsApp: a inteligência tem 25 s; depois, a própria fala vira a nota. */
const DRAFT_MODEL_TIMEOUT_MS = 25_000;
/** O raciocínio do modelo conta no mesmo teto: 800 cortava o JSON. */
const DRAFT_MAX_TOKENS = 3_000;
/** Ela costuma mandar dois ou três áudios seguidos: o rascunho espera um pouco antes de sair. */
const DRAFT_GATHER_MS = 20_000;

// ---------------------------------------------------------------------------
// Configuração e prontidão
// ---------------------------------------------------------------------------

export type InterviewSettings = { enabled: boolean; hour: number; weekends: boolean };

export async function loadInterviewSettings(db: DbOrTx): Promise<InterviewSettings> {
  const map = await getSettingsMap(db, ["curator_interview_enabled", "curator_interview_hour", "curator_interview_weekends"]);
  return {
    // Ausente = desligado: a entrevista escreve para a dona todo dia, só com o sim dela.
    enabled: map["curator_interview_enabled"] === true,
    hour: normalizeInterviewHour(map["curator_interview_hour"]),
    weekends: map["curator_interview_weekends"] === true,
  };
}

export type InterviewProblem = "sem_telefone_dono" | "whatsapp_desligado" | "sem_template" | "nada_a_perguntar" | "sem_transcricao";

/** Os que impedem a pergunta de sair; sem transcrição ela ainda pode responder escrevendo. */
const BLOCKING_PROBLEMS: ReadonlySet<InterviewProblem> = new Set(["sem_telefone_dono", "whatsapp_desligado", "sem_template", "nada_a_perguntar"]);

export const INTERVIEW_PROBLEM_TEXT: Record<InterviewProblem, string> = {
  sem_telefone_dono: "Falta o seu WhatsApp em Conexão (é para ele que a pergunta vai).",
  whatsapp_desligado: "O WhatsApp da loja está desligado.",
  sem_template: "Faltam as mensagens da entrevista (rode a sincronização das mensagens do sistema).",
  nada_a_perguntar: "Nenhuma peça ativa para perguntar agora (todas foram perguntadas nos últimos 14 dias).",
  sem_transcricao: "Sem a chave de transcrição de áudio na hospedagem: a dona só consegue responder escrevendo “resposta:”.",
};

async function missingTemplates(db: DbOrTx): Promise<boolean> {
  const keys = Object.values(INTERVIEW_TEMPLATES);
  const rows = await db
    .select({ key: waTemplates.key })
    .from(waTemplates)
    .where(and(inArray(waTemplates.key, keys), eq(waTemplates.isActive, true)));
  return rows.length < keys.length;
}

/** O que impede a pergunta de sair (o painel mostra; "Perguntar agora" recusa com o motivo). */
export async function interviewProblems(db: DbOrTx, now: Date = new Date()): Promise<InterviewProblem[]> {
  const problems: InterviewProblem[] = [];
  const map = await getSettingsMap(db, ["owner_whatsapp_phone"]);
  const raw = map["owner_whatsapp_phone"];
  const phone = typeof raw === "string" ? (toE164BR(raw) ?? raw.trim()) : "";
  if (!isValidE164(phone)) problems.push("sem_telefone_dono");
  if (!(await isWaEnabled(db))) problems.push("whatsapp_desligado");
  if (await missingTemplates(db)) problems.push("sem_template");
  if (!pickInterviewTarget(await loadCandidates(db, now), now)) problems.push("nada_a_perguntar");
  if (!isTranscriptionConfigured()) problems.push("sem_transcricao");
  return problems;
}

type InterviewRow = typeof curatorInterviews.$inferSelect;

function statusOf(row: { status: string }): InterviewStatus {
  return isInterviewStatus(row.status) ? row.status : "failed";
}

function clockOf(row: Pick<InterviewRow, "status" | "askedAt" | "draftSentAt" | "lastAnswerAt">): InterviewClock {
  return { status: statusOf(row), askedAt: row.askedAt, draftSentAt: row.draftSentAt, lastAnswerAt: row.lastAnswerAt };
}

async function findOpenInterview(db: DbOrTx): Promise<InterviewRow | null> {
  const [row] = await db
    .select()
    .from(curatorInterviews)
    .where(inArray(curatorInterviews.status, [...OPEN_INTERVIEW_STATUSES]))
    .orderBy(desc(curatorInterviews.askedAt))
    .limit(1);
  return row ?? null;
}

/**
 * Transição guardada: só muda se a entrevista está num estado de onde se
 * chega a `to` (core/atelier/interview). Devolve false quando outra
 * execução já moveu — o chamador trata como "já decidida".
 */
async function transitionInterview(
  db: DbOrTx,
  input: { id: string; to: InterviewStatus; from?: InterviewStatus[]; now: Date; patch?: Partial<typeof curatorInterviews.$inferInsert> },
): Promise<boolean> {
  const allowed = interviewSourcesFor(input.to);
  const sources = (input.from ?? allowed).filter((from) => allowed.includes(from));
  if (sources.length === 0) return false;
  const moved = await db
    .update(curatorInterviews)
    .set({ ...input.patch, status: input.to, updatedAt: input.now })
    .where(and(eq(curatorInterviews.id, input.id), inArray(curatorInterviews.status, sources)))
    .returning({ id: curatorInterviews.id });
  return moved.length > 0;
}

/** Entrevistas abertas que passaram do prazo viram "expired" (a pergunta seguinte pode sair). */
async function expireStaleInterviews(db: DbOrTx, now: Date): Promise<number> {
  const open = await db.select().from(curatorInterviews).where(inArray(curatorInterviews.status, [...OPEN_INTERVIEW_STATUSES]));
  let expired = 0;
  for (const row of open) {
    if (isInterviewOpen(clockOf(row), now)) continue;
    if (await transitionInterview(db, { id: row.id, to: "expired", now })) expired += 1;
  }
  return expired;
}

// ---------------------------------------------------------------------------
// A pergunta do dia
// ---------------------------------------------------------------------------

/** Cron de hora em hora: na hora escolhida, enfileira a pergunta do dia (dedupe por dia). */
export async function enqueueCuratorInterviewAsk(
  db: DbOrTx,
  now: Date = new Date(),
): Promise<{ enqueued: boolean; reason?: "desligado" | "fora_da_hora" }> {
  const settings = await loadInterviewSettings(db);
  if (!settings.enabled) return { enqueued: false, reason: "desligado" };
  const recent = await db.select().from(curatorInterviews).orderBy(desc(curatorInterviews.askedAt)).limit(10);
  const dayKey = spDayKey(now);
  const ask = shouldAskNow({
    enabled: settings.enabled,
    hour: settings.hour,
    weekends: settings.weekends,
    spHour: Math.floor(spMinutesOfDay(now) / 60),
    spWeekday: weekdayIndexSP(dayKey),
    // A aberta que já venceu conta como sem resposta (o recuo vem na 3ª, não na 4ª).
    cadence: interviewCadence(recent.map((row) => ({ status: effectiveInterviewStatus(clockOf(row), now) }))),
  });
  if (!ask) return { enqueued: false, reason: "fora_da_hora" };
  const id = await enqueueOutboxEvent(db, {
    eventType: "curator.interview_ask",
    dedupeKey: `curator.interview_ask:${dayKey}`,
    aggregateType: "curator_interview",
    payload: { askKey: dayKey },
  });
  return { enqueued: id !== null };
}

/** "Perguntar agora" no painel: fura a hora (não a regra de uma aberta por vez nem os pré-requisitos). */
export async function requestCuratorInterviewNow(
  db: DbOrTx,
  input: { userId: string; now?: Date },
): Promise<{ ok: true } | { ok: false; reason: "aberta" | InterviewProblem }> {
  const userId = z.uuid().parse(input.userId);
  const now = input.now ?? new Date();
  const open = await findOpenInterview(db);
  if (open && isInterviewOpen(clockOf(open), now)) return { ok: false, reason: "aberta" };
  const problem = (await interviewProblems(db, now)).find((item) => BLOCKING_PROBLEMS.has(item));
  if (problem) return { ok: false, reason: problem };
  const askKey = `agora:${randomUUID()}`;
  await db.transaction(async (tx) => {
    await enqueueOutboxEvent(tx, {
      eventType: "curator.interview_ask",
      dedupeKey: `curator.interview_ask:${askKey}`,
      aggregateType: "curator_interview",
      payload: { askKey },
    });
    await tx.insert(auditLog).values({
      actorType: "user",
      actorId: userId,
      action: "curator_interview.requested",
      entityType: "curator_interview",
      entityId: null,
      after: { askKey },
    });
  });
  return { ok: true };
}

async function loadCandidates(db: DbOrTx, now: Date) {
  const rows = await db
    .select({
      id: products.id,
      name: products.name,
      pieceType: products.pieceType,
      curatorNote: products.curatorNote,
      createdAt: products.createdAt,
    })
    .from(products)
    .where(and(eq(products.status, "active"), isNull(products.deletedAt)));
  if (rows.length === 0) return [];
  const editions = await listPublicCityEditions(db, { now });
  const editionProductIds = new Set<string>();
  if (editions.length > 0) {
    const links = await db
      .select({ productId: cityEditionProducts.productId })
      .from(cityEditionProducts)
      .where(inArray(cityEditionProducts.cityEditionId, editions.map((edition) => edition.id)));
    for (const link of links) editionProductIds.add(link.productId);
  }
  // Pergunta que não saiu (failed) não gasta a peça nem a pergunta.
  const history = await db
    .select({ productId: curatorInterviews.productId, questionKey: curatorInterviews.questionKey, askedAt: curatorInterviews.askedAt })
    .from(curatorInterviews)
    .where(ne(curatorInterviews.status, "failed"));
  const asked = new Map<string, { keys: string[]; last: Date }>();
  for (const row of history) {
    const entry = asked.get(row.productId) ?? { keys: [], last: row.askedAt };
    entry.keys.push(row.questionKey);
    if (row.askedAt > entry.last) entry.last = row.askedAt;
    asked.set(row.productId, entry);
  }
  return rows.map((row) => ({
    productId: row.id,
    name: row.name,
    pieceType: row.pieceType,
    hasNote: (row.curatorNote ?? "").trim() !== "",
    inActiveEdition: editionProductIds.has(row.id),
    createdAt: row.createdAt,
    askedKeys: asked.get(row.id)?.keys ?? [],
    lastAskedAt: asked.get(row.id)?.last ?? null,
  }));
}

/** A foto real da peça (a primeira subida pela equipe; a de IA só se não houver outra). */
async function productPhotoUrl(db: DbOrTx, productId: string): Promise<string | null> {
  const [image] = await db
    .select({ storagePath: productImages.storagePath })
    .from(productImages)
    .where(eq(productImages.productId, productId))
    .orderBy(desc(eq(productImages.origin, "upload")), asc(productImages.sortOrder), asc(productImages.createdAt))
    .limit(1);
  if (!image) return null;
  try {
    return publicImageUrl(image.storagePath);
  } catch {
    // Sem a URL pública do Storage configurada, a pergunta vai só em texto.
    return null;
  }
}

export const interviewAskPayloadSchema = z.object({
  askKey: z.string().min(1).max(80),
  /** Tentativas já esgotadas antes desta (como o worker conta): na última, envio que lança fecha a entrevista. */
  attempt: z.number().int().min(0).default(0),
});

function isLastAttempt(eventType: string, attempt: number): boolean {
  return attempt + 1 >= getRetryPolicy(eventType).maxAttempts;
}

type SendSkip = Extract<SendWaMessageResult, { skipped: unknown }>["skipped"];

export type AskCuratorInterviewResult =
  | { asked: true; interviewId: string; productId: string }
  | { skipped: "desligado" | "ja_processada" | "aberta" | "nada_a_perguntar" | "sem_template" | SendSkip };

async function sendQuestion(db: DbOrTx, provider: MessagingProvider, row: { id: string; productId: string; question: string }): Promise<SendWaMessageResult> {
  const [product] = await db.select({ name: products.name }).from(products).where(eq(products.id, row.productId)).limit(1);
  const photo = await productPhotoUrl(db, row.productId);
  return sendToOwner(db, provider, {
    templateKey: INTERVIEW_TEMPLATES.ask,
    vars: { peca: product?.name ?? "a peça", pergunta: row.question },
    dedupeKey: `curator.interview_ask:${row.id}`,
    ...(photo ? { image: { url: photo } } : {}),
  });
}

/**
 * Manda a pergunta; se ela não sai (sem telefone, WhatsApp desligado, ou a
 * Z-API caiu até a última tentativa), a entrevista fecha como "não saiu" —
 * aberta, ela capturaria os áudios da dona para uma pergunta que ela não viu.
 */
async function sendQuestionOrClose(
  db: DbOrTx,
  provider: MessagingProvider,
  row: { id: string; productId: string; question: string },
  input: { lastAttempt: boolean; now: Date },
): Promise<SendWaMessageResult> {
  let sent: SendWaMessageResult;
  try {
    sent = await sendQuestion(db, provider, row);
  } catch (error) {
    if (input.lastAttempt) await transitionInterview(db, { id: row.id, to: "failed", now: input.now });
    throw error;
  }
  // "ja_enviado" é a reentrega do mesmo evento: a pergunta está com ela.
  if ("skipped" in sent && sent.skipped !== "ja_enviado") await transitionInterview(db, { id: row.id, to: "failed", now: input.now });
  return sent;
}

/** Handler da fila: escolhe a peça, grava a entrevista e manda a pergunta com a foto. */
export async function askCuratorInterview(
  db: DbOrTx,
  provider: MessagingProvider,
  input: z.input<typeof interviewAskPayloadSchema>,
  clock: { now?: () => Date } = {},
): Promise<AskCuratorInterviewResult> {
  const { askKey, attempt } = interviewAskPayloadSchema.parse(input);
  const now = (clock.now ?? (() => new Date()))();
  const manual = askKey.startsWith("agora:");
  if (!manual && !(await loadInterviewSettings(db)).enabled) return { skipped: "desligado" };

  // Reentrega do mesmo evento: a pergunta já existe — só reenvia (o dedupe
  // do WhatsApp segura a duplicata) se ainda estiver esperando resposta.
  const [existing] = await db.select().from(curatorInterviews).where(eq(curatorInterviews.askKey, askKey)).limit(1);
  if (existing) {
    if (existing.status !== "asked") return { skipped: "ja_processada" };
    const sent = await sendQuestionOrClose(db, provider, existing, { lastAttempt: isLastAttempt("curator.interview_ask", attempt), now });
    if ("skipped" in sent && sent.skipped !== "ja_enviado") return { skipped: sent.skipped };
    return { asked: true, interviewId: existing.id, productId: existing.productId };
  }

  // Sem as mensagens da entrevista, nada de gastar a pergunta de uma peça.
  if (await missingTemplates(db)) return { skipped: "sem_template" };

  await expireStaleInterviews(db, now);
  if (await findOpenInterview(db)) return { skipped: "aberta" };

  const target = pickInterviewTarget(await loadCandidates(db, now), now);
  if (!target) return { skipped: "nada_a_perguntar" };

  const [row] = await db
    .insert(curatorInterviews)
    .values({ askKey, productId: target.productId, questionKey: target.questionKey, question: target.question, status: "asked", askedAt: now })
    .onConflictDoNothing()
    .returning();
  if (!row) return { skipped: "aberta" };

  const sent = await sendQuestionOrClose(db, provider, row, { lastAttempt: isLastAttempt("curator.interview_ask", attempt), now });
  if ("skipped" in sent) return { skipped: sent.skipped };
  return { asked: true, interviewId: row.id, productId: row.productId };
}

// ---------------------------------------------------------------------------
// A resposta da dona (dentro da transação do webhook)
// ---------------------------------------------------------------------------

export type InterviewRoute =
  /** Áudio: entrou na lista de pendentes e vai transcrever; volta por receiveInterviewTranscript. */
  | { kind: "transcribe"; interviewId: string }
  /** Texto de resposta, aprovação, correção ou "pula": já está na fila. */
  | { kind: "queued"; interviewId: string };

/** Soma uma parte ouvida/escrita à fala e agenda o rascunho (que espera os áudios pendentes). */
async function addAnswerPart(
  tx: DbOrTx,
  input: { interviewId: string; text: string; audioId: string | null; now: Date },
): Promise<boolean> {
  const [updated] = await tx
    .update(curatorInterviews)
    .set({
      status: "drafting",
      transcript: sql`case when ${curatorInterviews.transcript} is null or ${curatorInterviews.transcript} = '' then ${input.text} else ${curatorInterviews.transcript} || E'\\n' || ${input.text} end`,
      answerCount: sql`${curatorInterviews.answerCount} + 1`,
      lastAnswerAt: input.now,
      updatedAt: input.now,
      ...(input.audioId
        ? {
            answerAudioIds: sql`${curatorInterviews.answerAudioIds} || ${JSON.stringify([input.audioId])}::jsonb`,
            pendingAnswerIds: sql`${curatorInterviews.pendingAnswerIds} - ${input.audioId}::text`,
          }
        : { textAnswers: sql`${curatorInterviews.textAnswers} + 1` }),
    })
    .where(and(eq(curatorInterviews.id, input.interviewId), inArray(curatorInterviews.status, interviewSourcesFor("drafting"))))
    .returning({ answerCount: curatorInterviews.answerCount, pending: curatorInterviews.pendingAnswerIds });
  if (!updated) return false;
  await enqueueDraft(tx, { interviewId: input.interviewId, answerCount: updated.answerCount, now: input.now });
  return true;
}

async function enqueueDraft(tx: DbOrTx, input: { interviewId: string; answerCount: number; now: Date; after?: string }): Promise<void> {
  await enqueueOutboxEvent(tx, {
    eventType: "curator.interview_draft",
    // "after": o áudio que não deu para ouvir destravou um rascunho cuja vez já passou
    // (o evento da mesma contagem rodou e esperou por ele) — chave nova, senão o dedupe o engole.
    dedupeKey: `curator.interview_draft:${input.interviewId}:${input.answerCount}${input.after ? `:sem:${input.after}` : ""}`,
    aggregateType: "curator_interview",
    aggregateId: input.interviewId,
    payload: { interviewId: input.interviewId, answerCount: input.answerCount },
    nextAttemptAt: new Date(input.now.getTime() + DRAFT_GATHER_MS),
  });
}

async function enqueueDecision(
  tx: DbOrTx,
  input: { interviewId: string; decision: z.infer<typeof interviewDecidePayloadSchema>["decision"]; messageKey: string; text?: string },
): Promise<void> {
  await enqueueOutboxEvent(tx, {
    eventType: "curator.interview_decide",
    dedupeKey: `curator.interview_decide:${input.messageKey}`,
    aggregateType: "curator_interview",
    aggregateId: input.interviewId,
    payload: { interviewId: input.interviewId, decision: input.decision, messageKey: input.messageKey, ...(input.text ? { text: input.text } : {}) },
  });
}

/**
 * A mensagem da dona é para a entrevista aberta? Lote de fotos do Ateliê
 * aberto ganha (as fotos são de peça nova); fora do prazo, nada muda — e
 * texto solto dela continua indo à Lia. null = siga o fluxo de sempre.
 */
export async function routeInterviewReply(
  tx: DbOrTx,
  input: { phoneE164: string; kind: "audio" | "text" | "image" | "note"; body: string; waMessageId: string; mediaUrl: string | null; now: Date },
): Promise<InterviewRoute | null> {
  const interview = await findOpenInterview(tx);
  if (!interview) return null;
  const clock = clockOf(interview);
  if (!isInterviewOpen(clock, input.now)) return null;
  const reply = classifyInterviewReply({ status: clock.status, messageKind: input.kind, body: input.body, hasDraft: interview.draft !== null });
  if (!reply) return null;
  if (await hasOpenAtelierBatch(tx, input.phoneE164, input.now)) return null;

  if (reply.kind === "answer_audio") {
    if (!input.mediaUrl) return null;
    if (!isTranscriptionConfigured()) {
      await enqueueDecision(tx, { interviewId: interview.id, decision: "unheard", messageKey: input.waMessageId });
      return { kind: "queued", interviewId: interview.id };
    }
    const claimed = await tx
      .update(curatorInterviews)
      .set({
        pendingAnswerIds: sql`${curatorInterviews.pendingAnswerIds} || ${JSON.stringify([input.waMessageId])}::jsonb`,
        lastAnswerAt: input.now,
        updatedAt: input.now,
      })
      .where(and(eq(curatorInterviews.id, interview.id), inArray(curatorInterviews.status, [...OPEN_INTERVIEW_STATUSES])))
      .returning({ id: curatorInterviews.id });
    return claimed.length > 0 ? { kind: "transcribe", interviewId: interview.id } : null;
  }

  if (reply.kind === "answer_text") {
    const added = await addAnswerPart(tx, { interviewId: interview.id, text: reply.text, audioId: null, now: input.now });
    return added ? { kind: "queued", interviewId: interview.id } : null;
  }

  const decision =
    reply.kind === "approve" ? (reply.withVoice ? "approve_voice" : "approve") : reply.kind === "replace" ? "replace" : "skip";
  await enqueueDecision(tx, {
    interviewId: interview.id,
    decision,
    messageKey: input.waMessageId,
    ...(reply.kind === "replace" ? { text: reply.text } : {}),
  });
  return { kind: "queued", interviewId: interview.id };
}

/**
 * A transcrição do áudio voltou (wa-transcribe → routeInboundMessage): se o
 * áudio era parte da resposta, soma a fala e pede o rascunho; se não deu
 * para ouvir, avisa a dona. false = o áudio não era da entrevista.
 */
export async function receiveInterviewTranscript(
  tx: DbOrTx,
  input: { waMessageId: string; text: string; now: Date },
): Promise<boolean> {
  const [interview] = await tx
    .select({ id: curatorInterviews.id, status: curatorInterviews.status })
    .from(curatorInterviews)
    .where(sql`${curatorInterviews.pendingAnswerIds} @> ${JSON.stringify([input.waMessageId])}::jsonb`)
    .limit(1);
  if (!interview) return false;
  const release = () =>
    tx
      .update(curatorInterviews)
      .set({ pendingAnswerIds: sql`${curatorInterviews.pendingAnswerIds} - ${input.waMessageId}::text`, updatedAt: input.now })
      .where(eq(curatorInterviews.id, interview.id))
      .returning({ answerCount: curatorInterviews.answerCount, status: curatorInterviews.status });

  // A entrevista fechou ("ok", "pula") antes de a transcrição voltar: o áudio
  // sai da lista e segue o caminho de sempre (Ateliê ou Lia) — não some.
  if (!(OPEN_INTERVIEW_STATUSES as readonly string[]).includes(interview.status)) {
    await release();
    return false;
  }

  const unheard = input.text.startsWith(INBOUND_MEDIA_MARKERS.audio) || input.text.trim() === "";
  if (!unheard) {
    if (await addAnswerPart(tx, { interviewId: interview.id, text: input.text, audioId: input.waMessageId, now: input.now })) return true;
    await release();
    return false;
  }
  // Não deu para ouvir: sai da fila de pendentes (o rascunho do que já foi
  // ouvido não fica esperando por ele) e a dona recebe o aviso.
  const [left] = await release();
  await enqueueDecision(tx, { interviewId: interview.id, decision: "unheard", messageKey: input.waMessageId });
  if (left && left.status === "drafting" && left.answerCount > 0) {
    await enqueueDraft(tx, { interviewId: interview.id, answerCount: left.answerCount, now: input.now, after: input.waMessageId });
  }
  return true;
}

// ---------------------------------------------------------------------------
// O rascunho
// ---------------------------------------------------------------------------

export const interviewDraftPayloadSchema = z.object({
  interviewId: z.uuid(),
  answerCount: z.number().int().min(1),
  attempt: z.number().int().min(0).default(0),
});

export type DraftCuratorInterviewResult =
  | { sent: true; usedModel: boolean }
  | { skipped: "inexistente" | "ja_decidida" | "sem_fala" | "esperando_audio" | "superado" | SendSkip };

function draftVars(
  productName: string,
  draft: InterviewDraft & { model?: string | null },
  context: { replacesNote: boolean; voiceAvailable: boolean },
): Record<string, string> {
  const captions = draft.captions.length > 0 ? `\n\n*Legendas*\n${draft.captions.map((caption, index) => `${index + 1}. ${caption}`).join("\n")}` : "";
  const notices = [
    draft.model === null ? "(A inteligência não respondeu agora: esta é a sua fala como veio, sem preço.)" : null,
    context.replacesNote ? "(Esta nota substitui a que a peça tem hoje.)" : null,
    context.voiceAvailable ? null : "(Desta vez o *ok voz* guarda só o texto: a voz sai quando a resposta é um áudio só, sem correção.)",
  ].filter((line): line is string => line !== null);
  return { peca: productName, nota: draft.note, legendas: captions, aviso: notices.length > 0 ? `\n\n${notices.join("\n")}` : "" };
}

async function writeDraft(
  assistant: SalesAssistant,
  input: { system: string; transcript: string; model: string },
): Promise<{ draft: InterviewDraft; model: string | null } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DRAFT_MODEL_TIMEOUT_MS);
  try {
    const result = await assistant.extractFromPhotos({
      system: input.system,
      images: [],
      userText: `Resposta da dona (transcrita):\n${input.transcript}`,
      model: input.model,
      jsonSchema: INTERVIEW_DRAFT_JSON_SCHEMA as unknown as Record<string, unknown>,
      maxTokens: DRAFT_MAX_TOKENS,
      signal: controller.signal,
    });
    return { draft: normalizeInterviewDraft(result.json), model: input.model };
  } catch (error) {
    console.warn("[curator-interview] rascunho sem a inteligência:", error instanceof Error ? error.message : error);
    const fallback = fallbackInterviewDraft(input.transcript);
    return fallback ? { draft: fallback, model: null } : null;
  } finally {
    clearTimeout(timer);
  }
}

/** Handler da fila: a fala somada vira nota + legendas e o rascunho vai para a dona aprovar. */
export async function draftCuratorInterview(
  db: DbOrTx,
  provider: MessagingProvider,
  assistant: SalesAssistant,
  input: z.input<typeof interviewDraftPayloadSchema>,
  clock: { now?: () => Date } = {},
): Promise<DraftCuratorInterviewResult> {
  const { interviewId, answerCount, attempt } = interviewDraftPayloadSchema.parse(input);
  const now = (clock.now ?? (() => new Date()))();
  const [row] = await db
    .select({ interview: curatorInterviews, productName: products.name, productNote: products.curatorNote })
    .from(curatorInterviews)
    .innerJoin(products, eq(products.id, curatorInterviews.productId))
    .where(eq(curatorInterviews.id, interviewId))
    .limit(1);
  if (!row) return { skipped: "inexistente" };
  const { interview } = row;
  // Outra parte chegou depois deste pedido: o rascunho dela (com tudo) vem em outro evento.
  if (interview.answerCount !== answerCount) return { skipped: "superado" };
  const context = {
    replacesNote: (row.productNote ?? "").trim() !== "",
    voiceAvailable: "audioId" in voiceSourceFor({ audioIds: interview.answerAudioIds, textAnswers: interview.textAnswers }),
  };
  const dedupeKey = `curator.interview_draft:${interview.id}:${answerCount}`;

  // Reentrega depois de gravar: só reenvia o mesmo rascunho.
  if (interview.status === "draft_sent" && interview.draft) {
    const resent = await sendToOwner(db, provider, { templateKey: INTERVIEW_TEMPLATES.draft, vars: draftVars(row.productName, interview.draft, context), dedupeKey });
    return "skipped" in resent ? { skipped: resent.skipped } : { sent: true, usedModel: Boolean(interview.draft.model) };
  }
  if (interview.status !== "drafting") return { skipped: "ja_decidida" };
  // Ainda há áudio sendo transcrito: a volta dele pede o rascunho com tudo.
  if (interview.pendingAnswerIds.length > 0) return { skipped: "esperando_audio" };
  const transcript = (interview.transcript ?? "").trim();
  if (!transcript) return { skipped: "sem_fala" };

  const settings = await getSettingsMap(db, ["store_name", "bot_model"]);
  const storeName = typeof settings["store_name"] === "string" && settings["store_name"].trim() !== "" ? settings["store_name"].trim() : "TRIVÉ";
  const model = typeof settings["bot_model"] === "string" && settings["bot_model"].trim() !== "" ? settings["bot_model"].trim() : DEFAULT_DRAFT_MODEL;
  const written = await writeDraft(assistant, {
    system: buildInterviewDraftPrompt({ storeName, productName: row.productName, question: interview.question }),
    transcript,
    model,
  });
  if (!written) {
    // Nada aproveitável (a fala era só preço): ela respondeu e não pode ficar no silêncio.
    if (await transitionInterview(db, { id: interview.id, to: "failed", from: ["drafting"], now })) {
      await sendToOwner(db, provider, {
        templateKey: INTERVIEW_TEMPLATES.rejected,
        vars: { motivo: `não consegui montar a nota de ${row.productName}: a resposta falava só de preço, e a nota não leva preço. Na próxima pergunta, conte da peça.` },
        dedupeKey: `curator.interview_done:vazia:${interview.id}`,
      });
    }
    return { skipped: "sem_fala" };
  }

  const draft = { ...written.draft, model: written.model };
  const moved = await db
    .update(curatorInterviews)
    .set({ status: "draft_sent", draft, draftSentAt: now, updatedAt: now })
    .where(and(eq(curatorInterviews.id, interview.id), eq(curatorInterviews.status, "drafting"), eq(curatorInterviews.answerCount, answerCount)))
    .returning({ id: curatorInterviews.id });
  if (moved.length === 0) return { skipped: "superado" };
  let sent: SendWaMessageResult;
  try {
    sent = await sendToOwner(db, provider, { templateKey: INTERVIEW_TEMPLATES.draft, vars: draftVars(row.productName, draft, context), dedupeKey });
  } catch (error) {
    // Z-API fora até a última tentativa: o rascunho não chegou a ela — não pode ficar esperando um "ok".
    if (isLastAttempt("curator.interview_draft", attempt)) await transitionInterview(db, { id: interview.id, to: "failed", from: ["draft_sent"], now });
    throw error;
  }
  if ("skipped" in sent && sent.skipped !== "ja_enviado") {
    // O rascunho não chegou a ela: não pode ficar 24 h esperando um "ok" sobre um texto que ela não viu.
    await transitionInterview(db, { id: interview.id, to: "failed", from: ["draft_sent"], now });
    return { skipped: sent.skipped };
  }
  return { sent: true, usedModel: written.model !== null };
}

// ---------------------------------------------------------------------------
// A decisão: "ok", "ok voz", "nova: …", "pula" (e o áudio que não deu para ouvir)
// ---------------------------------------------------------------------------

export const interviewDecidePayloadSchema = z.object({
  interviewId: z.uuid(),
  decision: z.enum(["approve", "approve_voice", "replace", "skip", "unheard"]),
  messageKey: z.string().min(1),
  text: z.string().max(4000).optional(),
});

type VoiceOutcome = "salva" | "longo" | "escrito" | "varios" | "misto" | "falhou";

export type DecideCuratorInterviewResult =
  | { done: "aprovada" | "nova" | "pulada" | "avisada"; voice?: VoiceOutcome }
  | { skipped: "inexistente" | "ja_decidida" | "nota_invalida" };

async function sellerNameOf(db: DbOrTx): Promise<string> {
  const map = await getSettingsMap(db, ["bot_seller_name"]);
  const name = typeof map["bot_seller_name"] === "string" ? map["bot_seller_name"].trim() : "";
  return name || DEFAULT_SELLER_NAME;
}

async function notify(db: DbOrTx, provider: MessagingProvider, input: { templateKey: string; vars: Record<string, string>; messageKey: string }): Promise<void> {
  await sendToOwner(db, provider, { templateKey: input.templateKey, vars: input.vars, dedupeKey: `curator.interview_done:${input.messageKey}` });
}

/** O áudio da resposta vira a voz da curadora: baixa da Z-API e guarda no bucket. */
async function storeAnswerAudio(
  db: DbOrTx,
  provider: MessagingProvider,
  storage: FileStorage,
  input: { productId: string; audioId: string },
): Promise<{ audio: { path: string; mime: string; seconds: number | null } } | { voice: "longo" | "falhou" }> {
  const [message] = await db
    .select({ kind: waMessages.kind, mediaUrl: waMessages.mediaUrl, mediaMeta: waMessages.mediaMeta })
    .from(waMessages)
    .where(eq(waMessages.id, input.audioId))
    .limit(1);
  if (!message || message.kind !== "audio" || !message.mediaUrl) return { voice: "falhou" };
  const meta = parseWaMediaMeta(message.mediaMeta);
  if (meta.seconds !== undefined && meta.seconds > CURATOR_AUDIO_MAX_SECONDS) return { voice: "longo" };
  const format = curatorAudioFormat(meta.mimeType ?? "audio/ogg") ?? curatorAudioFormat("audio/ogg");
  if (!format) return { voice: "falhou" };
  try {
    const media = await provider.downloadMedia({ url: message.mediaUrl, maxBytes: CURATOR_AUDIO_MAX_BYTES });
    const path = curatorAudioStoragePath(input.productId, randomUUID(), format.extension);
    await storage.upload({ path, data: media.data, contentType: format.mime });
    return { audio: { path, mime: format.mime, seconds: meta.seconds !== undefined ? Math.round(meta.seconds) : null } };
  } catch (error) {
    console.warn("[curator-interview] áudio da resposta não guardado:", error instanceof Error ? error.message : error);
    return { voice: "falhou" };
  }
}

const VOICE_LINE: Record<VoiceOutcome, string> = {
  salva: " O seu áudio virou a voz da curadora: ele toca na página da peça e a vendedora manda às clientes.",
  longo: " O áudio passou de 1 minuto, então guardei só o texto.",
  escrito: " A resposta foi escrita, então guardei só o texto.",
  varios: " A resposta veio em mais de um áudio, então guardei só o texto (a voz sai quando a resposta é um áudio só).",
  misto: " A resposta teve uma parte escrita ou uma correção, então guardei só o texto: o áudio não diz tudo o que está na nota.",
  falhou: " Não consegui guardar o áudio agora, então guardei só o texto.",
};

/** Handler da fila: aplica o que a dona decidiu e confirma para ela. */
export async function decideCuratorInterview(
  db: DbOrTx,
  provider: MessagingProvider,
  storage: FileStorage,
  input: z.input<typeof interviewDecidePayloadSchema>,
  clock: { now?: () => Date } = {},
): Promise<DecideCuratorInterviewResult> {
  const parsed = interviewDecidePayloadSchema.parse(input);
  const now = (clock.now ?? (() => new Date()))();
  const [row] = await db
    .select({ interview: curatorInterviews, productName: products.name, productAudio: products.curatorAudioPath })
    .from(curatorInterviews)
    .innerJoin(products, eq(products.id, curatorInterviews.productId))
    .where(eq(curatorInterviews.id, parsed.interviewId))
    .limit(1);
  if (!row) return { skipped: "inexistente" };
  const { interview, productName } = row;
  const seller = await sellerNameOf(db);

  if (parsed.decision === "unheard") {
    await notify(db, provider, { templateKey: INTERVIEW_TEMPLATES.unheard, vars: {}, messageKey: parsed.messageKey });
    return { done: "avisada" };
  }

  // Retry depois de decidir: a confirmação que falhou sai de novo (o dedupe segura a duplicata).
  if (interview.decidedByMessage === parsed.messageKey) {
    if (interview.status === "skipped") {
      await notify(db, provider, { templateKey: INTERVIEW_TEMPLATES.skipped, vars: { peca: productName }, messageKey: parsed.messageKey });
      return { done: "pulada" };
    }
    if (interview.status === "approved") {
      await notify(db, provider, {
        templateKey: INTERVIEW_TEMPLATES.saved,
        vars: { peca: productName, vendedora: seller, voz: interview.decisionNote ?? "" },
        messageKey: parsed.messageKey,
      });
      return { done: "aprovada" };
    }
  }

  if (parsed.decision === "skip") {
    const moved = await transitionInterview(db, {
      id: interview.id,
      to: "skipped",
      from: [...OPEN_INTERVIEW_STATUSES],
      now,
      patch: { decidedAt: now, decidedByMessage: parsed.messageKey },
    });
    if (!moved) return { skipped: "ja_decidida" };
    await notify(db, provider, { templateKey: INTERVIEW_TEMPLATES.skipped, vars: { peca: productName }, messageKey: parsed.messageKey });
    return { done: "pulada" };
  }

  // O rascunho na mão dela: enviado, ou sendo reescrito com um áudio novo (ela aprova o que viu).
  if ((interview.status !== "draft_sent" && interview.status !== "drafting") || !interview.draft) return { skipped: "ja_decidida" };

  let note = interview.draft.note;
  if (parsed.decision === "replace") {
    const fitted = fitCuratorNote(stripPriceSentences(parsed.text ?? ""));
    if (!fitted.text || fitted.truncated) {
      await notify(db, provider, {
        templateKey: INTERVIEW_TEMPLATES.rejected,
        vars: { motivo: "a nota precisa ter texto e caber em 1000 caracteres. Mande *nova:* de novo, mais curtinha." },
        messageKey: parsed.messageKey,
      });
      return { skipped: "nota_invalida" };
    }
    note = fitted.text;
  }

  let voice: VoiceOutcome | undefined;
  let audio: { path: string; mime: string; seconds: number | null } | null = null;
  if (parsed.decision === "approve_voice") {
    const source = voiceSourceFor({ audioIds: interview.answerAudioIds, textAnswers: interview.textAnswers });
    if ("audioId" in source) {
      const stored = await storeAnswerAudio(db, provider, storage, { productId: interview.productId, audioId: source.audioId });
      if ("audio" in stored) {
        audio = stored.audio;
        voice = "salva";
      } else {
        voice = stored.voice;
      }
    } else {
      voice = source.reason;
    }
  }

  const oldAudioStays = !audio && row.productAudio ? " A peça continua com o áudio antigo; para trocar, responda uma próxima pergunta com um áudio só e *ok voz*." : "";
  const decisionNote = `${parsed.decision === "replace" ? ` Salvei do jeito que você escreveu: "${note}"` : ""}${voice ? VOICE_LINE[voice] : ""}${oldAudioStays}`;

  let previousAudioPath: string | null = null;
  let applied = false;
  try {
    applied = await db.transaction(async (tx) => {
      const moved = await transitionInterview(tx, {
        id: interview.id,
        to: "approved",
        from: ["draft_sent", "drafting"],
        now,
        patch: { decidedAt: now, decidedByMessage: parsed.messageKey, decisionNote },
      });
      if (!moved) return false;
      ({ previousAudioPath } = await applyInterviewCuratorNote(tx, { productId: interview.productId, interviewId: interview.id, note, audio, now }));
      return true;
    });
  } catch (error) {
    // O banco caiu depois do upload: o arquivo novo não fica órfão (o retry sobe outro).
    if (audio) await removeReplacedCuratorAudio(storage, audio.path);
    throw error;
  }
  if (!applied) {
    if (audio) await removeReplacedCuratorAudio(storage, audio.path);
    return { skipped: "ja_decidida" };
  }
  if (previousAudioPath) await removeReplacedCuratorAudio(storage, previousAudioPath);

  await notify(db, provider, {
    templateKey: INTERVIEW_TEMPLATES.saved,
    vars: { peca: productName, vendedora: seller, voz: decisionNote },
    messageKey: parsed.messageKey,
  });
  const done = parsed.decision === "replace" ? "nova" : "aprovada";
  return voice ? { done, voice } : { done };
}

// ---------------------------------------------------------------------------
// Painel
// ---------------------------------------------------------------------------

export type InterviewSummary = {
  id: string;
  productId: string;
  productName: string;
  question: string;
  /** O que a dona vê: aberta fora do prazo já aparece como "ficou sem resposta". */
  status: InterviewStatus;
  askedAt: Date;
};

export async function listRecentInterviews(db: DbOrTx, limit = 6, now: Date = new Date()): Promise<InterviewSummary[]> {
  const rows = await db
    .select({ interview: curatorInterviews, productName: products.name })
    .from(curatorInterviews)
    .innerJoin(products, eq(products.id, curatorInterviews.productId))
    .orderBy(desc(curatorInterviews.askedAt))
    .limit(limit);
  return rows.map(({ interview, productName }) => ({
    id: interview.id,
    productId: interview.productId,
    productName,
    question: interview.question,
    status: effectiveInterviewStatus(clockOf(interview), now),
    askedAt: interview.askedAt,
  }));
}

const scheduleSchema = z.object({
  hour: z.number().int(),
  weekends: z.boolean(),
  userId: z.uuid(),
});

/** Hora e fim de semana da pergunta (o interruptor é o toggle do painel). */
export async function saveInterviewSchedule(db: ServiceDb, input: z.input<typeof scheduleSchema>): Promise<void> {
  const parsed = scheduleSchema.parse(input);
  await updateSetting(db, { key: "curator_interview_hour", value: parsed.hour, userId: parsed.userId });
  await updateSetting(db, { key: "curator_interview_weekends", value: parsed.weekends, userId: parsed.userId });
}
