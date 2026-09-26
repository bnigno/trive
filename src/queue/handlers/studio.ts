// Handlers do ensaio "foto no corpo": uma opção por evento (product.ai_photo),
// as fotos-base das modelos (studio.base_photo) e o vídeo da peça
// (product.ai_video). Recebem as dependências (banco, gerador, visão,
// storage) para serem testáveis fora do Inngest.
import type { SalesAssistant } from "@/adapters/assistant";
import type { ImageStudio } from "@/adapters/image-studio";
import type { FileStorage } from "@/adapters/storage";
import { HandlerOutOfTimeError } from "@/core/queue/handler-errors";
import { getRetryPolicy } from "@/core/queue/retry-policy";
import type { DbOrTx } from "@/queue/enqueue";
import {
  generateStudioBasePhotos,
  generateStudioOption,
  type StudioBasePhotoResult,
  type StudioOptionResult,
} from "@/services/studio-generate";
import { studioVideoPayloadSchema } from "@/services/studio-video";
import { generateStudioVideo, markStudioVideoGaveUp, type StudioVideoResult } from "@/services/studio-video-generate";

export type StudioHandlerDeps = {
  db: DbOrTx;
  studio: ImageStudio;
  assistant: SalesAssistant;
  storage: FileStorage;
  now?: () => Date;
};

type StudioEvent = { id: string; eventType: string; payload: Record<string, unknown>; attempts?: number; deadlineAt?: Date };

export type StudioVideoHandlerDeps = { db: DbOrTx; studio: ImageStudio; storage: FileStorage; now?: () => Date };

export async function runStudioOption(deps: StudioHandlerDeps, event: StudioEvent): Promise<StudioOptionResult> {
  const result = await generateStudioOption(
    deps.db,
    { studio: deps.studio, assistant: deps.assistant, storage: deps.storage },
    event.payload,
    { now: deps.now, deadlineAt: event.deadlineAt },
  );
  console.info(`[${event.eventType}] ${JSON.stringify({ ...event.payload, ...result })}`);
  return result;
}

export async function runStudioBasePhotos(deps: StudioHandlerDeps, event: StudioEvent): Promise<StudioBasePhotoResult> {
  const result = await generateStudioBasePhotos(
    deps.db,
    { studio: deps.studio, storage: deps.storage },
    event.payload,
    { now: deps.now, deadlineAt: event.deadlineAt },
  );
  console.info(`[${event.eventType}] ${JSON.stringify({ ...event.payload, userId: undefined, ...result })}`);
  return result;
}

/**
 * O vídeo da peça. Na última tentativa da fila, o vídeo não fica "na fila"
 * para sempre: vira "falhou" com o motivo (o que tem id continua buscável)
 * antes de a linha da fila morrer.
 */
export async function runStudioVideo(deps: StudioVideoHandlerDeps, event: StudioEvent): Promise<StudioVideoResult> {
  const last = (event.attempts ?? 0) + 1 >= getRetryPolicy("product.ai_video").maxAttempts;
  try {
    const result = await generateStudioVideo(deps.db, { studio: deps.studio, storage: deps.storage }, event.payload, {
      now: deps.now,
      deadlineAt: event.deadlineAt,
    });
    console.info(`[${event.eventType}] ${JSON.stringify({ ...event.payload, ...result })}`);
    return result;
  } catch (error) {
    // Sem tempo nesta invocação: a fila devolve a linha sem contar tentativa — não é desistir.
    if (error instanceof HandlerOutOfTimeError) throw error;
    const payload = studioVideoPayloadSchema.safeParse(event.payload);
    if (last && payload.success) {
      await markStudioVideoGaveUp(deps.db, { videoId: payload.data.videoId, error }, (deps.now ?? (() => new Date()))());
    }
    throw error;
  }
}
