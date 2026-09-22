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
// Este módulo é LEVE de propósito (páginas e server actions o importam): o
// que gera — vendor, portão, acabamento com sharp — mora em
// services/studio-generate.ts e só a fila o carrega.
import { and, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import type { FileStorage } from "@/adapters/storage";
import { normalizeAxisValue } from "@/core/catalog/attributes";
import { parsePieceType } from "@/core/catalog/piece-types";
import { findColorAxis, imagesForColor } from "@/core/catalog/product-images";
import { creditsFor, estimateRequestUsdCents, type StudioRequestEstimate } from "@/core/studio/cost";
import { BODY_SIZE_KEYS, HOUSE_MODEL_KEYS, SCENE_KEYS, STUDIO_QUALITIES, type StudioQuality } from "@/core/studio/presets";
import { garmentCategoryFor } from "@/core/studio/prompts";
import { auditLog, outboxEvents, productImages, products, studioBasePhotos, studioCandidates, studioRequests } from "@/db/schema";
import { spDayKey, spDayStart } from "@/lib/sp-day";
import { enqueueOutboxEvent, type DbOrTx } from "@/queue/enqueue";
import { addProductImage, type ServiceDb } from "@/services/catalog";
import { loadStudioSettings } from "@/services/studio-settings";

export const STUDIO_OPTION_EVENT = "product.ai_photo";
export const STUDIO_BASE_PHOTO_EVENT = "studio.base_photo";
const DEFAULT_OPTIONS = 2;

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
// Settings: em services/studio-settings.ts (módulo leve, para as páginas).
// ---------------------------------------------------------------------------

export { isAiPhotosEnabled, isAiPhotosInStore, loadStudioSettings, STUDIO_SETTING_KEYS, type StudioSettings } from "@/services/studio-settings";

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

/**
 * Pede N candidatas de foto-base pela fila (a geração leva dezenas de
 * segundos). `nextAttemptAt` espaça vários pedidos: a FASHN limita chamadas
 * simultâneas da conta e a fila pegaria todos de uma vez.
 */
export async function enqueueStudioBasePhotos(
  db: DbOrTx,
  input: Omit<StudioBasePhotoPayload, "userId"> & { userId: string | null },
  now = new Date(),
  options: { nextAttemptAt?: Date } = {},
): Promise<string | null> {
  const payload = studioBasePhotoPayloadSchema.parse(input);
  return enqueueOutboxEvent(db, {
    eventType: STUDIO_BASE_PHOTO_EVENT,
    dedupeKey: `${STUDIO_BASE_PHOTO_EVENT}:${payload.modelKey}:${payload.sceneKey}:${payload.sizeKey}:${now.getTime()}`,
    aggregateType: "studio_base_photo",
    payload,
    ...(options.nextAttemptAt ? { nextAttemptAt: options.nextAttemptAt } : {}),
  });
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

export type ProductForStudio = {
  id: string;
  name: string;
  pieceType: string | null;
  attributesSchema: unknown;
};

export async function requireProductForStudio(db: DbOrTx, productId: string): Promise<ProductForStudio> {
  const [product] = await db
    .select({ id: products.id, name: products.name, pieceType: products.pieceType, attributesSchema: products.attributesSchema })
    .from(products)
    .where(and(eq(products.id, productId), isNull(products.deletedAt)))
    .limit(1);
  if (!product) throw new ServiceError("nao_encontrado", "Peça não encontrada.");
  return product;
}

/** A foto REAL da cor (ou do produto inteiro) que o try-on vai transferir. */
export async function garmentImageFor(db: DbOrTx, productId: string, color: string | null): Promise<{ id: string; storagePath: string } | null> {
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

export async function enqueueStudioOption(db: DbOrTx, payload: StudioOptionPayload, productId: string): Promise<string | null> {
  return enqueueOutboxEvent(db, {
    eventType: STUDIO_OPTION_EVENT,
    dedupeKey: `${STUDIO_OPTION_EVENT}:${payload.requestId}:${payload.optionNo}:${payload.attempt}`,
    aggregateType: "product",
    aggregateId: productId,
    payload,
  });
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
