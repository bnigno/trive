// O handler do vídeo da peça (só a fila importa este módulo). A FASHN leva
// uns 4–5 min por vídeo e cada invocação da fila tem menos de 1 min, então o
// trabalho é dividido pelo ESTADO da linha, nunca pelo payload:
//
// - queued: marca "enviando" (gravado ANTES do pedido), pede o vídeo, grava
//   o id do pedido assim que a FASHN aceita e agenda a 1ª espera (~4 min);
// - processing: acompanha o mesmo pedido pelo id por uma rodada curta; não
//   terminou = agenda a próxima rodada (evento novo, dedupe pelo contador);
//   terminou = sobe o MP4 e marca "pronto";
// - submitting sem id: o envio caiu no meio — pode ter sido feito e cobrado,
//   então NUNCA pede de novo: marca "envio incerto" para a dona conferir.
//
// A regra de ouro: um pedido que a FASHN pode ter aceitado nunca é pedido de
// novo (seria pagar duas vezes). Buscar de novo é sempre pelo id.
import { and, eq, sql } from "drizzle-orm";

import { StudioUnavailableError, type ImageStudio, type StudioVideo as VendorVideo } from "@/adapters/image-studio";
import type { FileStorage } from "@/adapters/storage";
import { HandlerOutOfTimeError } from "@/core/queue/handler-errors";
import { creditsToUsdCents } from "@/core/studio/cost";
import {
  assertVideoTransition,
  classifyVideoFailure,
  isStudioVideoStatus,
  nextVideoPollAt,
  VIDEO_TIMING,
  type StudioVideoStatus,
} from "@/core/studio/video";
import { auditLog, studioVideos } from "@/db/schema";
import { enqueueOutboxEvent, type DbOrTx } from "@/queue/enqueue";
import { requireProductForStudio, ServiceError } from "@/services/studio";
import { loadStudioVideoSettings } from "@/services/studio-settings";
import {
  STUDIO_VIDEO_EVENT,
  studioVideoDedupeKey,
  studioVideoPayloadSchema,
  studioVideoStoragePath,
  type StudioVideo,
} from "@/services/studio-video";

export type StudioVideoDeps = { studio: ImageStudio; storage: FileStorage };

export type StudioVideoResult =
  | { outcome: "polling"; vendorJobId: string; nextPollAt: Date; polls: number }
  | { outcome: "done"; storagePath: string; usdCents: number }
  | { outcome: "failed"; reason: string }
  | { outcome: "skipped"; reason: "video_nao_encontrado" | "video_encerrado" };

type Clock = () => Date;

/** Quanto esperar pela FASHN nesta invocação: o prazo da fila menos o tempo de subir o MP4. */
function waitSignal(deadlineAt: Date | undefined, now: Date): AbortSignal {
  if (!deadlineAt) return AbortSignal.timeout(VIDEO_TIMING.defaultWaitMs);
  return AbortSignal.timeout(Math.max(1_000, deadlineAt.getTime() - now.getTime() - VIDEO_TIMING.saveReserveMs));
}

function detailOf(code: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${code}: ${message}`.slice(0, 500);
}

function estimateUsdCents(video: Pick<StudioVideo, "credits">): number {
  return creditsToUsdCents(video.credits);
}

/** Estado → falhou, com o motivo e o gasto registrado (0 = certamente não cobrado). */
async function failVideo(
  db: DbOrTx,
  video: StudioVideo,
  from: StudioVideoStatus,
  input: { errorDetail: string; usdCents: number; now: Date },
): Promise<boolean> {
  assertVideoTransition(from, "failed");
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(studioVideos)
      .set({ status: "failed", errorDetail: input.errorDetail, usdCents: input.usdCents, finishedAt: input.now, updatedAt: input.now })
      .where(and(eq(studioVideos.id, video.id), eq(studioVideos.status, from)))
      .returning({ id: studioVideos.id });
    if (!updated) return false;
    await tx.insert(auditLog).values({
      actorType: "system",
      action: "studio.video_fail",
      entityType: "studio_video",
      entityId: video.id,
      after: { from, errorDetail: input.errorDetail, usdCents: input.usdCents, vendorJobId: video.vendorJobId },
    });
    return true;
  });
}

/** A FASHN aceitou o pedido: grava o id (é o que impede pagar duas vezes) e o prazo de desistir. */
async function markSubmitted(db: DbOrTx, video: StudioVideo, jobId: string | null, now: Date): Promise<StudioVideo> {
  assertVideoTransition("submitting", "processing");
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(studioVideos)
      .set({
        status: "processing",
        vendorJobId: jobId,
        submittedAt: now,
        giveUpAt: new Date(now.getTime() + VIDEO_TIMING.giveUpAfterMs),
        updatedAt: now,
      })
      .where(and(eq(studioVideos.id, video.id), eq(studioVideos.status, "submitting")))
      .returning();
    if (!updated) throw new Error(`vídeo ${video.id} saiu de "enviando" enquanto a FASHN aceitava o pedido ${jobId ?? "?"}`);
    await tx.insert(auditLog).values({
      actorType: "system",
      action: "studio.video_submit",
      entityType: "studio_video",
      entityId: video.id,
      after: { vendorJobId: jobId, productId: video.productId },
    });
    return updated;
  });
}

async function finishVideo(db: DbOrTx, deps: StudioVideoDeps, video: StudioVideo, result: VendorVideo, now: Date): Promise<StudioVideoResult> {
  const path = studioVideoStoragePath({ productId: video.productId, videoId: video.id });
  // Falhou ao guardar: a fila tenta de novo e a próxima rodada busca pelo id (sem pagar).
  await deps.storage.upload({ path, data: result.data, contentType: "video/mp4" });
  assertVideoTransition("processing", "done");
  const elapsedMs = video.submittedAt ? now.getTime() - video.submittedAt.getTime() : result.elapsedMs;
  const saved = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(studioVideos)
      .set({
        status: "done",
        storagePath: path,
        bytes: result.data.byteLength,
        vendor: result.vendor,
        vendorModel: result.vendorModel,
        credits: result.creditsUsed,
        usdCents: result.usdCents,
        elapsedMs,
        errorDetail: null,
        finishedAt: now,
        updatedAt: now,
      })
      .where(and(eq(studioVideos.id, video.id), eq(studioVideos.status, "processing")))
      .returning({ id: studioVideos.id });
    if (!updated) return false;
    await tx.insert(auditLog).values({
      actorType: "system",
      action: "studio.video",
      entityType: "studio_video",
      entityId: video.id,
      after: {
        productId: video.productId,
        candidateId: video.candidateId,
        vendorJobId: video.vendorJobId,
        vendor: result.vendor,
        vendorModel: result.vendorModel,
        credits: result.creditsUsed,
        estimatedCostUsdCents: result.usdCents,
        elapsedMs,
        bytes: result.data.byteLength,
      },
    });
    return true;
  });
  if (!saved) {
    // Outra rodada chegou antes. O caminho é o mesmo: se ela terminou, o arquivo é dela — não apagar.
    const [current] = await db.select({ status: studioVideos.status }).from(studioVideos).where(eq(studioVideos.id, video.id)).limit(1);
    if (current && current.status !== "done") await deps.storage.remove(path).catch(() => undefined);
    return { outcome: "skipped", reason: "video_encerrado" };
  }
  return { outcome: "done", storagePath: path, usdCents: result.usdCents };
}

/** Agenda a próxima rodada de espera (evento novo; o contador da linha é a chave de dedupe). */
async function schedulePoll(db: DbOrTx, video: StudioVideo, at: Date, now: Date): Promise<StudioVideoResult> {
  const polls = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(studioVideos)
      .set({ polls: sql`${studioVideos.polls} + 1`, updatedAt: now })
      .where(and(eq(studioVideos.id, video.id), eq(studioVideos.status, "processing")))
      .returning({ polls: studioVideos.polls });
    if (!updated) return null;
    await enqueueOutboxEvent(tx, {
      eventType: STUDIO_VIDEO_EVENT,
      dedupeKey: studioVideoDedupeKey(video.id, { poll: updated.polls }),
      aggregateType: "studio_video",
      aggregateId: video.id,
      payload: { videoId: video.id },
      nextAttemptAt: at,
    });
    return updated.polls;
  });
  if (polls === null) return { outcome: "skipped", reason: "video_encerrado" };
  return { outcome: "polling", vendorJobId: video.vendorJobId ?? "", nextPollAt: at, polls };
}

/** Uma falha do vendor: o que fazer depende de a FASHN já ter o pedido (ver classifyVideoFailure). */
async function handleVendorFailure(
  db: DbOrTx,
  video: StudioVideo,
  error: unknown,
  input: { first: boolean; now: Date },
): Promise<StudioVideoResult> {
  if (!(error instanceof StudioUnavailableError)) throw error;
  const from = video.status as StudioVideoStatus;
  const outcome = classifyVideoFailure({ reason: error.reason, status: error.status, jobId: video.vendorJobId });
  switch (outcome) {
    case "retry_not_charged": {
      // 429 na entrada: nada foi cobrado. Volta à fila e a política de retry espaça.
      assertVideoTransition("submitting", "queued");
      await db
        .update(studioVideos)
        .set({ status: "queued", updatedAt: input.now })
        .where(and(eq(studioVideos.id, video.id), eq(studioVideos.status, "submitting")));
      throw error;
    }
    case "closed_not_charged":
      await failVideo(db, video, from, { errorDetail: detailOf(error.reason, error), usdCents: 0, now: input.now });
      return { outcome: "failed", reason: error.reason };
    case "closed_job_gone":
      // A FASHN aceitou o pedido um dia: sem prova de que não cobrou, o gasto registrado nunca desce.
      await failVideo(db, video, from, {
        errorDetail: detailOf("pedido_sumiu", error),
        usdCents: Math.max(video.usdCents, estimateUsdCents(video)),
        now: input.now,
      });
      return { outcome: "failed", reason: "pedido_sumiu" };
    case "uncertain_submit":
      await failVideo(db, video, from, { errorDetail: detailOf("envio_incerto", error), usdCents: estimateUsdCents(video), now: input.now });
      return { outcome: "failed", reason: "envio_incerto" };
    case "keep_open": {
      const at =
        video.submittedAt && video.giveUpAt
          ? nextVideoPollAt({ submittedAt: video.submittedAt, giveUpAt: video.giveUpAt, now: input.now, first: input.first })
          : null;
      if (!at) {
        // O id fica: "Buscar de novo" continua possível por 3 dias, sem pagar.
        await failVideo(db, video, "processing", { errorDetail: detailOf("demorou_demais", error), usdCents: estimateUsdCents(video), now: input.now });
        return { outcome: "failed", reason: "demorou_demais" };
      }
      return schedulePoll(db, video, at, input.now);
    }
  }
}

export async function generateStudioVideo(
  db: DbOrTx,
  deps: StudioVideoDeps,
  rawPayload: unknown,
  options: { now?: Clock; deadlineAt?: Date } = {},
): Promise<StudioVideoResult> {
  const clock: Clock = options.now ?? (() => new Date());
  const { videoId } = studioVideoPayloadSchema.parse(rawPayload);
  const [video] = await db.select().from(studioVideos).where(eq(studioVideos.id, videoId)).limit(1);
  if (!video) return { outcome: "skipped", reason: "video_nao_encontrado" };
  if (!isStudioVideoStatus(video.status) || video.status === "done" || video.status === "failed" || video.status === "discarded") {
    return { outcome: "skipped", reason: "video_encerrado" };
  }
  const signal = waitSignal(options.deadlineAt, clock());

  let current: StudioVideo = video;
  if (current.status === "submitting") {
    if (!current.vendorJobId) {
      // O envio caiu entre o pedido e a gravação do id: pode ter sido feito e cobrado. Nunca pedir de novo.
      await failVideo(db, current, "submitting", {
        errorDetail: "envio_incerto: o envio foi interrompido antes de a resposta da FASHN ser gravada",
        usdCents: estimateUsdCents(current),
        now: clock(),
      });
      return { outcome: "failed", reason: "envio_incerto" };
    }
    // O id chegou a ser gravado (pela gravação mínima), só a mudança de estado caiu: segue pelo id.
    current = await markSubmitted(db, current, current.vendorJobId, clock());
  }

  if (current.status === "processing") {
    const video = current;
    if (!video.vendorJobId) {
      await failVideo(db, video, "processing", { errorDetail: "envio_incerto: sem o id do pedido na FASHN", usdCents: estimateUsdCents(video), now: clock() });
      return { outcome: "failed", reason: "envio_incerto" };
    }
    let result: VendorVideo;
    try {
      result = await deps.studio.animate({
        // A retomada não envia a foto (só acompanha o pedido pelo id).
        image: { data: Buffer.alloc(0), mimeType: "image/jpeg" },
        prompt: video.prompt,
        durationSeconds: video.durationSeconds === 10 ? 10 : 5,
        resolution: video.resolution === "480p" || video.resolution === "720p" ? video.resolution : "1080p",
        resumeJobId: video.vendorJobId,
        signal,
      });
    } catch (error) {
      return handleVendorFailure(db, video, error, { first: false, now: clock() });
    }
    return finishVideo(db, deps, video, result, clock());
  }

  // queued: o envio.
  const settings = await loadStudioVideoSettings(db);
  if (!settings.enabled) {
    await failVideo(db, video, "queued", { errorDetail: "video_desligado: desligado antes de sair", usdCents: 0, now: clock() });
    return { outcome: "failed", reason: "video_desligado" };
  }
  try {
    await requireProductForStudio(db, video.productId);
  } catch (error) {
    if (!(error instanceof ServiceError)) throw error;
    await failVideo(db, video, "queued", { errorDetail: "peca_nao_encontrada: a peça foi apagada", usdCents: 0, now: clock() });
    return { outcome: "failed", reason: "peca_nao_encontrada" };
  }
  // Baixar a foto antes de marcar "enviando": se falhar aqui, nada foi pedido e a fila tenta de novo.
  const source = await deps.storage.download(video.sourceStoragePath);
  // Pouco tempo sobrando nesta invocação: não envia (um envio cortado no meio seria "incerto").
  if (options.deadlineAt) {
    const remainingMs = options.deadlineAt.getTime() - clock().getTime();
    if (remainingMs < VIDEO_TIMING.minSubmitMs) throw new HandlerOutOfTimeError(remainingMs);
  }

  assertVideoTransition("queued", "submitting");
  const [claimed] = await db
    .update(studioVideos)
    .set({ status: "submitting", updatedAt: clock() })
    .where(and(eq(studioVideos.id, video.id), eq(studioVideos.status, "queued")))
    .returning();
  if (!claimed) return { outcome: "skipped", reason: "video_encerrado" };

  let jobId: string | null = null;
  const accepted = new AbortController();
  let outcome: { video: VendorVideo } | { error: unknown };
  try {
    outcome = {
      video: await deps.studio.animate({
        image: { data: source.data, mimeType: source.contentType === "image/png" ? "image/png" : source.contentType === "image/webp" ? "image/webp" : "image/jpeg" },
        prompt: claimed.prompt,
        durationSeconds: claimed.durationSeconds === 10 ? 10 : 5,
        resolution: claimed.resolution === "480p" || claimed.resolution === "720p" ? claimed.resolution : "1080p",
        // O envio tem o próprio teto do adapter (15 s); aceito, esta invocação não espera os ~4 min.
        signal: accepted.signal,
        onSubmitted: (id) => {
          jobId = id;
          // O id no log antes de tudo: é a última pista se o banco falhar logo em seguida.
          console.info(`[${STUDIO_VIDEO_EVENT}] ${video.id}: pedido ${id} aceito pela FASHN`);
          accepted.abort();
        },
      }),
    };
  } catch (error) {
    outcome = { error };
  }

  let submitted: StudioVideo = claimed;
  if (jobId !== null || "video" in outcome) {
    try {
      submitted = await markSubmitted(db, claimed, jobId, clock());
    } catch (dbError) {
      const message = dbError instanceof Error ? dbError.message : String(dbError);
      console.error(`[${STUDIO_VIDEO_EVENT}] ${video.id}: pedido ${jobId ?? "?"} aceito pela FASHN mas não gravado: ${message}`);
      if (jobId !== null) {
        // Gravação mínima só do id (sem mudar estado): a próxima tentativa segue por ele em vez de dar "envio incerto".
        await db
          .update(studioVideos)
          .set({ vendorJobId: jobId })
          .where(and(eq(studioVideos.id, video.id), eq(studioVideos.status, "submitting")))
          .catch(() => undefined);
      }
      throw new Error(`pedido ${jobId ?? "?"} aceito pela FASHN mas não gravado: ${message}`);
    }
  }
  if ("video" in outcome) return finishVideo(db, deps, submitted, outcome.video, clock());
  return handleVendorFailure(db, submitted, outcome.error, { first: true, now: clock() });
}

/**
 * Última tentativa da fila falhou (a linha vai para "morta"): o vídeo não
 * pode ficar "na fila" para sempre. O que já tem id continua buscável.
 */
export async function markStudioVideoGaveUp(db: DbOrTx, input: { videoId: string; error: unknown }, now: Date): Promise<void> {
  const [video] = await db.select().from(studioVideos).where(eq(studioVideos.id, input.videoId)).limit(1);
  if (!video) return;
  if (video.status === "queued") {
    await failVideo(db, video, "queued", { errorDetail: detailOf("sem_envio", input.error), usdCents: 0, now });
  } else if (video.status === "submitting") {
    await failVideo(db, video, "submitting", { errorDetail: detailOf("envio_incerto", input.error), usdCents: estimateUsdCents(video), now });
  } else if (video.status === "processing") {
    await failVideo(db, video, "processing", { errorDetail: detailOf("nao_salvou", input.error), usdCents: estimateUsdCents(video), now });
  }
}
