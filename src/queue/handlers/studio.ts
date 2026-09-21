// Handlers do ensaio "foto no corpo": uma opção por evento (product.ai_photo)
// e as fotos-base das modelas (studio.base_photo). Recebem as dependências
// (banco, gerador, visão, storage) para serem testáveis fora do Inngest.
import type { SalesAssistant } from "@/adapters/assistant";
import type { ImageStudio } from "@/adapters/image-studio";
import type { FileStorage } from "@/adapters/storage";
import type { DbOrTx } from "@/queue/enqueue";
import {
  generateStudioBasePhotos,
  generateStudioOption,
  type StudioBasePhotoResult,
  type StudioOptionResult,
} from "@/services/studio";

export type StudioHandlerDeps = {
  db: DbOrTx;
  studio: ImageStudio;
  assistant: SalesAssistant;
  storage: FileStorage;
  now?: () => Date;
};

type StudioEvent = { id: string; eventType: string; payload: Record<string, unknown>; deadlineAt?: Date };

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
