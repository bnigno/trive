// O que GERA no ensaio "foto no corpo" — só a fila importa este módulo
// (vendor, portão de fidelidade, acabamento com sharp). O pedido, a escolha
// e as listas ficam em services/studio.ts, leve, para páginas e actions.
//
// Nunca se gera de novo depois de uma geração paga: julgamento indisponível
// deixa a candidata "sem julgamento" para a dona ver; só falha ANTES do
// vendor vai para a fila tentar de novo. Custo: cada geração e cada
// julgamento vira linha em audit_log (studio.generate / studio.judge).
import { and, eq, sql } from "drizzle-orm";

import { AssistantUnavailableError, type SalesAssistant } from "@/adapters/assistant";
import { StudioUnavailableError, type ImageStudio } from "@/adapters/image-studio";
import type { FileStorage } from "@/adapters/storage";
import { estimateUsageCostUsdCents } from "@/core/ai/model-cost";
import { parsePieceType } from "@/core/catalog/piece-types";
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
import { buildModelPhotoPrompt, buildScenePrompt, garmentCategoryFor } from "@/core/studio/prompts";
import { auditLog, studioBasePhotos, studioCandidates, studioRequests } from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { mdPathFor } from "@/services/catalog";
import {
  enqueueStudioOption,
  garmentImageFor,
  getChosenBasePhoto,
  requireProductForStudio,
  ServiceError,
  studioBasePhotoPayloadSchema,
  studioBasePhotoStoragePath,
  studioOptionPayloadSchema,
  type ProductForStudio,
  type StudioOptionPayload,
} from "@/services/studio";
import { finishStudioImage } from "@/services/studio-finish";
import { prepareImageForModel } from "@/services/wa-media";

/** O julgamento usa sempre o modelo mais atento: a estampa é o que está em jogo. */
export const STUDIO_JUDGE_MODEL = "claude-sonnet-5";
/** Deixa esta folga para gravar a candidata depois do vendor responder. */
const STUDIO_SAVE_RESERVE_MS = 3_000;

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
