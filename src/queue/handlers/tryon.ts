// Handler da prévia na foto da cliente ("Me vê com ela", wa.tryon). Recebe
// as dependências (banco, gerador, visão, WhatsApp, storage) para ser
// testável fora do Inngest.
import type { SalesAssistant } from "@/adapters/assistant";
import type { ImageStudio } from "@/adapters/image-studio";
import type { FileStorage } from "@/adapters/storage";
import type { MessagingProvider } from "@/adapters/zapi";
import { HandlerOutOfTimeError } from "@/core/queue/handler-errors";
import { getRetryPolicy } from "@/core/queue/retry-policy";
import type { DbOrTx } from "@/queue/enqueue";
import { TRYON_EVENT, tryOnPayloadSchema } from "@/services/tryon";
import { generateTryOn, markTryOnGaveUp, type TryOnResult } from "@/services/tryon-generate";

export type TryOnHandlerDeps = {
  db: DbOrTx;
  studio: ImageStudio;
  assistant: SalesAssistant;
  provider: MessagingProvider;
  storage: FileStorage;
  now?: () => Date;
};

type TryOnEvent = { id: string; eventType: string; payload: Record<string, unknown>; attempts?: number; deadlineAt?: Date };

/**
 * Na última tentativa da fila, a prévia não fica "na fila" para sempre:
 * vira "falhou" e a cliente é avisada antes de a linha da fila morrer.
 */
export async function runTryOn(deps: TryOnHandlerDeps, event: TryOnEvent): Promise<TryOnResult> {
  const last = (event.attempts ?? 0) + 1 >= getRetryPolicy(TRYON_EVENT).maxAttempts;
  const services = { studio: deps.studio, assistant: deps.assistant, provider: deps.provider, storage: deps.storage };
  try {
    const result = await generateTryOn(deps.db, services, event.payload, { now: deps.now, deadlineAt: event.deadlineAt });
    console.info(`[${event.eventType}] ${JSON.stringify({ ...event.payload, ...result })}`);
    return result;
  } catch (error) {
    // Sem tempo nesta invocação: a fila devolve a linha sem contar tentativa — não é desistir.
    if (error instanceof HandlerOutOfTimeError) throw error;
    const payload = tryOnPayloadSchema.safeParse(event.payload);
    if (last && payload.success) {
      await markTryOnGaveUp(deps.db, services, { requestId: payload.data.requestId, error }, (deps.now ?? (() => new Date()))());
    }
    throw error;
  }
}
