// O handler da prévia na foto da cliente ("Me vê com ela"; só a fila importa
// este módulo). O trabalho é dividido pelo ESTADO da linha, nunca pelo
// payload — uma invocação da fila tem menos de 1 min e a FASHN leva ~25 s:
//
// - queued: baixa a foto dela (da Z-API, na hora), checa a foto (uma vez;
//   recusada = dica e fim, nada cobrado), marca "enviando" ANTES de pedir,
//   pede à FASHN e grava o id do pedido assim que ela aceita;
// - processing: acompanha o MESMO pedido pelo id, passa a prévia pelos dois
//   portões (a peça e a pessoa) e envia embutida pela Z-API. Infiel e ainda
//   cabe outra tentativa = volta a queued com outra semente;
// - submitting sem id: o envio caiu no meio — pode ter sido cobrado, então
//   NUNCA pede de novo (a regra de ouro de services/studio-video-generate).
//
// Nenhuma imagem é guardada: nem a foto dela, nem a prévia (só o que os
// portões disseram, em texto). Os avisos à cliente saem ANTES da mudança de
// estado final, com dedupe — se o envio cair, a fila repete sem duplicar.
import { and, eq } from "drizzle-orm";
import sharp from "sharp";
import { z } from "zod";

import type { SalesAssistant } from "@/adapters/assistant";
import { StudioUnavailableError, type ImageStudio, type StudioImage } from "@/adapters/image-studio";
import type { FileStorage } from "@/adapters/storage";
import type { MessagingProvider } from "@/adapters/zapi";
import { estimateUsageCostUsdCents } from "@/core/ai/model-cost";
import { parsePieceType } from "@/core/catalog/piece-types";
import { HandlerOutOfTimeError } from "@/core/queue/handler-errors";
import { creditsFor, creditsToUsdCents } from "@/core/studio/cost";
import { buildCustomerTryOnPrompt } from "@/core/studio/prompts";
import { classifyVideoFailure } from "@/core/studio/video";
import {
  GARMENT_JUDGE_JSON_SCHEMA,
  GARMENT_JUDGE_SYSTEM_PROMPT,
  GARMENT_JUDGE_USER_TEXT,
  garmentJudgmentSchema,
  passesTryOnVerdict,
  PERSON_JUDGE_JSON_SCHEMA,
  PERSON_JUDGE_SYSTEM_PROMPT,
  PERSON_JUDGE_USER_TEXT,
  personJudgmentSchema,
  tryOnVerdictSummary,
  type TryOnVerdict,
} from "@/core/tryon/judge";
import {
  PHOTO_CHECK_JSON_SCHEMA,
  PHOTO_CHECK_SYSTEM_PROMPT,
  PHOTO_CHECK_USER_TEXT,
  photoCheckSchema,
  photoCheckVerdict,
} from "@/core/tryon/photo-check";
import {
  failureText,
  photoProblemText,
  requiredFraming,
  TRYON_MAX_ATTEMPTS,
  TRYON_TIMING,
  tryOnCaption,
  tryOnCategoryFor,
  type TryOnFailureReason,
  type TryOnPhotoProblem,
} from "@/core/tryon/rules";
import { assertTryOnTransition, isTryOnStatus, type TryOnStatus } from "@/core/tryon/status";
import { auditLog, tryonRequests, waMessages } from "@/db/schema";
import { spDayKey } from "@/lib/sp-day";
import type { DbOrTx } from "@/queue/enqueue";
import { mdPathFor } from "@/services/catalog";
import { garmentImageFor, requireProductForStudio, ServiceError, type ProductForStudio } from "@/services/studio";
import { TRYON_EVENT, tryOnMessageDedupeKey, tryOnPayloadSchema, type TryOnRequest } from "@/services/tryon";
import { loadTryOnSettings } from "@/services/tryon-settings";
import { INBOUND_IMAGE_MAX_BYTES, prepareImageForModel } from "@/services/wa-media";
import { sendMediaMessage, sendTemplateMessage, sendToOwner } from "@/services/wa-messaging";

/** Os portões usam o modelo mais atento: decote e estampa são o que está em jogo. */
export const TRYON_JUDGE_MODEL = "claude-sonnet-5";

export type TryOnDeps = {
  studio: ImageStudio;
  assistant: SalesAssistant;
  provider: MessagingProvider;
  storage: FileStorage;
};

export type TryOnResult =
  | { outcome: "sent"; credits: number; usdCents: number }
  | { outcome: "photo_rejected"; problem: TryOnPhotoProblem }
  | { outcome: "failed"; reason: TryOnFailureReason }
  | { outcome: "skipped"; reason: "pedido_nao_encontrado" | "pedido_fora_da_fila" };

type Clock = () => Date;
type Options = { now?: Clock; deadlineAt?: Date };
type Image = { data: Buffer; mimeType: "image/jpeg" | "image/png" | "image/webp" };

/** Semente por tentativa: a repetição sai diferente da primeira. */
export function tryOnSeedFor(attempt: number): number {
  return 2_000 + attempt;
}

function remainingMs(options: Options, clock: Clock): number {
  return options.deadlineAt ? options.deadlineAt.getTime() - clock().getTime() : Number.POSITIVE_INFINITY;
}

/** Pouco tempo nesta invocação: a fila devolve a linha sem contar tentativa e a próxima segue pelo estado. */
function ensureTime(options: Options, clock: Clock, neededMs: number): void {
  const left = remainingMs(options, clock);
  if (left < neededMs) throw new HandlerOutOfTimeError(left);
}

/** Quanto esperar pela FASHN: o prazo da fila menos o portão e o envio. */
function waitSignal(options: Options, clock: Clock): AbortSignal {
  return budgetSignal(options, clock, TRYON_TIMING.finishReserveMs);
}

/** O prazo da fila menos uma folga (para gravar e responder depois da chamada). */
function budgetSignal(options: Options, clock: Clock, reserveMs = 3_000): AbortSignal {
  const left = remainingMs(options, clock);
  if (!Number.isFinite(left)) return AbortSignal.timeout(90_000);
  return AbortSignal.timeout(Math.max(1_000, left - reserveMs));
}

/** O veredito gravado vale para ESTE pedido da FASHN (a retomada depois de um envio que caiu não julga de novo). */
const savedVerdictSchema = z.object({ vendorJobId: z.string(), garment: garmentJudgmentSchema, person: personJudgmentSchema });

function savedPassingVerdict(request: TryOnRequest): TryOnVerdict | null {
  const saved = savedVerdictSchema.safeParse(request.verdict);
  if (!saved.success || saved.data.vendorJobId !== request.vendorJobId) return null;
  const verdict = { garment: saved.data.garment, person: saved.data.person };
  return passesTryOnVerdict(verdict) ? verdict : null;
}

function mimeOf(contentType: string | null): Image["mimeType"] {
  if (contentType?.includes("webp")) return "image/webp";
  if (contentType?.includes("png")) return "image/png";
  return "image/jpeg";
}

/**
 * A foto dela como o celular gravou: gira pela orientação, sai em JPEG sem
 * metadados (some o GPS de onde ela tirou) e no máximo 2048 px no lado maior.
 */
export async function prepareCustomerPhoto(data: Buffer): Promise<Buffer> {
  return sharp(data, { limitInputPixels: 50_000_000 })
    .rotate()
    .resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 90 })
    .toBuffer();
}

/** A prévia que vai pelo WhatsApp: JPEG de até 1600 px (o WhatsApp recomprime; menos bytes na Z-API). */
async function previewForWhatsapp(data: Buffer): Promise<string> {
  const jpeg = await sharp(data, { limitInputPixels: 50_000_000 })
    .rotate()
    .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();
  return jpeg.toString("base64");
}

async function loadRequest(db: DbOrTx, requestId: string): Promise<TryOnRequest | null> {
  const [row] = await db.select().from(tryonRequests).where(eq(tryonRequests.id, requestId)).limit(1);
  return row ?? null;
}

async function audit(db: DbOrTx, request: TryOnRequest, action: string, after: Record<string, unknown>): Promise<void> {
  await db.insert(auditLog).values({ actorType: "system", action, entityType: "tryon_request", entityId: request.id, after });
}

/** Muda o estado só se a linha ainda estiver em `from` (outra rodada pode ter chegado antes). */
async function transition(
  db: DbOrTx,
  request: TryOnRequest,
  from: TryOnStatus,
  to: TryOnStatus,
  patch: Partial<typeof tryonRequests.$inferInsert>,
  now: Date,
): Promise<TryOnRequest | null> {
  assertTryOnTransition(from, to);
  const [updated] = await db
    .update(tryonRequests)
    .set({ ...patch, status: to, updatedAt: now })
    .where(and(eq(tryonRequests.id, request.id), eq(tryonRequests.status, from)))
    .returning();
  return updated ?? null;
}

/** Texto curto à cliente (fala da Lia: dedupe `wa.bot_tryon:`). */
async function tellCustomer(db: DbOrTx, deps: TryOnDeps, request: TryOnRequest, what: string, body: string): Promise<void> {
  await sendTemplateMessage(db, deps.provider, {
    bodyOverride: body,
    phoneE164: request.phoneE164,
    ...(request.customerId ? { customerId: request.customerId } : {}),
    dedupeKey: tryOnMessageDedupeKey(request.id, what),
    requireOptIn: false,
    verifyPhone: false,
  });
}

/** Crédito acabou ou chave sumiu: avisa a dona uma vez por dia (melhor esforço — a cliente já foi avisada). */
async function alertOwner(db: DbOrTx, deps: TryOnDeps, kind: "sem_creditos" | "sem_chave", now: Date): Promise<void> {
  const body =
    kind === "sem_creditos"
      ? "⚠️ Prévia na foto da cliente: os créditos da FASHN acabaram. A Lia avisou a cliente que a prévia está indisponível. Compre créditos em fashn.ai ou desligue a prévia em Vendedora & WhatsApp."
      : "⚠️ Prévia na foto da cliente: a chave da FASHN não está configurada. A Lia avisou a cliente que a prévia está indisponível.";
  try {
    await sendToOwner(db, deps.provider, { bodyOverride: body, dedupeKey: `wa.owner_tryon:${kind}:${spDayKey(now)}` });
  } catch (error) {
    console.error(`[${TRYON_EVENT}] aviso à dona falhou: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Encerra sem prévia: avisa a cliente (com dedupe) e só então grava o motivo e o gasto. */
async function failRequest(
  db: DbOrTx,
  deps: TryOnDeps,
  request: TryOnRequest,
  input: { reason: TryOnFailureReason; usdCents?: number; detail?: string; now: Date },
): Promise<TryOnResult> {
  const from = request.status as TryOnStatus;
  await tellCustomer(db, deps, request, `falhou:${input.reason}`, failureText(input.reason));
  const updated = await transition(
    db,
    request,
    from,
    "failed",
    {
      failureReason: input.reason,
      usdCents: Math.max(request.usdCents, input.usdCents ?? request.usdCents),
      finishedAt: input.now,
      // O id nunca é apagado: é a prova do que a FASHN pode ter cobrado.
    },
    input.now,
  );
  if (updated) await audit(db, request, "tryon.fail", { from, reason: input.reason, detail: input.detail?.slice(0, 300) ?? null, vendorJobId: request.vendorJobId, attempts: request.attempts });
  if (input.reason === "sem_creditos") await alertOwner(db, deps, "sem_creditos", input.now);
  return { outcome: "failed", reason: input.reason };
}

async function loadProduct(db: DbOrTx, request: TryOnRequest): Promise<ProductForStudio | null> {
  try {
    return await requireProductForStudio(db, request.productId);
  } catch (error) {
    if (error instanceof ServiceError) return null;
    throw error;
  }
}

/** A foto dela, baixada da Z-API na hora (a URL expira; nada é guardado). null = não há mais o que baixar. */
async function loadCustomerPhoto(db: DbOrTx, deps: TryOnDeps, request: TryOnRequest, now: Date): Promise<Buffer | null> {
  if (!request.photoWaMessageId) return null;
  const [message] = await db
    .select({ mediaUrl: waMessages.mediaUrl, createdAt: waMessages.createdAt })
    .from(waMessages)
    .where(eq(waMessages.id, request.photoWaMessageId))
    .limit(1);
  if (!message?.mediaUrl) return null;
  if (now.getTime() - message.createdAt.getTime() > TRYON_TIMING.photoMaxAgeMs) return null;
  // Falha de rede/Z-API relança: a fila tenta de novo (a última tentativa encerra com aviso).
  const media = await deps.provider.downloadMedia({ url: message.mediaUrl, maxBytes: INBOUND_IMAGE_MAX_BYTES });
  return prepareCustomerPhoto(media.data);
}

async function loadGarment(db: DbOrTx, deps: TryOnDeps, request: TryOnRequest): Promise<Image | null> {
  const garment = await garmentImageFor(db, request.productId, request.color);
  if (!garment) return null;
  // A rendição média (800 px) basta para o try-on e pesa 4× menos que a full.
  try {
    const md = await deps.storage.download(mdPathFor(garment.storagePath));
    return { data: md.data, mimeType: mimeOf(md.contentType) };
  } catch {
    const full = await deps.storage.download(garment.storagePath);
    return { data: full.data, mimeType: mimeOf(full.contentType) };
  }
}

async function forModel(data: Buffer) {
  const prepared = await prepareImageForModel(data);
  return { mediaType: prepared.mediaType, base64: prepared.base64 };
}

/** A checagem da foto (visão). Relança se o modelo cair: a fila tenta de novo. */
async function checkPhoto(deps: TryOnDeps, photo: Buffer, signal: AbortSignal | undefined) {
  const result = await deps.assistant.extractFromPhotos({
    system: PHOTO_CHECK_SYSTEM_PROMPT,
    images: [await forModel(photo)],
    userText: PHOTO_CHECK_USER_TEXT,
    model: TRYON_JUDGE_MODEL,
    jsonSchema: PHOTO_CHECK_JSON_SCHEMA,
    maxTokens: 400,
    signal,
  });
  return { check: photoCheckSchema.safeParse(result.json), usdCents: estimateUsageCostUsdCents(result.usage, TRYON_JUDGE_MODEL) };
}

/** Os dois portões em paralelo. Fora do formato = reprovado (nunca manda o que não foi julgado). */
async function judge(deps: TryOnDeps, input: { photo: Buffer; garment: Image; preview: Buffer; signal: AbortSignal | undefined }) {
  const [photo, garment, preview] = await Promise.all([forModel(input.photo), forModel(input.garment.data), forModel(input.preview)]);
  const [garmentResult, personResult] = await Promise.all([
    deps.assistant.extractFromPhotos({
      system: GARMENT_JUDGE_SYSTEM_PROMPT,
      images: [garment, preview],
      userText: GARMENT_JUDGE_USER_TEXT,
      model: TRYON_JUDGE_MODEL,
      jsonSchema: GARMENT_JUDGE_JSON_SCHEMA,
      maxTokens: 700,
      signal: input.signal,
    }),
    deps.assistant.extractFromPhotos({
      system: PERSON_JUDGE_SYSTEM_PROMPT,
      images: [photo, preview],
      userText: PERSON_JUDGE_USER_TEXT,
      model: TRYON_JUDGE_MODEL,
      jsonSchema: PERSON_JUDGE_JSON_SCHEMA,
      maxTokens: 400,
      signal: input.signal,
    }),
  ]);
  const usdCents = estimateUsageCostUsdCents(garmentResult.usage, TRYON_JUDGE_MODEL) + estimateUsageCostUsdCents(personResult.usage, TRYON_JUDGE_MODEL);
  const garmentJudgment = garmentJudgmentSchema.safeParse(garmentResult.json);
  const personJudgment = personJudgmentSchema.safeParse(personResult.json);
  const verdict: TryOnVerdict | null =
    garmentJudgment.success && personJudgment.success ? { garment: garmentJudgment.data, person: personJudgment.data } : null;
  return { verdict, usdCents };
}

/** A FASHN aceitou: grava o id (é o que impede pagar duas vezes). */
async function markSubmitted(db: DbOrTx, request: TryOnRequest, jobId: string, now: Date): Promise<TryOnRequest> {
  const updated = await transition(db, request, "submitting", "processing", { vendorJobId: jobId, submittedAt: now }, now);
  if (!updated) throw new Error(`prévia ${request.id} saiu de "enviando" enquanto a FASHN aceitava o pedido ${jobId}`);
  await audit(db, request, "tryon.submit", { vendorJobId: jobId, attempt: request.attempts, productId: request.productId });
  return updated;
}

/**
 * Envia o pedido à FASHN. Devolve a linha em "processing" (com o id) e, se
 * a imagem já veio na mesma chamada (fake), a imagem. Falha sem id segue a
 * regra de ouro: 429 volta à fila; recusa certa encerra; resposta perdida é
 * "envio incerto" e nunca é repetida.
 */
async function submit(
  db: DbOrTx,
  deps: TryOnDeps,
  request: TryOnRequest,
  input: { photo: Buffer; garment: Image; category: ReturnType<typeof tryOnCategoryFor>; clock: Clock },
): Promise<{ request: TryOnRequest; image: StudioImage | null } | TryOnResult> {
  const attempt = request.attempts + 1;
  const claimed = await transition(db, request, "queued", "submitting", { attempts: attempt }, input.clock());
  if (!claimed) return { outcome: "skipped", reason: "pedido_fora_da_fila" };

  let jobId: string | null = null;
  const accepted = new AbortController();
  let outcome: { images: StudioImage[] } | { error: unknown };
  try {
    outcome = {
      images: await deps.studio.generateOnModel({
        garment: input.garment,
        model: { data: input.photo, mimeType: "image/jpeg" },
        category: input.category ?? "auto",
        scenePrompt: buildCustomerTryOnPrompt(),
        count: 1,
        quality: "alta",
        seed: tryOnSeedFor(attempt),
        // O envio tem o próprio teto do adapter (15 s); aceito, a espera segue pela retomada (com o id já gravado).
        signal: accepted.signal,
        onSubmitted: (id) => {
          jobId = id;
          // O id no log antes de tudo: é a última pista se o banco falhar logo em seguida.
          console.info(`[${TRYON_EVENT}] ${request.id}: pedido ${id} aceito pela FASHN`);
          accepted.abort();
        },
      }),
    };
  } catch (error) {
    outcome = { error };
  }

  if (jobId !== null) {
    let submitted: TryOnRequest;
    try {
      submitted = await markSubmitted(db, claimed, jobId, input.clock());
    } catch (dbError) {
      const message = dbError instanceof Error ? dbError.message : String(dbError);
      console.error(`[${TRYON_EVENT}] ${request.id}: pedido ${jobId} aceito pela FASHN mas não gravado: ${message}`);
      // Gravação mínima do id (sem mudar estado): a próxima rodada segue por ele em vez de "envio incerto".
      await db
        .update(tryonRequests)
        .set({ vendorJobId: jobId, submittedAt: input.clock() })
        .where(and(eq(tryonRequests.id, request.id), eq(tryonRequests.status, "submitting")))
        .catch(() => undefined);
      throw new Error(`pedido ${jobId} aceito pela FASHN mas não gravado: ${message}`);
    }
    return { request: submitted, image: "images" in outcome ? (outcome.images[0] ?? null) : null };
  }

  const error = "error" in outcome ? outcome.error : new StudioUnavailableError("A FASHN não devolveu o id do pedido.", "invalid_response");
  if (!(error instanceof StudioUnavailableError)) {
    // Erro nosso antes de existir pedido: nada foi cobrado; volta à fila e relança.
    await transition(db, claimed, "submitting", "queued", { attempts: request.attempts }, input.clock());
    throw error;
  }
  const estimated = creditsToUsdCents(creditsFor("tryon", "alta", 1));
  switch (classifyVideoFailure({ reason: error.reason, status: error.status, jobId: null })) {
    case "retry_not_charged":
      await transition(db, claimed, "submitting", "queued", { attempts: request.attempts }, input.clock());
      throw error;
    case "closed_not_charged": {
      const reason = error.reason === "no_credits" ? "sem_creditos" : error.reason === "no_key" ? "indisponivel" : "recusada_pela_ia";
      const result = await failRequest(db, deps, claimed, { reason, detail: error.message, now: input.clock() });
      if (error.reason === "no_key") await alertOwner(db, deps, "sem_chave", input.clock());
      return result;
    }
    default:
      return failRequest(db, deps, claimed, { reason: "envio_incerto", usdCents: request.usdCents + estimated, detail: error.message, now: input.clock() });
  }
}

/** Acompanha o pedido pelo id (sem pedir de novo). Encerrado = resultado; null + linha = segue esperando. */
async function resume(
  db: DbOrTx,
  deps: TryOnDeps,
  request: TryOnRequest,
  input: { options: Options; clock: Clock },
): Promise<StudioImage | TryOnResult> {
  const estimated = request.usdCents + creditsToUsdCents(creditsFor("tryon", "alta", 1));
  if (!request.vendorJobId) {
    return failRequest(db, deps, request, { reason: "envio_incerto", usdCents: estimated, detail: "sem o id do pedido na FASHN", now: input.clock() });
  }
  if (request.submittedAt && input.clock().getTime() - request.submittedAt.getTime() > TRYON_TIMING.giveUpAfterMs) {
    return failRequest(db, deps, request, { reason: "demorou_demais", usdCents: estimated, now: input.clock() });
  }
  const signal = waitSignal(input.options, input.clock);
  try {
    const [image] = await deps.studio.generateOnModel({
      // A retomada não envia foto nenhuma: só acompanha o pedido pelo id.
      garment: { data: Buffer.alloc(0), mimeType: "image/jpeg" },
      model: { data: Buffer.alloc(0), mimeType: "image/jpeg" },
      category: "auto",
      scenePrompt: "",
      count: 1,
      quality: "alta",
      resumeJobId: request.vendorJobId,
      signal,
    });
    if (!image) throw new StudioUnavailableError("A FASHN terminou sem saída.", "invalid_response");
    return image;
  } catch (error) {
    if (!(error instanceof StudioUnavailableError)) throw error;
    switch (classifyVideoFailure({ reason: error.reason, status: error.status, jobId: request.vendorJobId })) {
      case "closed_not_charged":
        // "failed" no status: a FASHN não cobra pedido que falhou (moderação, foto ruim).
        return failRequest(db, deps, request, { reason: "recusada_pela_ia", detail: error.message, now: input.clock() });
      case "closed_job_gone":
        return failRequest(db, deps, request, { reason: "indisponivel", usdCents: estimated, detail: error.message, now: input.clock() });
      default:
        // Ainda aberto. Nosso prazo acabou: devolve sem contar tentativa; outra falha: a fila espaça e tenta de novo.
        if (signal.aborted) throw new HandlerOutOfTimeError(remainingMs(input.options, input.clock));
        throw error;
    }
  }
}

/** Passou nos portões: envia embutida (nada vai ao Storage) e só então grava "enviada". */
async function deliver(
  db: DbOrTx,
  deps: TryOnDeps,
  request: TryOnRequest,
  input: { preview: Buffer; productName: string; credits: number; usdCents: number; verdict: TryOnVerdict; now: Date },
): Promise<TryOnResult> {
  const result = await sendMediaMessage(db, deps.provider, {
    kind: "image",
    imageBase64: { data: await previewForWhatsapp(input.preview), mimeType: "image/jpeg" },
    body: tryOnCaption(input.productName),
    phoneE164: request.phoneE164,
    ...(request.customerId ? { customerId: request.customerId } : {}),
    dedupeKey: tryOnMessageDedupeKey(request.id, "previa"),
    requireOptIn: false,
    verifyPhone: false,
  });
  if ("skipped" in result && result.skipped !== "ja_enviado") {
    // WhatsApp desligado (ou número sem WhatsApp) entre o pedido e a entrega: nada a fazer com a imagem.
    return failRequest(db, deps, request, { reason: "indisponivel", usdCents: input.usdCents, detail: `envio pulado: ${result.skipped}`, now: input.now });
  }
  const updated = await transition(
    db,
    request,
    "processing",
    "sent",
    {
      sentAt: input.now,
      finishedAt: input.now,
      credits: input.credits,
      usdCents: input.usdCents,
      verdict: { vendorJobId: request.vendorJobId, ...input.verdict },
      failureReason: null,
    },
    input.now,
  );
  if (updated) {
    await audit(db, request, "tryon.sent", {
      productId: request.productId,
      vendorJobId: request.vendorJobId,
      attempts: request.attempts,
      credits: input.credits,
      estimatedCostUsdCents: input.usdCents,
      verdict: tryOnVerdictSummary(input.verdict),
    });
  }
  return { outcome: "sent", credits: input.credits, usdCents: input.usdCents };
}

export async function generateTryOn(db: DbOrTx, deps: TryOnDeps, rawPayload: unknown, options: Options = {}): Promise<TryOnResult> {
  const clock: Clock = options.now ?? (() => new Date());
  const { requestId } = tryOnPayloadSchema.parse(rawPayload);
  let request = await loadRequest(db, requestId);
  if (!request) return { outcome: "skipped", reason: "pedido_nao_encontrado" };

  // Por invocação: a foto dela e a da peça só são baixadas uma vez.
  let photo: Buffer | null | undefined;
  let garment: Image | null | undefined;
  let product: ProductForStudio | null | undefined;
  let pendingImage: StudioImage | null = null;

  // No máximo: envio → espera → (infiel) → envio de novo → espera. O laço é pelo estado.
  for (let step = 0; step < 6; step += 1) {
    if (!isTryOnStatus(request.status) || (request.status !== "queued" && request.status !== "submitting" && request.status !== "processing")) {
      return { outcome: "skipped", reason: "pedido_fora_da_fila" };
    }

    if (request.status === "submitting") {
      if (!request.vendorJobId) {
        // O envio caiu entre o pedido e a gravação do id: pode ter sido cobrado. Nunca pedir de novo.
        return failRequest(db, deps, request, {
          reason: "envio_incerto",
          usdCents: request.usdCents + creditsToUsdCents(creditsFor("tryon", "alta", 1)),
          detail: "o envio foi interrompido antes de a resposta da FASHN ser gravada",
          now: clock(),
        });
      }
      // O id chegou a ser gravado (gravação mínima): segue por ele.
      request = await markSubmitted(db, request, request.vendorJobId, clock());
      continue;
    }

    product ??= await loadProduct(db, request);
    const category = product ? tryOnCategoryFor(parsePieceType(product.pieceType ?? "")) : null;

    if (request.status === "processing") {
      const image = pendingImage ?? (await resume(db, deps, request, { options, clock }));
      pendingImage = null;
      if (!("data" in image)) return image;
      if (!product) return failRequest(db, deps, request, { reason: "peca_indisponivel", usdCents: request.usdCents + image.usdCents, now: clock() });
      photo ??= await loadCustomerPhoto(db, deps, request, clock());
      garment ??= await loadGarment(db, deps, request);
      const credits = request.credits + image.creditsUsed;
      // Já aprovada antes de um envio que caiu: manda sem julgar de novo (outra opinião poderia pedir — e pagar — outra prévia).
      const approved = savedPassingVerdict(request);
      if (approved) {
        return deliver(db, deps, request, { preview: image.data, productName: product.name, credits, usdCents: request.usdCents + image.usdCents, verdict: approved, now: clock() });
      }
      if (!photo || !garment) {
        // Paga e sem como julgar: nunca manda o que não foi julgado.
        return failRequest(db, deps, request, { reason: !photo ? "foto_indisponivel" : "peca_indisponivel", usdCents: request.usdCents + image.usdCents, now: clock() });
      }
      // Sem tempo para os portões nesta invocação: a próxima retoma pelo id (a saída fica 60 min na FASHN).
      ensureTime(options, clock, TRYON_TIMING.finishReserveMs);
      const judged = await judge(deps, { photo, garment, preview: image.data, signal: budgetSignal(options, clock) });
      const usdCents = request.usdCents + image.usdCents + judged.usdCents;
      const passed = judged.verdict !== null && passesTryOnVerdict(judged.verdict);
      console.info(`[${TRYON_EVENT}] ${request.id}: tentativa ${request.attempts} → ${judged.verdict ? tryOnVerdictSummary(judged.verdict) : "julgamento fora do formato"}`);
      if (passed && judged.verdict) {
        // Grava o "aprovada" deste pedido ANTES de enviar (só o gasto dos portões, não o da FASHN: esse entra no "enviada").
        await db
          .update(tryonRequests)
          .set({ verdict: { vendorJobId: request.vendorJobId, ...judged.verdict }, usdCents: request.usdCents + judged.usdCents })
          .where(and(eq(tryonRequests.id, request.id), eq(tryonRequests.status, "processing")));
        return deliver(db, deps, request, { preview: image.data, productName: product.name, credits, usdCents, verdict: judged.verdict, now: clock() });
      }
      if (request.attempts < TRYON_MAX_ATTEMPTS) {
        // Infiel: o pedido foi usado (e pago); volta à fila para outra semente.
        const requeued = await transition(
          db,
          request,
          "processing",
          "queued",
          { vendorJobId: null, credits, usdCents, verdict: judged.verdict ?? { foraDoFormato: true } },
          clock(),
        );
        if (!requeued) return { outcome: "skipped", reason: "pedido_fora_da_fila" };
        await audit(db, request, "tryon.retry", { vendorJobId: request.vendorJobId, verdict: judged.verdict ? tryOnVerdictSummary(judged.verdict) : null });
        request = requeued;
        continue;
      }
      const latest = { ...request, credits, usdCents, verdict: judged.verdict };
      await db.update(tryonRequests).set({ credits, usdCents, verdict: judged.verdict }).where(eq(tryonRequests.id, request.id));
      return failRequest(db, deps, latest, { reason: "nao_ficou_fiel", usdCents, now: clock() });
    }

    // queued
    const settings = await loadTryOnSettings(db);
    if (!settings.enabled) return failRequest(db, deps, request, { reason: "desligado", now: clock() });
    if (!product || !category) return failRequest(db, deps, request, { reason: "peca_indisponivel", now: clock() });

    ensureTime(options, clock, TRYON_TIMING.minPrepareMs);
    photo ??= await loadCustomerPhoto(db, deps, request, clock());
    if (!photo) return failRequest(db, deps, request, { reason: "foto_indisponivel", now: clock() });
    garment ??= await loadGarment(db, deps, request);
    if (!garment) return failRequest(db, deps, request, { reason: "peca_indisponivel", now: clock() });

    if (!request.photoCheck) {
      const checked = await checkPhoto(deps, photo, budgetSignal(options, clock));
      const usdCents = request.usdCents + checked.usdCents;
      if (!checked.check.success) {
        // Fora do formato: grava o gasto e relança (a fila tenta de novo; a última tentativa encerra com aviso).
        await db.update(tryonRequests).set({ usdCents }).where(eq(tryonRequests.id, request.id));
        throw new Error("a checagem da foto voltou fora do formato");
      }
      const [saved] = await db
        .update(tryonRequests)
        .set({ photoCheck: checked.check.data, usdCents, updatedAt: clock() })
        .where(and(eq(tryonRequests.id, request.id), eq(tryonRequests.status, "queued")))
        .returning();
      if (!saved) return { outcome: "skipped", reason: "pedido_fora_da_fila" };
      request = saved;
    }
    const check = photoCheckSchema.safeParse(request.photoCheck);
    const verdict = check.success ? photoCheckVerdict(check.data, category) : ({ ok: false, problem: "nao_e_foto" } as const);
    if (!verdict.ok) {
      await tellCustomer(db, deps, request, `foto:${verdict.problem}`, photoProblemText(verdict.problem, { productName: product.name, framing: requiredFraming(category) }));
      const rejected = await transition(db, request, "queued", "photo_rejected", { failureReason: verdict.problem, finishedAt: clock() }, clock());
      if (rejected) await audit(db, request, "tryon.photo_rejected", { problem: verdict.problem, check: request.photoCheck });
      return { outcome: "photo_rejected", problem: verdict.problem };
    }

    ensureTime(options, clock, TRYON_TIMING.minSubmitMs);
    const submitted = await submit(db, deps, request, { photo, garment, category, clock });
    if ("outcome" in submitted) return submitted;
    request = submitted.request;
    pendingImage = submitted.image;
  }
  // Não deveria chegar aqui: o laço tem folga para duas tentativas completas.
  throw new Error(`prévia ${requestId}: passos demais numa invocação`);
}

/**
 * Última tentativa da fila falhou (a linha vai para "morta"): o pedido não
 * pode ficar "na fila" para sempre, e a cliente não pode ficar esperando.
 */
export async function markTryOnGaveUp(db: DbOrTx, deps: TryOnDeps, input: { requestId: string; error: unknown }, now: Date): Promise<void> {
  const request = await loadRequest(db, input.requestId);
  if (!request) return;
  const detail = input.error instanceof Error ? input.error.message : String(input.error);
  const estimated = request.usdCents + creditsToUsdCents(creditsFor("tryon", "alta", 1));
  if (request.status === "queued") {
    await failRequest(db, deps, request, { reason: "indisponivel", detail, now });
  } else if (request.status === "submitting" || request.status === "processing") {
    await failRequest(db, deps, request, { reason: request.vendorJobId ? "demorou_demais" : "envio_incerto", usdCents: estimated, detail, now });
  }
}
