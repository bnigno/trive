// Ensaio "foto no corpo": a foto real da peça (esticada) vira foto dela no
// corpo de uma modelo da casa, numa cena de Belém. Casos de uso:
//
// - fotos-base das modelos (uma vez): pedir pela fila, escolher, descartar;
// - pedido de ensaio de uma peça: valida (peça elegível, foto real da cor,
//   foto-base escolhida, cota do dia) e enfileira UM evento por opção — cada
//   handler cabe no orçamento da varredura (try-on ~10 s + julgamento ~5 s);
// - a opção (handler): gera, passa pelo portão de fidelidade, aplica o
//   acabamento, guarda no Storage e grava a candidata; reprovada com
//   tentativa sobrando = evento novo com attempt+1 (registrado, não retry);
// - a escolha: a candidata vira product_images com origin = 'ai' (depois das
//   fotos reais, pareada à cor) — o card_refresh sai de addProductImage.
//
// Nunca se gera de novo depois de uma geração paga: julgamento indisponível
// deixa a candidata "sem julgamento" para a dona ver; só falha ANTES do
// vendor vai para a fila tentar de novo. Custo: cada geração e cada
// julgamento vira linha em audit_log (studio.generate / studio.judge).
import { and, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import { AssistantUnavailableError, type SalesAssistant } from "@/adapters/assistant";
import { StudioUnavailableError, type ImageStudio } from "@/adapters/image-studio";
import type { FileStorage } from "@/adapters/storage";
import { estimateUsageCostUsdCents } from "@/core/ai/model-cost";
import { normalizeAxisValue } from "@/core/catalog/attributes";
import { parsePieceType } from "@/core/catalog/piece-types";
import { findColorAxis, imagesForColor } from "@/core/catalog/product-images";
import { creditsFor, estimateRequestUsdCents, type StudioRequestEstimate } from "@/core/studio/cost";
import {
  canRetryAttempt,
  FIDELITY_JSON_SCHEMA,
  FIDELITY_SYSTEM_PROMPT,
  FIDELITY_USER_TEXT,
  fidelityJudgmentSchema,
  fidelitySummary,
  passesFidelity,
  type FidelityJudgment,
} from "@/core/studio/fidelity";
import { BODY_SIZE_KEYS, HOUSE_MODEL_KEYS, SCENE_KEYS, STUDIO_QUALITIES, type StudioQuality } from "@/core/studio/presets";
import { buildModelPhotoPrompt, buildScenePrompt, garmentCategoryFor } from "@/core/studio/prompts";
import { auditLog, outboxEvents, productImages, products, studioBasePhotos, studioCandidates, studioRequests } from "@/db/schema";
import { spDayKey, spDayStart } from "@/lib/sp-day";
import { enqueueOutboxEvent, type DbOrTx } from "@/queue/enqueue";
import { addProductImage, mdPathFor, type ServiceDb } from "@/services/catalog";
import { getSettingsMap } from "@/services/settings";
import { finishStudioImage } from "@/services/studio-finish";
import { prepareImageForModel } from "@/services/wa-media";

export const STUDIO_OPTION_EVENT = "product.ai_photo";
export const STUDIO_BASE_PHOTO_EVENT = "studio.base_photo";
/** O julgamento usa sempre o modelo mais atento: a estampa é o que está em jogo. */
export const STUDIO_JUDGE_MODEL = "claude-sonnet-5";
/** Deixa esta folga para gravar a candidata depois do vendor responder. */
const STUDIO_SAVE_RESERVE_MS = 3_000;
const DEFAULT_OPTIONS = 3;

export class ServiceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ServiceError";
    this.code = code;
  }
}

export const studioOptionPayloadSchema = z.object({
  requestId: z.uuid(),
  optionNo: z.number().int().min(1).max(4),
  attempt: z.number().int().min(0).max(3),
});
export type StudioOptionPayload = z.infer<typeof studioOptionPayloadSchema>;

export const studioBasePhotoPayloadSchema = z.object({
  modelKey: z.enum(HOUSE_MODEL_KEYS),
  sceneKey: z.enum(SCENE_KEYS),
  sizeKey: z.enum(BODY_SIZE_KEYS),
  quality: z.enum(STUDIO_QUALITIES),
  count: z.number().int().min(1).max(4),
  userId: z.uuid().nullable(),
});
export type StudioBasePhotoPayload = z.infer<typeof studioBasePhotoPayloadSchema>;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export type StudioSettings = {
  enabled: boolean;
  dailyQuota: number;
  quality: StudioQuality;
  defaultScene: (typeof SCENE_KEYS)[number];
  defaultModel: (typeof HOUSE_MODEL_KEYS)[number];
  inStore: boolean;
};

export const STUDIO_SETTING_KEYS = [
  "ai_photos_enabled",
  "ai_photos_daily_quota",
  "ai_photos_quality",
  "ai_photos_default_scene",
  "ai_photos_default_model",
  "ai_photos_in_store",
] as const;

export async function loadStudioSettings(db: DbOrTx): Promise<StudioSettings> {
  const map = await getSettingsMap(db, [...STUDIO_SETTING_KEYS]);
  const quality = map["ai_photos_quality"];
  const scene = map["ai_photos_default_scene"];
  const model = map["ai_photos_default_model"];
  return {
    enabled: map["ai_photos_enabled"] === true,
    dailyQuota: typeof map["ai_photos_daily_quota"] === "number" ? map["ai_photos_daily_quota"] : 30,
    quality: quality === "alta" ? "alta" : "economica",
    defaultScene: SCENE_KEYS.find((key) => key === scene) ?? "sala_clara",
    defaultModel: HOUSE_MODEL_KEYS.find((key) => key === model) ?? "modelo_a",
    inStore: map["ai_photos_in_store"] === true,
  };
}

export async function isAiPhotosEnabled(db: DbOrTx): Promise<boolean> {
  return (await loadStudioSettings(db)).enabled;
}

export async function isAiPhotosInStore(db: DbOrTx): Promise<boolean> {
  return (await loadStudioSettings(db)).inStore;
}

// ---------------------------------------------------------------------------
// Cota e custo
// ---------------------------------------------------------------------------

/** Imagens pagas hoje (dia de São Paulo): candidatas e fotos-base — o fato do vendor, não os pedidos. */
export async function countStudioImagesToday(db: DbOrTx, now: Date): Promise<number> {
  const since = spDayStart(spDayKey(now));
  const [candidates] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(studioCandidates)
    .where(and(gte(studioCandidates.createdAt, since), sql`${studioCandidates.storagePath} IS NOT NULL`));
  const [bases] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(studioBasePhotos)
    .where(gte(studioBasePhotos.createdAt, since));
  return (candidates?.n ?? 0) + (bases?.n ?? 0);
}

export type StudioCostSummary = { images: number; usdCents: number };

/** Gasto do ensaio no período (candidatas + fotos-base), para o painel e o "Bom dia". */
export async function summarizeStudioCosts(db: DbOrTx, range: { from: Date; to: Date }): Promise<StudioCostSummary> {
  const [candidates] = await db
    .select({ n: sql<number>`count(*)::int`, usd: sql<number>`coalesce(sum(${studioCandidates.usdCents}), 0)::int` })
    .from(studioCandidates)
    .where(and(gte(studioCandidates.createdAt, range.from), sql`${studioCandidates.createdAt} < ${range.to}`));
  const [bases] = await db
    .select({ n: sql<number>`count(*)::int`, usd: sql<number>`coalesce(sum(${studioBasePhotos.usdCents}), 0)::int` })
    .from(studioBasePhotos)
    .where(and(gte(studioBasePhotos.createdAt, range.from), sql`${studioBasePhotos.createdAt} < ${range.to}`));
  return { images: (candidates?.n ?? 0) + (bases?.n ?? 0), usdCents: (candidates?.usd ?? 0) + (bases?.usd ?? 0) };
}

// ---------------------------------------------------------------------------
// Fotos-base das modelos da casa
// ---------------------------------------------------------------------------

export type StudioBasePhoto = typeof studioBasePhotos.$inferSelect;

export function studioBasePhotoStoragePath(input: { modelKey: string; sceneKey: string; sizeKey: string; at: Date; index: number }): string {
  return `studio/models/${input.modelKey}/${input.sceneKey}-${input.sizeKey}-${input.at.getTime()}-${input.index + 1}.jpg`;
}

/** Pede N candidatas de foto-base pela fila (a geração leva dezenas de segundos). */
export async function enqueueStudioBasePhotos(
  db: DbOrTx,
  input: Omit<StudioBasePhotoPayload, "userId"> & { userId: string | null },
  now = new Date(),
): Promise<string | null> {
  const payload = studioBasePhotoPayloadSchema.parse(input);
  return enqueueOutboxEvent(db, {
    eventType: STUDIO_BASE_PHOTO_EVENT,
    dedupeKey: `${STUDIO_BASE_PHOTO_EVENT}:${payload.modelKey}:${payload.sceneKey}:${payload.sizeKey}:${now.getTime()}`,
    aggregateType: "studio_base_photo",
    payload,
  });
}

export type StudioDeps = {
  studio: ImageStudio;
  assistant: SalesAssistant;
  storage: FileStorage;
};

export type StudioBasePhotoResult =
  | { outcome: "generated"; ids: string[] }
  | { outcome: "failed"; reason: string };

/** Handler de studio.base_photo: gera, guarda no Storage e grava as candidatas. */
export async function generateStudioBasePhotos(
  db: DbOrTx,
  deps: Pick<StudioDeps, "studio" | "storage">,
  rawPayload: unknown,
  options: { now?: () => Date; deadlineAt?: Date } = {},
): Promise<StudioBasePhotoResult> {
  const payload = studioBasePhotoPayloadSchema.parse(rawPayload);
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  let photos;
  try {
    photos = await deps.studio.createModelPhoto({
      prompt: buildModelPhotoPrompt(payload),
      aspectRatio: "3:4",
      count: payload.count,
      quality: payload.quality,
      seed: startedAt.getTime() % 100_000,
      signal: budgetSignal(options.deadlineAt, now()),
    });
  } catch (error) {
    if (error instanceof StudioUnavailableError && !error.retryable) {
      await db.insert(auditLog).values({
        actorType: "system",
        actorId: null,
        action: "studio.base_photo",
        entityType: "studio_base_photo",
        entityId: null,
        after: { ...payload, failed: error.reason, message: error.message },
      });
      return { outcome: "failed", reason: error.reason };
    }
    throw error;
  }
  const ids: string[] = [];
  for (const [index, photo] of photos.entries()) {
    const path = studioBasePhotoStoragePath({ ...payload, at: startedAt, index });
    await deps.storage.upload({ path, data: photo.data, contentType: photo.mimeType });
    const [row] = await db
      .insert(studioBasePhotos)
      .values({
        modelKey: payload.modelKey,
        sceneKey: payload.sceneKey,
        sizeKey: payload.sizeKey,
        storagePath: path,
        vendor: photo.vendor,
        vendorModel: photo.vendorModel,
        seed: photo.seed,
        credits: photo.creditsUsed,
        usdCents: photo.usdCents,
        createdBy: payload.userId,
        createdAt: now(),
      })
      .returning({ id: studioBasePhotos.id });
    ids.push(row!.id);
  }
  await db.insert(auditLog).values({
    actorType: payload.userId ? "user" : "system",
    actorId: payload.userId,
    action: "studio.base_photo",
    entityType: "studio_base_photo",
    entityId: ids.join(","),
    after: {
      modelKey: payload.modelKey,
      sceneKey: payload.sceneKey,
      sizeKey: payload.sizeKey,
      quality: payload.quality,
      count: photos.length,
      vendor: photos[0]?.vendor,
      vendorModel: photos[0]?.vendorModel,
      credits: photos.reduce((sum, photo) => sum + photo.creditsUsed, 0),
      estimatedCostUsdCents: photos.reduce((sum, photo) => sum + photo.usdCents, 0),
      elapsedMs: photos[0]?.elapsedMs ?? 0,
    },
  });
  return { outcome: "generated", ids };
}

/** Pedidos de foto-base ainda na fila, por modelo × cena × corpo — a tela mostra "gerando…". */
export async function listPendingStudioBasePhotoJobs(db: DbOrTx): Promise<Set<string>> {
  const rows = await db
    .select({ payload: outboxEvents.payload })
    .from(outboxEvents)
    .where(and(eq(outboxEvents.eventType, STUDIO_BASE_PHOTO_EVENT), inArray(outboxEvents.status, ["pending", "processing", "failed"])));
  const keys = new Set<string>();
  for (const row of rows) {
    const parsed = studioBasePhotoPayloadSchema.safeParse(row.payload);
    if (parsed.success) keys.add(studioBaseKey(parsed.data));
  }
  return keys;
}

export function studioBaseKey(keys: { modelKey: string; sceneKey: string; sizeKey: string }): string {
  return `${keys.modelKey}:${keys.sceneKey}:${keys.sizeKey}`;
}

export async function listStudioBasePhotos(db: DbOrTx): Promise<StudioBasePhoto[]> {
  return db
    .select()
    .from(studioBasePhotos)
    .where(inArray(studioBasePhotos.status, ["candidate", "chosen"]))
    .orderBy(studioBasePhotos.modelKey, studioBasePhotos.sceneKey, studioBasePhotos.sizeKey, desc(studioBasePhotos.createdAt));
}

export async function getChosenBasePhoto(
  db: DbOrTx,
  keys: { modelKey: string; sceneKey: string; sizeKey: string },
): Promise<StudioBasePhoto | null> {
  const [row] = await db
    .select()
    .from(studioBasePhotos)
    .where(
      and(
        eq(studioBasePhotos.modelKey, keys.modelKey),
        eq(studioBasePhotos.sceneKey, keys.sceneKey),
        eq(studioBasePhotos.sizeKey, keys.sizeKey),
        eq(studioBasePhotos.status, "chosen"),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** A escolhida anterior da mesma modelo × cena × corpo volta a candidata (dá para trocar de volta). */
export async function chooseStudioBasePhoto(db: DbOrTx, input: { id: string; userId: string }, now = new Date()): Promise<void> {
  const { id, userId } = z.object({ id: z.uuid(), userId: z.uuid() }).parse(input);
  await db.transaction(async (tx) => {
    const [photo] = await tx.select().from(studioBasePhotos).where(eq(studioBasePhotos.id, id)).limit(1);
    if (!photo || photo.status === "discarded") throw new ServiceError("nao_encontrada", "Foto-base não encontrada.");
    if (photo.status === "chosen") return;
    await tx
      .update(studioBasePhotos)
      .set({ status: "candidate", chosenAt: null })
      .where(
        and(
          eq(studioBasePhotos.modelKey, photo.modelKey),
          eq(studioBasePhotos.sceneKey, photo.sceneKey),
          eq(studioBasePhotos.sizeKey, photo.sizeKey),
          eq(studioBasePhotos.status, "chosen"),
        ),
      );
    await tx.update(studioBasePhotos).set({ status: "chosen", chosenAt: now }).where(eq(studioBasePhotos.id, id));
    await tx.insert(auditLog).values({
      actorType: "user",
      actorId: userId,
      action: "studio.base_photo_choose",
      entityType: "studio_base_photo",
      entityId: id,
      after: { modelKey: photo.modelKey, sceneKey: photo.sceneKey, sizeKey: photo.sizeKey },
    });
  });
}

export async function discardStudioBasePhoto(db: DbOrTx, input: { id: string; userId: string }): Promise<void> {
  const { id, userId } = z.object({ id: z.uuid(), userId: z.uuid() }).parse(input);
  await db.transaction(async (tx) => {
    const [photo] = await tx.select().from(studioBasePhotos).where(eq(studioBasePhotos.id, id)).limit(1);
    if (!photo) throw new ServiceError("nao_encontrada", "Foto-base não encontrada.");
    if (photo.status === "discarded") return;
    await tx.update(studioBasePhotos).set({ status: "discarded", chosenAt: null }).where(eq(studioBasePhotos.id, id));
    await tx.insert(auditLog).values({
      actorType: "user",
      actorId: userId,
      action: "studio.base_photo_discard",
      entityType: "studio_base_photo",
      entityId: id,
      after: { modelKey: photo.modelKey, sceneKey: photo.sceneKey, sizeKey: photo.sizeKey, wasChosen: photo.status === "chosen" },
    });
  });
}

// ---------------------------------------------------------------------------
// Pedido de ensaio de uma peça
// ---------------------------------------------------------------------------

const requestStudioPhotosSchema = z.object({
  productId: z.uuid(),
  /** Cor da grade; ausente = peça sem eixo de cor (ou a foto do produto inteiro). */
  color: z.string().trim().min(1).nullable().default(null),
  sceneKey: z.enum(SCENE_KEYS),
  modelKey: z.enum(HOUSE_MODEL_KEYS),
  sizeKey: z.enum(BODY_SIZE_KEYS).default("M"),
  quality: z.enum(STUDIO_QUALITIES),
  options: z.number().int().min(1).max(4).default(DEFAULT_OPTIONS),
  userId: z.uuid().nullable().default(null),
  source: z.enum(["admin", "atelier", "auto"]).default("admin"),
});
export type RequestStudioPhotosInput = z.input<typeof requestStudioPhotosSchema>;

export type StudioRequestCreated = {
  requestId: string;
  estimate: StudioRequestEstimate;
  eventIds: string[];
};

type ProductForStudio = {
  id: string;
  name: string;
  pieceType: string | null;
  attributesSchema: unknown;
};

async function requireProductForStudio(db: DbOrTx, productId: string): Promise<ProductForStudio> {
  const [product] = await db
    .select({ id: products.id, name: products.name, pieceType: products.pieceType, attributesSchema: products.attributesSchema })
    .from(products)
    .where(and(eq(products.id, productId), isNull(products.deletedAt)))
    .limit(1);
  if (!product) throw new ServiceError("nao_encontrado", "Peça não encontrada.");
  return product;
}

/** A foto REAL da cor (ou do produto inteiro) que o try-on vai transferir. */
async function garmentImageFor(db: DbOrTx, productId: string, color: string | null): Promise<{ id: string; storagePath: string } | null> {
  const rows = await db
    .select({ id: productImages.id, storagePath: productImages.storagePath, color: productImages.color })
    .from(productImages)
    .where(and(eq(productImages.productId, productId), eq(productImages.origin, "upload")))
    .orderBy(productImages.sortOrder, productImages.createdAt);
  const ordered = imagesForColor(rows, color);
  const first = ordered[0];
  return first ? { id: first.id, storagePath: first.storagePath } : null;
}

/**
 * Valida tudo ANTES de gastar: recurso ligado, peça elegível (tipo com
 * ensaio), foto real da cor, foto-base escolhida e cota do dia. Cria o
 * pedido e um evento por opção na mesma transação.
 */
export async function requestStudioPhotos(db: DbOrTx, input: RequestStudioPhotosInput, now = new Date()): Promise<StudioRequestCreated> {
  const parsed = requestStudioPhotosSchema.parse(input);
  const settings = await loadStudioSettings(db);
  if (!settings.enabled) throw new ServiceError("desligado", "A foto no corpo está desligada. Ligue em Vendedora & WhatsApp.");

  const product = await requireProductForStudio(db, parsed.productId);
  const category = garmentCategoryFor(parsePieceType(product.pieceType ?? ""));
  if (!category) {
    throw new ServiceError(
      "peca_sem_ensaio",
      "Esta peça não tem ensaio: marque o tipo (vestido, blusa, saia…) na ficha — acessórios não vestem.",
    );
  }
  const colorAxis = findColorAxis(product.attributesSchema);
  const color = colorAxis && parsed.color ? normalizeAxisValue(parsed.color) : null;
  const garment = await garmentImageFor(db, product.id, color);
  if (!garment) {
    throw new ServiceError("sem_foto_real", color ? `Suba uma foto real da cor ${color} antes do ensaio.` : "Suba uma foto real da peça antes do ensaio.");
  }
  const base = await getChosenBasePhoto(db, parsed);
  if (!base) {
    throw new ServiceError("sem_foto_base", "Escolha a foto-base desta modelo nesta cena e neste corpo em Modelos da casa.");
  }
  const used = await countStudioImagesToday(db, now);
  if (used + parsed.options > settings.dailyQuota) {
    throw new ServiceError("cota_do_dia", `A cota de hoje (${settings.dailyQuota} imagens) não comporta mais ${parsed.options}: já foram ${used}.`);
  }
  const estimate = estimateRequestUsdCents({ options: parsed.options, quality: parsed.quality });

  return db.transaction(async (tx) => {
    const [request] = await tx
      .insert(studioRequests)
      .values({
        productId: product.id,
        color,
        sceneKey: parsed.sceneKey,
        modelKey: parsed.modelKey,
        sizeKey: parsed.sizeKey,
        quality: parsed.quality,
        optionsWanted: parsed.options,
        source: parsed.source,
        requestedBy: parsed.userId,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: studioRequests.id });
    const requestId = request!.id;
    const eventIds: string[] = [];
    for (let optionNo = 1; optionNo <= parsed.options; optionNo += 1) {
      const eventId = await enqueueStudioOption(tx, { requestId, optionNo, attempt: 0 }, product.id);
      if (eventId) eventIds.push(eventId);
    }
    await tx.insert(auditLog).values({
      actorType: parsed.userId ? "user" : "system",
      actorId: parsed.userId,
      action: "studio.request",
      entityType: "studio_request",
      entityId: requestId,
      after: {
        productId: product.id,
        color,
        sceneKey: parsed.sceneKey,
        modelKey: parsed.modelKey,
        sizeKey: parsed.sizeKey,
        quality: parsed.quality,
        options: parsed.options,
        source: parsed.source,
        estimatedUsdCents: estimate.totalUsdCents,
      },
    });
    return { requestId, estimate, eventIds };
  });
}

async function enqueueStudioOption(db: DbOrTx, payload: StudioOptionPayload, productId: string): Promise<string | null> {
  return enqueueOutboxEvent(db, {
    eventType: STUDIO_OPTION_EVENT,
    dedupeKey: `${STUDIO_OPTION_EVENT}:${payload.requestId}:${payload.optionNo}:${payload.attempt}`,
    aggregateType: "product",
    aggregateId: productId,
    payload,
  });
}

// ---------------------------------------------------------------------------
// A opção (handler de product.ai_photo)
// ---------------------------------------------------------------------------

export type StudioOptionResult =
  | { outcome: "passed" | "rejected" | "unjudged"; candidateId: string; retryEnqueued: boolean }
  | { outcome: "failed"; candidateId: string; reason: string }
  | { outcome: "skipped"; reason: "pedido_nao_encontrado" | "pedido_encerrado" | "ja_processada" };

export function studioCandidateStoragePath(input: { productId: string; requestId: string; optionNo: number; attempt: number }): string {
  return `studio/products/${input.productId}/${input.requestId}-${input.optionNo}-${input.attempt}.jpg`;
}

function budgetSignal(deadlineAt: Date | undefined, now: Date): AbortSignal | undefined {
  if (!deadlineAt) return undefined;
  const ms = deadlineAt.getTime() - now.getTime() - STUDIO_SAVE_RESERVE_MS;
  return AbortSignal.timeout(Math.max(1_000, ms));
}

/** Semente determinística por opção e tentativa: a repetição sai diferente da primeira. */
export function studioSeedFor(optionNo: number, attempt: number): number {
  return 1_000 + optionNo * 100 + attempt;
}

type JudgeOutcome =
  | { judgment: FidelityJudgment; usdCents: number; usage: unknown; ms: number; failed: null }
  | { judgment: null; usdCents: number; usage: unknown; ms: number; failed: string };

async function judgeCandidate(
  assistant: SalesAssistant,
  garment: Buffer,
  candidate: Buffer,
  signal: AbortSignal | undefined,
): Promise<JudgeOutcome> {
  const started = Date.now();
  try {
    const [original, generated] = await Promise.all([prepareImageForModel(garment), prepareImageForModel(candidate)]);
    const result = await assistant.extractFromPhotos({
      system: FIDELITY_SYSTEM_PROMPT,
      images: [
        { mediaType: original.mediaType, base64: original.base64 },
        { mediaType: generated.mediaType, base64: generated.base64 },
      ],
      userText: FIDELITY_USER_TEXT,
      model: STUDIO_JUDGE_MODEL,
      jsonSchema: FIDELITY_JSON_SCHEMA,
      maxTokens: 512,
      signal,
    });
    const usdCents = estimateUsageCostUsdCents(result.usage, STUDIO_JUDGE_MODEL);
    const parsed = fidelityJudgmentSchema.safeParse(result.json);
    if (!parsed.success) return { judgment: null, usdCents, usage: result.usage, ms: Date.now() - started, failed: "json_invalido" };
    return { judgment: parsed.data, usdCents, usage: result.usage, ms: Date.now() - started, failed: null };
  } catch (error) {
    const reason = error instanceof AssistantUnavailableError ? error.reason : error instanceof Error ? error.message : "erro";
    return { judgment: null, usdCents: 0, usage: null, ms: Date.now() - started, failed: reason };
  }
}

/**
 * Uma opção do pedido, de ponta a ponta. Idempotente pelo UNIQUE
 * (request, option, attempt): o mesmo evento duas vezes = uma candidata.
 * Falha do vendor passageira (rede, 429, 5xx) relança ANTES de gastar —
 * a fila tenta de novo; falha definitiva (sem crédito, recusada) vira
 * candidata "failed" e o pedido segue.
 */
export async function generateStudioOption(
  db: DbOrTx,
  deps: StudioDeps,
  rawPayload: unknown,
  options: { now?: () => Date; deadlineAt?: Date } = {},
): Promise<StudioOptionResult> {
  const payload = studioOptionPayloadSchema.parse(rawPayload);
  const now = options.now ?? (() => new Date());

  const [request] = await db.select().from(studioRequests).where(eq(studioRequests.id, payload.requestId)).limit(1);
  if (!request) return { outcome: "skipped", reason: "pedido_nao_encontrado" };
  if (request.status !== "queued") return { outcome: "skipped", reason: "pedido_encerrado" };
  const [existing] = await db
    .select({ id: studioCandidates.id })
    .from(studioCandidates)
    .where(and(eq(studioCandidates.requestId, request.id), eq(studioCandidates.optionNo, payload.optionNo), eq(studioCandidates.attempt, payload.attempt)))
    .limit(1);
  if (existing) return { outcome: "skipped", reason: "ja_processada" };

  // O que mudou desde o pedido (peça apagada, foto real removida, foto-base
  // descartada) fecha a opção como falha, sem gastar e sem ir para a DLQ.
  let product: ProductForStudio;
  try {
    product = await requireProductForStudio(db, request.productId);
  } catch (error) {
    if (error instanceof ServiceError) return finishOptionWithFailure(db, request, payload, now(), "peca_nao_encontrada");
    throw error;
  }
  const category = garmentCategoryFor(parsePieceType(product.pieceType ?? "")) ?? "auto";
  const garment = await garmentImageFor(db, product.id, request.color);
  const base = await getChosenBasePhoto(db, request);
  if (!garment || !base) {
    return finishOptionWithFailure(db, request, payload, now(), !garment ? "sem_foto_real" : "sem_foto_base");
  }

  const [garmentFile, baseFile] = await Promise.all([downloadGarment(deps.storage, garment.storagePath), deps.storage.download(base.storagePath)]);
  const quality = request.quality === "alta" ? "alta" : "economica";
  const seed = studioSeedFor(payload.optionNo, payload.attempt);
  const startedAt = now();
  let image;
  try {
    [image] = await deps.studio.generateOnModel({
      garment: { data: garmentFile.data, mimeType: garmentFile.mimeType },
      model: { data: baseFile.data, mimeType: mimeOf(baseFile.contentType) },
      category,
      scenePrompt: buildScenePrompt(request.sceneKey),
      count: 1,
      quality,
      seed,
      signal: budgetSignal(options.deadlineAt, startedAt),
    });
  } catch (error) {
    if (error instanceof StudioUnavailableError && !error.retryable) {
      return finishOptionWithFailure(db, request, payload, now(), `${error.reason}: ${error.message}`);
    }
    throw error;
  }
  if (!image) return finishOptionWithFailure(db, request, payload, now(), "vendor_sem_imagem");

  // Daqui em diante nada relança de propósito: a geração já foi paga.
  // (Só o upload no Storage ainda pode lançar — e aí a fila repete a opção.)
  let finished: Buffer;
  try {
    finished = await finishStudioImage(image.data);
  } catch {
    return finishOptionWithFailure(db, request, payload, now(), "imagem_ilegivel");
  }
  const judged = await judgeCandidate(deps.assistant, garmentFile.data, image.data, budgetSignal(options.deadlineAt, now()));
  const passed = judged.judgment ? passesFidelity(judged.judgment) : false;
  const path = studioCandidateStoragePath({ productId: product.id, requestId: request.id, optionNo: payload.optionNo, attempt: payload.attempt });
  await deps.storage.upload({ path, data: finished, contentType: "image/jpeg" });

  const status = judged.judgment ? (passed ? "candidate" : "rejected") : "candidate";
  const retry = status === "rejected" && canRetryAttempt(payload.attempt);
  const usdCents = image.usdCents + judged.usdCents;

  return db.transaction(async (tx) => {
    const [candidate] = await tx
      .insert(studioCandidates)
      .values({
        requestId: request.id,
        optionNo: payload.optionNo,
        attempt: payload.attempt,
        storagePath: path,
        judgment: judged.judgment,
        score: judged.judgment?.nota ?? null,
        passed,
        status,
        vendor: image.vendor,
        vendorModel: image.vendorModel,
        seed: image.seed,
        usdCents,
        errorDetail: judged.failed ? `portao_indisponivel: ${judged.failed}` : null,
        createdAt: now(),
      })
      .onConflictDoNothing({ target: [studioCandidates.requestId, studioCandidates.optionNo, studioCandidates.attempt] })
      .returning({ id: studioCandidates.id });
    if (!candidate) {
      // Corrida perdida para outra execução do mesmo evento: a dela vale.
      await deps.storage.remove(path).catch(() => undefined);
      return { outcome: "skipped", reason: "ja_processada" } as const;
    }
    await tx.insert(auditLog).values([
      {
        actorType: "system",
        actorId: null,
        action: "studio.generate",
        entityType: "studio_candidate",
        entityId: candidate.id,
        after: {
          requestId: request.id,
          productId: product.id,
          optionNo: payload.optionNo,
          attempt: payload.attempt,
          vendor: image.vendor,
          vendorModel: image.vendorModel,
          quality,
          credits: image.creditsUsed,
          estimatedCostUsdCents: image.usdCents,
          elapsedMs: image.elapsedMs,
          seed: image.seed,
        },
      },
      {
        actorType: "system",
        actorId: null,
        action: "studio.judge",
        entityType: "studio_candidate",
        entityId: candidate.id,
        after: {
          requestId: request.id,
          model: STUDIO_JUDGE_MODEL,
          usage: judged.usage,
          estimatedCostUsdCents: judged.usdCents,
          elapsedMs: judged.ms,
          passed,
          summary: judged.judgment ? fidelitySummary(judged.judgment) : null,
          failed: judged.failed,
        },
      },
    ]);
    if (retry) {
      await enqueueStudioOption(tx, { requestId: request.id, optionNo: payload.optionNo, attempt: payload.attempt + 1 }, product.id);
    }
    await settleRequest(tx, request.id, { usdCents, optionDone: !retry, now: now() });
    return {
      outcome: judged.judgment ? (passed ? "passed" : "rejected") : "unjudged",
      candidateId: candidate.id,
      retryEnqueued: retry,
    } as const;
  });
}

async function finishOptionWithFailure(
  db: DbOrTx,
  request: typeof studioRequests.$inferSelect,
  payload: StudioOptionPayload,
  now: Date,
  reason: string,
): Promise<StudioOptionResult> {
  return db.transaction(async (tx) => {
    const [candidate] = await tx
      .insert(studioCandidates)
      .values({
        requestId: request.id,
        optionNo: payload.optionNo,
        attempt: payload.attempt,
        status: "failed",
        errorDetail: reason.slice(0, 500),
        createdAt: now,
      })
      .onConflictDoNothing({ target: [studioCandidates.requestId, studioCandidates.optionNo, studioCandidates.attempt] })
      .returning({ id: studioCandidates.id });
    if (!candidate) return { outcome: "skipped", reason: "ja_processada" } as const;
    await tx.insert(auditLog).values({
      actorType: "system",
      actorId: null,
      action: "studio.generate",
      entityType: "studio_candidate",
      entityId: candidate.id,
      after: { requestId: request.id, productId: request.productId, optionNo: payload.optionNo, attempt: payload.attempt, failed: reason },
    });
    await settleRequest(tx, request.id, { usdCents: 0, optionDone: true, now });
    return { outcome: "failed", candidateId: candidate.id, reason } as const;
  });
}

/** Soma o gasto e, quando a última opção termina, fecha o pedido — numa única UPDATE. */
async function settleRequest(tx: DbOrTx, requestId: string, input: { usdCents: number; optionDone: boolean; now: Date }): Promise<void> {
  const doneIncrement = input.optionDone ? 1 : 0;
  await tx
    .update(studioRequests)
    .set({
      usdCentsSpent: sql`${studioRequests.usdCentsSpent} + ${input.usdCents}`,
      optionsDone: sql`${studioRequests.optionsDone} + ${doneIncrement}`,
      status: sql`case when ${studioRequests.optionsDone} + ${doneIncrement} >= ${studioRequests.optionsWanted} then 'done' else ${studioRequests.status} end`,
      finishedAt: sql`case when ${studioRequests.optionsDone} + ${doneIncrement} >= ${studioRequests.optionsWanted} then ${input.now} else ${studioRequests.finishedAt} end`,
      updatedAt: input.now,
    })
    .where(eq(studioRequests.id, requestId));
}

async function downloadGarment(storage: FileStorage, storagePath: string): Promise<{ data: Buffer; mimeType: "image/webp" | "image/jpeg" | "image/png" }> {
  // A rendição média (800 px) basta para o try-on e pesa 4× menos que a full.
  try {
    const md = await storage.download(mdPathFor(storagePath));
    return { data: md.data, mimeType: mimeOf(md.contentType) };
  } catch {
    const full = await storage.download(storagePath);
    return { data: full.data, mimeType: mimeOf(full.contentType) };
  }
}

function mimeOf(contentType: string | null): "image/webp" | "image/jpeg" | "image/png" {
  if (contentType?.includes("webp")) return "image/webp";
  if (contentType?.includes("png")) return "image/png";
  return "image/jpeg";
}

// ---------------------------------------------------------------------------
// A escolha
// ---------------------------------------------------------------------------

/**
 * A candidata vira foto da peça: origin = 'ai', pareada à cor do pedido,
 * depois das fotos reais (sort_order é append-only). addProductImage já
 * enfileira o card_refresh do post/story/carrossel.
 */
export async function chooseStudioCandidate(
  db: DbOrTx,
  storage: FileStorage,
  input: { candidateId: string; userId: string },
): Promise<{ imageId: string; productId: string }> {
  const { candidateId, userId } = z.object({ candidateId: z.uuid(), userId: z.uuid() }).parse(input);
  const [row] = await db
    .select({ candidate: studioCandidates, request: studioRequests })
    .from(studioCandidates)
    .innerJoin(studioRequests, eq(studioRequests.id, studioCandidates.requestId))
    .where(eq(studioCandidates.id, candidateId))
    .limit(1);
  if (!row) throw new ServiceError("nao_encontrada", "Opção não encontrada.");
  if (row.candidate.chosenImageId) return { imageId: row.candidate.chosenImageId, productId: row.request.productId };
  if (row.candidate.status !== "candidate" || !row.candidate.storagePath) {
    throw new ServiceError("candidata_indisponivel", "Esta opção não pode ser escolhida (reprovada, descartada ou sem imagem).");
  }
  const file = await storage.download(row.candidate.storagePath);
  // Uma transação só (addProductImage aninha a dele por savepoint): a foto
  // da peça e a marcação da candidata existem juntas ou não existem.
  return db.transaction(async (tx) => {
    const image = await addProductImage(tx as unknown as ServiceDb, storage, {
      productId: row.request.productId,
      data: file.data,
      contentType: "image/jpeg",
      color: row.request.color ?? undefined,
      origin: "ai",
      userId,
    });
    await tx
      .update(studioCandidates)
      .set({ status: "chosen", chosenImageId: image.id })
      .where(eq(studioCandidates.id, candidateId));
    await tx.insert(auditLog).values({
      actorType: "user",
      actorId: userId,
      action: "studio.choose",
      entityType: "product_image",
      entityId: image.id,
      after: { candidateId, requestId: row.request.id, productId: row.request.productId, color: row.request.color, storagePath: image.storagePath },
    });
    return { imageId: image.id, productId: row.request.productId };
  });
}

export async function discardStudioCandidate(db: DbOrTx, input: { candidateId: string; userId: string }): Promise<void> {
  const { candidateId, userId } = z.object({ candidateId: z.uuid(), userId: z.uuid() }).parse(input);
  await db.transaction(async (tx) => {
    const [candidate] = await tx.select().from(studioCandidates).where(eq(studioCandidates.id, candidateId)).limit(1);
    if (!candidate) throw new ServiceError("nao_encontrada", "Opção não encontrada.");
    if (candidate.status === "chosen") throw new ServiceError("ja_escolhida", "Esta opção já virou foto da peça; remova a foto na galeria.");
    if (candidate.status === "discarded") return;
    await tx.update(studioCandidates).set({ status: "discarded" }).where(eq(studioCandidates.id, candidateId));
    await tx.insert(auditLog).values({
      actorType: "user",
      actorId: userId,
      action: "studio.discard",
      entityType: "studio_candidate",
      entityId: candidateId,
      after: { requestId: candidate.requestId, was: candidate.status },
    });
  });
}

// ---------------------------------------------------------------------------
// Leitura para o painel
// ---------------------------------------------------------------------------

export type StudioRequestView = typeof studioRequests.$inferSelect & {
  candidates: (typeof studioCandidates.$inferSelect)[];
};

export async function listStudioRequestsForProduct(db: DbOrTx, productId: string, limit = 5): Promise<StudioRequestView[]> {
  const requests = await db
    .select()
    .from(studioRequests)
    .where(eq(studioRequests.productId, productId))
    .orderBy(desc(studioRequests.createdAt))
    .limit(limit);
  if (requests.length === 0) return [];
  const candidates = await db
    .select()
    .from(studioCandidates)
    .where(inArray(studioCandidates.requestId, requests.map((request) => request.id)))
    .orderBy(studioCandidates.optionNo, studioCandidates.attempt);
  return requests.map((request) => ({ ...request, candidates: candidates.filter((candidate) => candidate.requestId === request.id) }));
}

/** Quanto custaria um pedido com os padrões atuais — para o botão da tela. */
export async function estimateStudioRequest(db: DbOrTx, options = DEFAULT_OPTIONS): Promise<{ quality: StudioQuality; estimate: StudioRequestEstimate; creditsPerImage: number }> {
  const settings = await loadStudioSettings(db);
  return {
    quality: settings.quality,
    estimate: estimateRequestUsdCents({ options, quality: settings.quality }),
    creditsPerImage: creditsFor("tryon", settings.quality, 1),
  };
}
