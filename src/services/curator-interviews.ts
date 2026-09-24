// Entrevista da curadora: a Lia faz UMA pergunta por dia sobre UMA peça no
// WhatsApp da dona; a resposta (áudio, ou texto começando com "resposta:")
// vira um rascunho de nota + duas legendas, e só entra na peça com o "ok"
// dela. É o caminho mais curto para a voz da dona chegar à Lia e aos posts:
// ninguém senta para escrever descrição, mas responder a uma pergunta por
// áudio leva 20 segundos.
//
// Fluxo: cron de hora em hora → curator.interview_ask (pergunta com a foto)
// → a resposta cai no webhook (routeInterviewReply) → transcrição → rascunho
// pela fila (curator.interview_draft) → "ok"/"ok voz"/"corrige:"/"pula" →
// curator.interview_decide. Uma entrevista aberta por vez (índice parcial).
import { randomUUID } from "node:crypto";

import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";

import type { SalesAssistant } from "@/adapters/assistant";
import type { FileStorage } from "@/adapters/storage";
import type { MessagingProvider } from "@/adapters/zapi";
import {
  buildInterviewDraftPrompt,
  classifyInterviewReply,
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
import { auditLog, cityEditionProducts, curatorInterviews, productImages, products, waMessages } from "@/db/schema";
import { spDayKey, spMinutesOfDay, weekdayIndexSP } from "@/lib/sp-day";
import { enqueueOutboxEvent, type DbOrTx } from "@/queue/enqueue";
import { hasOpenAtelierBatch } from "@/services/atelier";
import { listPublicCityEditions } from "@/services/city-editions";
import { applyInterviewCuratorNote, removeReplacedCuratorAudio } from "@/services/curator-notes";
import { getSettingsMap, updateSetting, type ServiceDb } from "@/services/settings";
import { publicImageUrl } from "@/services/store-catalog";
import { sendToOwner, type SendWaMessageResult } from "@/services/wa-messaging";

export const INTERVIEW_ASK_TEMPLATE = "owner_interview_ask";
export const INTERVIEW_DRAFT_TEMPLATE = "owner_interview_draft";
export const INTERVIEW_DONE_TEMPLATE = "owner_interview_done";

const DEFAULT_DRAFT_MODEL = "claude-sonnet-5";
/** A dona espera o rascunho no WhatsApp: a inteligência tem 25 s; depois, a própria fala vira a nota. */
const DRAFT_MODEL_TIMEOUT_MS = 25_000;

// ---------------------------------------------------------------------------
// Configuração
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

type InterviewRow = typeof curatorInterviews.$inferSelect;

async function findOpenInterview(db: DbOrTx): Promise<InterviewRow | null> {
  const [row] = await db
    .select()
    .from(curatorInterviews)
    .where(inArray(curatorInterviews.status, [...OPEN_INTERVIEW_STATUSES]))
    .orderBy(desc(curatorInterviews.askedAt))
    .limit(1);
  return row ?? null;
}

function statusOf(row: { status: string }): InterviewStatus {
  return isInterviewStatus(row.status) ? row.status : "failed";
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
  const sources = (input.from ?? interviewSourcesFor(input.to)).filter((from) => interviewSourcesFor(input.to).includes(from));
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
  const open = await db
    .select({ id: curatorInterviews.id, status: curatorInterviews.status, askedAt: curatorInterviews.askedAt, draftSentAt: curatorInterviews.draftSentAt })
    .from(curatorInterviews)
    .where(inArray(curatorInterviews.status, [...OPEN_INTERVIEW_STATUSES]));
  let expired = 0;
  for (const row of open) {
    if (isInterviewOpen({ status: statusOf(row), askedAt: row.askedAt, draftSentAt: row.draftSentAt }, now)) continue;
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
  const recent = await db
    .select({ status: curatorInterviews.status })
    .from(curatorInterviews)
    .orderBy(desc(curatorInterviews.askedAt))
    .limit(10);
  const dayKey = spDayKey(now);
  const ask = shouldAskNow({
    enabled: settings.enabled,
    hour: settings.hour,
    weekends: settings.weekends,
    spHour: Math.floor(spMinutesOfDay(now) / 60),
    spWeekday: weekdayIndexSP(dayKey),
    cadence: interviewCadence(recent.map((row) => ({ status: statusOf(row) }))),
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

/** "Perguntar agora" no painel: fura a hora (não a regra de uma aberta por vez). */
export async function requestCuratorInterviewNow(
  db: DbOrTx,
  input: { userId: string; now?: Date },
): Promise<{ ok: true } | { ok: false; reason: "aberta" }> {
  const userId = z.uuid().parse(input.userId);
  const now = input.now ?? new Date();
  const open = await findOpenInterview(db);
  if (open && isInterviewOpen({ status: statusOf(open), askedAt: open.askedAt, draftSentAt: open.draftSentAt }, now)) {
    return { ok: false, reason: "aberta" };
  }
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
  const history = await db
    .select({ productId: curatorInterviews.productId, questionKey: curatorInterviews.questionKey, askedAt: curatorInterviews.askedAt })
    .from(curatorInterviews);
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

export const interviewAskPayloadSchema = z.object({ askKey: z.string().min(1).max(80) });

export type AskCuratorInterviewResult =
  | { asked: true; interviewId: string; productId: string }
  | { skipped: "desligado" | "ja_processada" | "aberta" | "nada_a_perguntar" | SendSkip };

type SendSkip = Extract<SendWaMessageResult, { skipped: unknown }>["skipped"];

async function sendQuestion(db: DbOrTx, provider: MessagingProvider, row: { id: string; productId: string; question: string }): Promise<SendWaMessageResult> {
  const [product] = await db.select({ name: products.name }).from(products).where(eq(products.id, row.productId)).limit(1);
  const photo = await productPhotoUrl(db, row.productId);
  return sendToOwner(db, provider, {
    templateKey: INTERVIEW_ASK_TEMPLATE,
    vars: { peca: product?.name ?? "a peça", pergunta: row.question },
    dedupeKey: `curator.interview_ask:${row.id}`,
    ...(photo ? { image: { url: photo } } : {}),
  });
}

/** Handler da fila: escolhe a peça, grava a entrevista e manda a pergunta com a foto. */
export async function askCuratorInterview(
  db: DbOrTx,
  provider: MessagingProvider,
  input: z.input<typeof interviewAskPayloadSchema>,
  clock: { now?: () => Date } = {},
): Promise<AskCuratorInterviewResult> {
  const { askKey } = interviewAskPayloadSchema.parse(input);
  const now = (clock.now ?? (() => new Date()))();
  const manual = askKey.startsWith("agora:");
  if (!manual && !(await loadInterviewSettings(db)).enabled) return { skipped: "desligado" };

  // Reentrega do mesmo evento: a pergunta já existe — só reenvia (o dedupe
  // do WhatsApp segura a duplicata) se ainda estiver esperando resposta.
  const [existing] = await db.select().from(curatorInterviews).where(eq(curatorInterviews.askKey, askKey)).limit(1);
  if (existing) {
    if (existing.status !== "asked") return { skipped: "ja_processada" };
    const sent = await sendQuestion(db, provider, existing);
    if ("skipped" in sent) return { skipped: sent.skipped };
    return { asked: true, interviewId: existing.id, productId: existing.productId };
  }

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

  const sent = await sendQuestion(db, provider, row);
  if ("skipped" in sent) {
    // Sem telefone da dona, WhatsApp desligado ou modelo apagado: a pergunta
    // não saiu e a entrevista não pode ficar aberta segurando a próxima.
    await transitionInterview(db, { id: row.id, to: "failed", now });
    return { skipped: sent.skipped };
  }
  return { asked: true, interviewId: row.id, productId: row.productId };
}

// ---------------------------------------------------------------------------
// A resposta da dona (dentro da transação do webhook)
// ---------------------------------------------------------------------------

export type InterviewRoute =
  /** Áudio: vai transcrever; a transcrição volta por receiveInterviewTranscript. */
  | { kind: "transcribe"; interviewId: string }
  /** Texto de resposta, aprovação, correção ou "pula": já está na fila. */
  | { kind: "queued"; interviewId: string };

/**
 * A mensagem da dona é para a entrevista aberta? Lote de fotos do Ateliê
 * aberto ganha (as fotos são de peça nova); fora do prazo, nada muda — o
 * texto solto dela continua indo à Lia. null = siga o fluxo de sempre.
 */
export async function routeInterviewReply(
  tx: DbOrTx,
  input: { phoneE164: string; kind: "audio" | "text" | "image" | "note"; body: string; waMessageId: string; now: Date },
): Promise<InterviewRoute | null> {
  const interview = await findOpenInterview(tx);
  if (!interview) return null;
  const status = statusOf(interview);
  if (!isInterviewOpen({ status, askedAt: interview.askedAt, draftSentAt: interview.draftSentAt }, input.now)) return null;
  const reply = classifyInterviewReply({ status, messageKind: input.kind, body: input.body });
  if (!reply) return null;
  if (await hasOpenAtelierBatch(tx, input.phoneE164, input.now)) return null;

  if (reply.kind === "answer_audio") {
    const claimed = await tx
      .update(curatorInterviews)
      .set({ answerWaMessageId: input.waMessageId, updatedAt: input.now })
      .where(and(eq(curatorInterviews.id, interview.id), inArray(curatorInterviews.status, ["asked", "draft_sent"])))
      .returning({ id: curatorInterviews.id });
    return claimed.length > 0 ? { kind: "transcribe", interviewId: interview.id } : null;
  }

  if (reply.kind === "answer_text") {
    const moved = await transitionInterview(tx, {
      id: interview.id,
      to: "drafting",
      from: ["asked", "draft_sent"],
      now: input.now,
      patch: { answerWaMessageId: input.waMessageId, transcript: reply.text },
    });
    if (!moved) return null;
    await enqueueDraft(tx, { interviewId: interview.id, answerKey: input.waMessageId });
    return { kind: "queued", interviewId: interview.id };
  }

  const decision =
    reply.kind === "approve" ? (reply.withVoice ? "approve_voice" : "approve") : reply.kind === "correct" ? "correct" : "skip";
  await enqueueOutboxEvent(tx, {
    eventType: "curator.interview_decide",
    dedupeKey: `curator.interview_decide:${input.waMessageId}`,
    aggregateType: "curator_interview",
    aggregateId: interview.id,
    payload: {
      interviewId: interview.id,
      decision,
      messageKey: input.waMessageId,
      ...(reply.kind === "correct" ? { text: reply.text } : {}),
    },
  });
  return { kind: "queued", interviewId: interview.id };
}

async function enqueueDraft(tx: DbOrTx, input: { interviewId: string; answerKey: string }): Promise<void> {
  await enqueueOutboxEvent(tx, {
    eventType: "curator.interview_draft",
    dedupeKey: `curator.interview_draft:${input.answerKey}`,
    aggregateType: "curator_interview",
    aggregateId: input.interviewId,
    payload: input,
  });
}

/**
 * A transcrição do áudio voltou (wa-transcribe → routeInboundMessage): se o
 * áudio era a resposta da entrevista, grava a fala e pede o rascunho; se não
 * deu para ouvir, avisa a dona. false = o áudio não era da entrevista.
 */
export async function receiveInterviewTranscript(
  tx: DbOrTx,
  input: { waMessageId: string; text: string; now: Date },
): Promise<boolean> {
  const [interview] = await tx
    .select({ id: curatorInterviews.id, status: curatorInterviews.status })
    .from(curatorInterviews)
    .where(and(eq(curatorInterviews.answerWaMessageId, input.waMessageId), inArray(curatorInterviews.status, ["asked", "draft_sent"])))
    .limit(1);
  if (!interview) return false;

  const unheard = input.text.startsWith(INBOUND_MEDIA_MARKERS.audio) || input.text.trim() === "";
  if (unheard) {
    await enqueueOutboxEvent(tx, {
      eventType: "curator.interview_decide",
      dedupeKey: `curator.interview_decide:${input.waMessageId}`,
      aggregateType: "curator_interview",
      aggregateId: interview.id,
      payload: { interviewId: interview.id, decision: "unheard", messageKey: input.waMessageId },
    });
    return true;
  }
  const moved = await transitionInterview(tx, {
    id: interview.id,
    to: "drafting",
    from: ["asked", "draft_sent"],
    now: input.now,
    patch: { transcript: input.text },
  });
  if (moved) await enqueueDraft(tx, { interviewId: interview.id, answerKey: input.waMessageId });
  return true;
}

// ---------------------------------------------------------------------------
// O rascunho
// ---------------------------------------------------------------------------

export const interviewDraftPayloadSchema = z.object({ interviewId: z.uuid(), answerKey: z.string().min(1) });

export type DraftCuratorInterviewResult =
  | { sent: true; usedModel: boolean }
  | { skipped: "inexistente" | "ja_decidida" | "sem_fala" | SendSkip };

function draftVars(productName: string, draft: InterviewDraft): Record<string, string> {
  const captions = draft.captions.length > 0 ? `\n\n*Legendas*\n${draft.captions.map((caption, index) => `${index + 1}. ${caption}`).join("\n")}` : "";
  return { peca: productName, nota: draft.note, legendas: captions };
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
      maxTokens: 800,
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

/** Handler da fila: a fala vira nota + legendas e o rascunho vai para a dona aprovar. */
export async function draftCuratorInterview(
  db: DbOrTx,
  provider: MessagingProvider,
  assistant: SalesAssistant,
  input: z.input<typeof interviewDraftPayloadSchema>,
  clock: { now?: () => Date } = {},
): Promise<DraftCuratorInterviewResult> {
  const { interviewId, answerKey } = interviewDraftPayloadSchema.parse(input);
  const now = (clock.now ?? (() => new Date()))();
  const [row] = await db
    .select({ interview: curatorInterviews, productName: products.name })
    .from(curatorInterviews)
    .innerJoin(products, eq(products.id, curatorInterviews.productId))
    .where(eq(curatorInterviews.id, interviewId))
    .limit(1);
  if (!row) return { skipped: "inexistente" };
  const { interview } = row;
  const dedupeKey = `curator.interview_draft:${interview.id}:${answerKey}`;

  // Reentrega depois de gravar: só reenvia o mesmo rascunho.
  if (interview.status === "draft_sent" && interview.draft && interview.answerWaMessageId === answerKey) {
    const resent = await sendToOwner(db, provider, { templateKey: INTERVIEW_DRAFT_TEMPLATE, vars: draftVars(row.productName, interview.draft), dedupeKey });
    return "skipped" in resent ? { skipped: resent.skipped } : { sent: true, usedModel: Boolean(interview.draft.model) };
  }
  if (interview.status !== "drafting") return { skipped: "ja_decidida" };
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
    await transitionInterview(db, { id: interview.id, to: "failed", now });
    return { skipped: "sem_fala" };
  }

  const draft = { ...written.draft, model: written.model };
  const moved = await transitionInterview(db, {
    id: interview.id,
    to: "draft_sent",
    from: ["drafting"],
    now,
    patch: { draft, draftSentAt: now },
  });
  if (!moved) return { skipped: "ja_decidida" };
  const sent = await sendToOwner(db, provider, { templateKey: INTERVIEW_DRAFT_TEMPLATE, vars: draftVars(row.productName, draft), dedupeKey });
  return "skipped" in sent ? { skipped: sent.skipped } : { sent: true, usedModel: written.model !== null };
}

// ---------------------------------------------------------------------------
// A decisão: "ok", "ok voz", "corrige: …", "pula" (e o áudio que não deu para ouvir)
// ---------------------------------------------------------------------------

export const interviewDecidePayloadSchema = z.object({
  interviewId: z.uuid(),
  decision: z.enum(["approve", "approve_voice", "correct", "skip", "unheard"]),
  messageKey: z.string().min(1),
  text: z.string().max(4000).optional(),
});

export type DecideCuratorInterviewResult =
  | { done: "aprovada" | "corrigida" | "pulada" | "avisada"; voice?: "salva" | "longo" | "escrito" | "falhou" }
  | { skipped: "inexistente" | "ja_decidida" | "nota_invalida" };

async function sendDone(db: DbOrTx, provider: MessagingProvider, messageKey: string, resultado: string): Promise<void> {
  await sendToOwner(db, provider, { templateKey: INTERVIEW_DONE_TEMPLATE, vars: { resultado }, dedupeKey: `curator.interview_done:${messageKey}` });
}

/** O áudio da resposta vira a voz da curadora: baixa da Z-API e guarda no bucket. */
async function storeAnswerAudio(
  db: DbOrTx,
  provider: MessagingProvider,
  storage: FileStorage,
  input: { productId: string; answerWaMessageId: string | null },
): Promise<{ audio: { path: string; mime: string; seconds: number | null } } | { voice: "longo" | "escrito" | "falhou" }> {
  if (!input.answerWaMessageId) return { voice: "escrito" };
  const [message] = await db
    .select({ kind: waMessages.kind, mediaUrl: waMessages.mediaUrl, mediaMeta: waMessages.mediaMeta })
    .from(waMessages)
    .where(eq(waMessages.id, input.answerWaMessageId))
    .limit(1);
  if (!message || message.kind !== "audio" || !message.mediaUrl) return { voice: "escrito" };
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

const VOICE_NOTE: Record<"salva" | "longo" | "escrito" | "falhou", string> = {
  salva: " e o seu áudio virou a voz da curadora 🎙️",
  longo: " (o áudio passou de 1 minuto, então guardei só o texto)",
  escrito: " (a resposta foi escrita, então guardei só o texto)",
  falhou: " (não consegui guardar o áudio agora, então guardei só o texto)",
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
    .select({ interview: curatorInterviews, productName: products.name })
    .from(curatorInterviews)
    .innerJoin(products, eq(products.id, curatorInterviews.productId))
    .where(eq(curatorInterviews.id, parsed.interviewId))
    .limit(1);
  if (!row) return { skipped: "inexistente" };
  const { interview, productName } = row;

  if (parsed.decision === "unheard") {
    await sendDone(
      db,
      provider,
      parsed.messageKey,
      "Não consegui ouvir esse áudio agora 😕 Pode mandar de novo, ou escrever a resposta começando com *resposta:*.",
    );
    return { done: "avisada" };
  }

  if (parsed.decision === "skip") {
    const moved = await transitionInterview(db, { id: interview.id, to: "skipped", from: ["asked", "draft_sent"], now, patch: { decidedAt: now } });
    if (!moved) return { skipped: "ja_decidida" };
    await sendDone(db, provider, parsed.messageKey, `Tudo bem — deixei ${productName} para depois. Na próxima pergunto de outra peça.`);
    return { done: "pulada" };
  }

  if (interview.status !== "draft_sent" || !interview.draft) return { skipped: "ja_decidida" };

  let note = interview.draft.note;
  if (parsed.decision === "correct") {
    const fitted = fitCuratorNote(parsed.text ?? "");
    if (!fitted.text || fitted.truncated) {
      await sendDone(db, provider, parsed.messageKey, "Não salvei: a nota precisa ter texto e caber em 1000 caracteres. Mande *corrige:* de novo, mais curtinha.");
      return { skipped: "nota_invalida" };
    }
    note = fitted.text;
  }

  let voice: "salva" | "longo" | "escrito" | "falhou" | undefined;
  let audio: { path: string; mime: string; seconds: number | null } | null = null;
  if (parsed.decision === "approve_voice") {
    const stored = await storeAnswerAudio(db, provider, storage, { productId: interview.productId, answerWaMessageId: interview.answerWaMessageId });
    if ("audio" in stored) {
      audio = stored.audio;
      voice = "salva";
    } else {
      voice = stored.voice;
    }
  }

  let previousAudioPath: string | null = null;
  const applied = await db.transaction(async (tx) => {
    const moved = await transitionInterview(tx, { id: interview.id, to: "approved", from: ["draft_sent"], now, patch: { decidedAt: now } });
    if (!moved) return false;
    ({ previousAudioPath } = await applyInterviewCuratorNote(tx, { productId: interview.productId, interviewId: interview.id, note, audio, now }));
    return true;
  });
  if (!applied) {
    if (audio) await removeReplacedCuratorAudio(storage, audio.path);
    return { skipped: "ja_decidida" };
  }
  if (previousAudioPath) await removeReplacedCuratorAudio(storage, previousAudioPath);

  const done = parsed.decision === "correct" ? "corrigida" : "aprovada";
  await sendDone(
    db,
    provider,
    parsed.messageKey,
    `✅ Nota salva em ${productName}${voice ? VOICE_NOTE[voice] : ""}. A Lia já usa quando perguntarem dessa peça.`,
  );
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
  status: InterviewStatus;
  askedAt: Date;
};

export async function listRecentInterviews(db: DbOrTx, limit = 6): Promise<InterviewSummary[]> {
  const rows = await db
    .select({
      id: curatorInterviews.id,
      productId: curatorInterviews.productId,
      productName: products.name,
      question: curatorInterviews.question,
      status: curatorInterviews.status,
      askedAt: curatorInterviews.askedAt,
    })
    .from(curatorInterviews)
    .innerJoin(products, eq(products.id, curatorInterviews.productId))
    .orderBy(desc(curatorInterviews.askedAt))
    .limit(limit);
  return rows.map((row) => ({ ...row, status: statusOf(row) }));
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
