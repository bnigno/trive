// Handler de product.published e product.card_refresh: pré-desenha post,
// story e carrossel da peça. Recebe as dependências (banco, storage, render,
// revalidação) para ser testável fora do Next e do Inngest.

import type { FileStorage } from "@/adapters/storage";
import type { DbOrTx } from "@/queue/enqueue";
import type { CardRenderer } from "@/services/bot-cards";
import { enqueueProductPublished, productCardEventPayloadSchema } from "@/services/product-cards-queue";
import { prerenderProductPosts, type PrerenderResult } from "@/services/product-posts";

export type ProductCardsDeps = {
  db: DbOrTx;
  storage: FileStorage;
  render: CardRenderer;
  /** Invalida a página pública da peça; fora do Next pode lançar (é engolido). */
  revalidate: (path: string) => void | Promise<void>;
  now?: () => Date;
};

/** Estreia marcada: espera pelo menos isto antes de olhar de novo (relógios diferem). */
export const RESCHEDULE_MIN_DELAY_MS = 60_000;

export async function runProductCardsPrerender(
  deps: ProductCardsDeps,
  event: { id: string; eventType: string; payload: Record<string, unknown> },
): Promise<PrerenderResult> {
  const payload = productCardEventPayloadSchema.parse(event.payload);
  const result = await prerenderProductPosts(deps.db, deps.storage, deps.render, {
    productId: payload.productId,
  });
  if (result.skipped !== null) {
    console.info(`[${event.eventType}] ${payload.productId} → skipped: ${result.skipped}`);
    // Estreia marcada: o desenho fica para a hora em que a peça aparece na
    // loja. A chave leva o id deste evento: se na hora a peça ainda parecer
    // agendada (relógio do banco à frente do da função), a próxima olhada
    // é um evento novo, nunca um duplicado descartado.
    if (result.skipped === "peca_agendada" && result.visibleFrom) {
      const now = (deps.now ?? (() => new Date()))();
      const at = new Date(Math.max(result.visibleFrom.getTime(), now.getTime() + RESCHEDULE_MIN_DELAY_MS));
      await enqueueProductPublished(deps.db, {
        productId: payload.productId,
        dedupeSuffix: `visible:${result.visibleFrom.getTime()}:from:${event.id}`,
        nextAttemptAt: at,
      });
    }
    return result;
  }
  console.info(`[${event.eventType}] ${payload.productId} → ${JSON.stringify(result)}`);
  // A vitrine tem ISR de 5 min: a prévia do link troca na hora. Fora do
  // Next (worker standalone, testes) revalidatePath pode lançar: só avisa.
  try {
    await deps.revalidate(`/produto/${result.slug}`);
  } catch (error) {
    console.warn(
      `[outbox] ${event.eventType} (event ${event.id}): revalidatePath indisponível neste contexto.`,
      error,
    );
  }
  return result;
}
