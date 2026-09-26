// "A peça se mexe" no estúdio: a foto no corpo que já está na peça vira um
// vídeo de 5 s para o Instagram (FASHN image-to-video). Casos de uso da tela:
//
// - pedir: valida tudo ANTES de gastar (interruptor, chave, a foto ainda na
//   peça, nenhum vídeo dela em andamento, teto de vídeos do dia, saldo da
//   FASHN) e grava o vídeo + o evento da fila na mesma transação;
// - buscar de novo: só com o id do pedido na FASHN (nunca pede outro vídeo);
// - descartar: tira da lista e apaga o arquivo; o custo fica no histórico;
// - a leitura do painel.
//
// Módulo LEVE (páginas e server actions o importam): quem envia, espera e
// guarda o MP4 é services/studio-video-generate.ts, que só a fila carrega.
// O vídeo nunca vira foto da peça nem aparece na vitrine.
import { and, desc, eq, gte, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { z } from "zod";

import type { ImageStudio } from "@/adapters/image-studio";
import type { FileStorage } from "@/adapters/storage";
import { creditsToUsdCents, usdCentsToBrlCents, videoCreditsFor } from "@/core/studio/cost";
import {
  assertVideoTransition,
  buildVideoMotionPrompt,
  canRefetchVideo,
  checkVideoRequest,
  isStudioVideoStatus,
  isVideoInFlight,
  stalledVideoFailure,
  VIDEO_DEFAULTS,
  VIDEO_TIMING,
} from "@/core/studio/video";
import { auditLog, productImages, studioCandidates, studioRequests, studioVideos } from "@/db/schema";
import { spDayKey, spDayStart } from "@/lib/sp-day";
import { enqueueOutboxEvent, kickOutbox, type DbOrTx } from "@/queue/enqueue";
import { requireProductForStudio, ServiceError } from "@/services/studio";
import { loadStudioVideoSettings, type StudioVideoSettings } from "@/services/studio-settings";

export const STUDIO_VIDEO_EVENT = "product.ai_video";

export const studioVideoPayloadSchema = z.object({ videoId: z.uuid() });
export type StudioVideoPayload = z.infer<typeof studioVideoPayloadSchema>;

export type StudioVideo = typeof studioVideos.$inferSelect;

export function studioVideoStoragePath(input: { productId: string; videoId: string }): string {
  return `studio/videos/${input.productId}/${input.videoId}.mp4`;
}

export function studioVideoDedupeKey(videoId: string, step: "submit" | { poll: number }): string {
  return typeof step === "string" ? `${STUDIO_VIDEO_EVENT}:${videoId}:submit` : `${STUDIO_VIDEO_EVENT}:${videoId}:poll:${step.poll}`;
}

/**
 * Vídeos que contam no teto do dia (dia de São Paulo): todo pedido de hoje,
 * menos os que certamente não foram cobrados (falharam com custo zero —
 * descartados depois ou não). Descartado que foi pago conta.
 */
export async function countStudioVideosToday(db: DbOrTx, now: Date): Promise<number> {
  const since = spDayStart(spDayKey(now));
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(studioVideos)
    .where(and(gte(studioVideos.createdAt, since), sql`NOT (${studioVideos.status} IN ('failed', 'discarded') AND ${studioVideos.usdCents} = 0)`));
  return row?.n ?? 0;
}

/** O saldo da FASHN com teto de 5 s; qualquer falha = desconhecido (não bloqueia, o vendor recusa se faltar). */
async function safeBalance(studio: Pick<ImageStudio, "creditsBalance">): Promise<number | null> {
  try {
    return await studio.creditsBalance(AbortSignal.timeout(5_000));
  } catch {
    return null;
  }
}

/**
 * Vídeo parado "na fila"/"enviando" além do prazo (a linha da fila morreu
 * sem o handler rodar) vira falha com o motivo: senão a foto fica travada
 * (um vídeo em andamento por foto) e a tela se atualiza para sempre.
 */
export async function healStalledStudioVideos(db: DbOrTx, now: Date): Promise<number> {
  // Todas as peças: um parado de outra peça também ocupa o teto do dia (e a tela conta igual ao botão).
  const rows = await db.select().from(studioVideos).where(inArray(studioVideos.status, ["queued", "submitting"]));
  let healed = 0;
  for (const video of rows) {
    const failure = stalledVideoFailure(video, now);
    if (!failure || !isStudioVideoStatus(video.status)) continue;
    assertVideoTransition(video.status, "failed");
    const usdCents = failure.charged ? Math.max(video.usdCents, creditsToUsdCents(video.credits)) : video.usdCents;
    const done = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(studioVideos)
        .set({
          status: "failed",
          errorDetail: failure.errorDetail,
          usdCents,
          finishedAt: now,
          updatedAt: now,
          // Com o id, "Buscar de novo" precisa da hora do envio (a janela de 3 dias conta dela).
          ...(video.vendorJobId && !video.submittedAt ? { submittedAt: video.updatedAt } : {}),
        })
        .where(and(eq(studioVideos.id, video.id), eq(studioVideos.status, video.status), eq(studioVideos.updatedAt, video.updatedAt)))
        .returning({ id: studioVideos.id });
      if (!updated) return false;
      await tx.insert(auditLog).values({
        actorType: "system",
        action: "studio.video_fail",
        entityType: "studio_video",
        entityId: video.id,
        after: { from: video.status, errorDetail: failure.errorDetail, usdCents, vendorJobId: video.vendorJobId, stalled: true },
      });
      return true;
    });
    if (done) healed += 1;
  }
  return healed;
}

/** A candidata escolhida que ainda é foto da peça: é dela que sai o vídeo. */
async function loadVideoSource(db: DbOrTx, candidateId: string) {
  const [row] = await db
    .select({
      candidateId: studioCandidates.id,
      status: studioCandidates.status,
      storagePath: studioCandidates.storagePath,
      chosenImageId: studioCandidates.chosenImageId,
      productId: studioRequests.productId,
      color: studioRequests.color,
    })
    .from(studioCandidates)
    .innerJoin(studioRequests, eq(studioRequests.id, studioCandidates.requestId))
    .where(eq(studioCandidates.id, candidateId))
    .limit(1);
  return row ?? null;
}

const requestStudioVideoSchema = z.object({ candidateId: z.uuid(), userId: z.uuid().nullable() });

export type StudioVideoRequested = { videoId: string; credits: number; usdCents: number };

export async function requestStudioVideo(
  db: DbOrTx,
  deps: { studio: Pick<ImageStudio, "creditsBalance">; configured: boolean },
  rawInput: unknown,
  now = new Date(),
): Promise<StudioVideoRequested> {
  const input = requestStudioVideoSchema.parse(rawInput);
  const settings = await loadStudioVideoSettings(db);
  if (!settings.enabled) throw new ServiceError("video_desligado", "O vídeo da peça está desligado. Ligue em Vendedora & WhatsApp.");
  if (!deps.configured) throw new ServiceError("sem_chave", "Falta a chave da FASHN na hospedagem (FASHN_API_KEY).");

  const source = await loadVideoSource(db, input.candidateId);
  if (!source || source.status !== "chosen" || !source.chosenImageId || !source.storagePath) {
    throw new ServiceError("foto_fora_da_peca", "Só dá para fazer vídeo de uma foto no corpo que está na peça.");
  }
  const product = await requireProductForStudio(db, source.productId);

  // Parados de qualquer peça: senão travam a foto (um em andamento por foto) e ocupam o teto do dia.
  await healStalledStudioVideos(db, now);
  const [inFlight] = await db
    .select({ id: studioVideos.id })
    .from(studioVideos)
    .where(and(eq(studioVideos.candidateId, source.candidateId), inArray(studioVideos.status, ["queued", "submitting", "processing"])))
    .limit(1);
  if (inFlight) throw new ServiceError("video_em_andamento", "Esta foto já está virando vídeo — espere ficar pronto.");

  const credits = videoCreditsFor(VIDEO_DEFAULTS.durationSeconds, VIDEO_DEFAULTS.resolution);
  const [usedToday, balance] = await Promise.all([countStudioVideosToday(db, now), safeBalance(deps.studio)]);
  const check = checkVideoRequest({ dailyLimit: settings.dailyLimit, usedToday, credits, balanceCredits: balance });
  if (!check.ok) {
    throw check.reason === "teto"
      ? new ServiceError(
          "teto_do_dia",
          `O teto de hoje é ${settings.dailyLimit} vídeo(s) e já foram ${usedToday}. Amanhã libera, ou aumente em Configurações.`,
        )
      : new ServiceError("sem_saldo", `A FASHN tem ${balance} crédito(s) e o vídeo usa ${credits}. Compre créditos no painel da FASHN.`);
  }

  const prompt = buildVideoMotionPrompt({ pieceType: product.pieceType, withBackView: false });
  const { videoId, eventId } = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(studioVideos)
      .values({
        productId: source.productId,
        candidateId: source.candidateId,
        sourceStoragePath: source.storagePath as string,
        color: source.color,
        durationSeconds: VIDEO_DEFAULTS.durationSeconds,
        resolution: VIDEO_DEFAULTS.resolution,
        prompt,
        credits,
        requestedBy: input.userId,
        createdAt: now,
        updatedAt: now,
      })
      // O índice parcial (um vídeo em andamento por foto) é o árbitro do clique duplo.
      .onConflictDoNothing()
      .returning({ id: studioVideos.id });
    if (!created) throw new ServiceError("video_em_andamento", "Esta foto já está virando vídeo — espere ficar pronto.");
    const id = await enqueueOutboxEvent(
      tx,
      {
        eventType: STUDIO_VIDEO_EVENT,
        dedupeKey: studioVideoDedupeKey(created.id, "submit"),
        aggregateType: "studio_video",
        aggregateId: created.id,
        payload: { videoId: created.id },
      },
      { kick: false },
    );
    await tx.insert(auditLog).values({
      actorType: input.userId ? "user" : "system",
      actorId: input.userId,
      action: "studio.video_request",
      entityType: "studio_video",
      entityId: created.id,
      after: {
        productId: source.productId,
        candidateId: source.candidateId,
        durationSeconds: VIDEO_DEFAULTS.durationSeconds,
        resolution: VIDEO_DEFAULTS.resolution,
        credits,
        estimatedUsdCents: creditsToUsdCents(credits),
        balanceCredits: balance,
      },
    });
    return { videoId: created.id, eventId: id };
  });
  // Depois do commit: o evento já existe quando a fila acordar.
  if (eventId) await kickOutbox(eventId, { eventType: STUDIO_VIDEO_EVENT });
  return { videoId, credits, usdCents: creditsToUsdCents(credits) };
}

const videoActionSchema = z.object({ videoId: z.uuid(), userId: z.uuid() });

/** "Buscar de novo": acompanha o MESMO pedido pelo id — nunca pede (nem paga) outro vídeo. */
export async function refetchStudioVideo(db: DbOrTx, rawInput: unknown, now = new Date()): Promise<void> {
  const input = videoActionSchema.parse(rawInput);
  const eventId = await db.transaction(async (tx) => {
    const [video] = await tx.select().from(studioVideos).where(eq(studioVideos.id, input.videoId)).limit(1);
    if (!video) throw new ServiceError("nao_encontrado", "Vídeo não encontrado.");
    if (!canRefetchVideo(video, now)) {
      throw new ServiceError("nao_da_para_buscar", "Este vídeo não tem mais o que buscar (ou ainda está sendo feito).");
    }
    // Um vídeo em andamento por foto (o índice parcial): outro da mesma foto na frente, espera ele.
    const [sibling] = await tx
      .select({ id: studioVideos.id })
      .from(studioVideos)
      .where(
        and(
          eq(studioVideos.candidateId, video.candidateId),
          ne(studioVideos.id, video.id),
          inArray(studioVideos.status, ["queued", "submitting", "processing"]),
        ),
      )
      .limit(1);
    if (sibling) {
      throw new ServiceError("video_em_andamento", "Esta foto já está virando outro vídeo — espere ele terminar para buscar este de novo.");
    }
    if (video.status === "failed") assertVideoTransition("failed", "processing");
    const [updated] = await tx
      .update(studioVideos)
      .set({
        status: "processing",
        errorDetail: null,
        giveUpAt: new Date(now.getTime() + VIDEO_TIMING.giveUpAfterMs),
        polls: sql`${studioVideos.polls} + 1`,
        updatedAt: now,
      })
      .where(and(eq(studioVideos.id, video.id), eq(studioVideos.status, video.status)))
      .returning({ polls: studioVideos.polls });
    if (!updated) throw new ServiceError("nao_da_para_buscar", "O vídeo mudou enquanto isso — atualize a tela.");
    const id = await enqueueOutboxEvent(
      tx,
      {
        eventType: STUDIO_VIDEO_EVENT,
        dedupeKey: studioVideoDedupeKey(video.id, { poll: updated.polls }),
        aggregateType: "studio_video",
        aggregateId: video.id,
        payload: { videoId: video.id },
      },
      { kick: false },
    );
    await tx.insert(auditLog).values({
      actorType: "user",
      actorId: input.userId,
      action: "studio.video_refetch",
      entityType: "studio_video",
      entityId: video.id,
      after: { vendorJobId: video.vendorJobId, was: video.status },
    });
    return id;
  });
  if (eventId) await kickOutbox(eventId, { eventType: STUDIO_VIDEO_EVENT });
}

/** Tira da lista e apaga o MP4 (espaço do Storage); o custo continua no histórico. */
export async function discardStudioVideo(db: DbOrTx, storage: FileStorage, rawInput: unknown): Promise<void> {
  const input = videoActionSchema.parse(rawInput);
  const removed = await db.transaction(async (tx) => {
    const [video] = await tx.select().from(studioVideos).where(eq(studioVideos.id, input.videoId)).limit(1);
    if (!video) throw new ServiceError("nao_encontrado", "Vídeo não encontrado.");
    if (video.status === "discarded") return null;
    if (!isStudioVideoStatus(video.status) || isVideoInFlight(video.status)) {
      throw new ServiceError("video_em_andamento", "Espere o vídeo terminar para descartar.");
    }
    assertVideoTransition(video.status, "discarded");
    const [updated] = await tx
      .update(studioVideos)
      .set({ status: "discarded", updatedAt: new Date() })
      .where(and(eq(studioVideos.id, video.id), eq(studioVideos.status, video.status)))
      .returning({ id: studioVideos.id });
    if (!updated) throw new ServiceError("video_em_andamento", "O vídeo mudou enquanto isso — atualize a tela.");
    await tx.insert(auditLog).values({
      actorType: "user",
      actorId: input.userId,
      action: "studio.video_discard",
      entityType: "studio_video",
      entityId: video.id,
      after: { was: video.status, storagePath: video.storagePath, usdCents: video.usdCents },
    });
    return video.storagePath;
  });
  if (removed) {
    try {
      await storage.remove(removed);
    } catch (error) {
      // O registro já diz "descartado"; o arquivo órfão só ocupa espaço.
      console.warn(`[studio.video_discard] não apagou ${removed}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Leitura para o painel
// ---------------------------------------------------------------------------

export type StudioVideoSource = { candidateId: string; productImageId: string; storagePath: string; color: string | null };

export type StudioVideoPanel = {
  settings: StudioVideoSettings;
  sources: StudioVideoSource[];
  videos: (StudioVideo & { canRefetch: boolean })[];
  inFlight: boolean;
  estimate: { credits: number; usdCents: number; brlCents: number };
  usedToday: number;
};

export async function listStudioVideoPanel(db: DbOrTx, productId: string, now: Date): Promise<StudioVideoPanel> {
  const id = z.uuid().parse(productId);
  await healStalledStudioVideos(db, now);
  const [settings, sources, videos, usedToday] = await Promise.all([
    loadStudioVideoSettings(db),
    db
      .select({
        candidateId: studioCandidates.id,
        productImageId: productImages.id,
        storagePath: studioCandidates.storagePath,
        color: studioRequests.color,
      })
      .from(studioCandidates)
      .innerJoin(studioRequests, eq(studioRequests.id, studioCandidates.requestId))
      .innerJoin(productImages, eq(productImages.id, studioCandidates.chosenImageId))
      .where(and(eq(studioRequests.productId, id), eq(studioCandidates.status, "chosen"), isNotNull(studioCandidates.storagePath)))
      .orderBy(productImages.sortOrder, productImages.createdAt),
    db
      .select()
      .from(studioVideos)
      .where(and(eq(studioVideos.productId, id), ne(studioVideos.status, "discarded")))
      .orderBy(desc(studioVideos.createdAt))
      .limit(12),
    countStudioVideosToday(db, now),
  ]);
  const credits = videoCreditsFor(VIDEO_DEFAULTS.durationSeconds, VIDEO_DEFAULTS.resolution);
  const usdCents = creditsToUsdCents(credits);
  return {
    settings,
    sources: sources.map((source) => ({ ...source, storagePath: source.storagePath as string })),
    videos: videos.map((video) => ({
      ...video,
      // Outro vídeo da mesma foto em andamento: buscar este esbarraria no "um por foto".
      canRefetch:
        canRefetchVideo(video, now) &&
        !videos.some((other) => other.id !== video.id && other.candidateId === video.candidateId && isVideoInFlight(other.status)),
    })),
    inFlight: videos.some((video) => isVideoInFlight(video.status)),
    estimate: { credits, usdCents, brlCents: usdCentsToBrlCents(usdCents) },
    usedToday,
  };
}
