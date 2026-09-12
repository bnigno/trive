// Quando o post, o story e o carrossel de uma peça precisam ser (re)desenhados
// em segundo plano. Dois eventos com o mesmo handler: `product.published`
// (a peça entrou na vitrine) e `product.card_refresh` (mudou algo que está
// no cartão: preço, nome, foto, edição). Ambos saem NA MESMA transação da
// mudança (regra 5) e só para peça ativa — rascunho não tem cartão.

import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";

import { products } from "@/db/schema";
import { enqueueOutboxEvent, type DbOrTx } from "@/queue/enqueue";

export const PRODUCT_PUBLISHED_EVENT = "product.published";
export const PRODUCT_CARD_REFRESH_EVENT = "product.card_refresh";

/** O payload dos dois eventos — o handler faz o parse com este mesmo schema. */
export const productCardEventPayloadSchema = z.object({ productId: z.uuid() });

/**
 * Atualizações entram um pouco depois na fila para não passar na frente do
 * que a cliente espera (recibo, resposta da vendedora): a fila é FIFO por
 * next_attempt_at.
 */
export const CARD_REFRESH_DELAY_MS = 30_000;
/** Várias peças de uma vez (troca de edição): uma a cada tanto, sem lote. */
export const CARD_REFRESH_STAGGER_MS = 20_000;

async function activeProductIds(db: DbOrTx, productIds: readonly string[]): Promise<string[]> {
  if (productIds.length === 0) return [];
  const rows = await db
    .select({ id: products.id })
    .from(products)
    .where(
      and(
        inArray(products.id, [...productIds]),
        eq(products.status, "active"),
        isNull(products.deletedAt),
      ),
    );
  return rows.map((row) => row.id);
}

/**
 * A peça entrou na vitrine (ativação, lançamento publicado ou cancelado):
 * pré-desenha post, story e carrossel. `dedupeSuffix` distingue a ocasião
 * (o `updatedAt` da ativação, o id do lançamento) para que publicar de novo
 * gere evento novo e o retry nunca duplique.
 */
export async function enqueueProductPublished(
  db: DbOrTx,
  input: { productId: string; dedupeSuffix: string; nextAttemptAt?: Date },
): Promise<string | null> {
  return enqueueOutboxEvent(db, {
    eventType: PRODUCT_PUBLISHED_EVENT,
    dedupeKey: `${PRODUCT_PUBLISHED_EVENT}:${input.productId}:${input.dedupeSuffix}`,
    aggregateType: "product",
    aggregateId: input.productId,
    payload: { productId: input.productId },
    ...(input.nextAttemptAt ? { nextAttemptAt: input.nextAttemptAt } : {}),
  });
}

/**
 * Algo que está no cartão mudou (preço, nome, foto, cor da foto, edição):
 * redesenha o que mudou e troca a prévia do link. Peça que não está ativa é
 * ignorada — quando for publicada, `product.published` desenha tudo.
 * Devolve quantos eventos entraram.
 */
export async function enqueueProductCardRefresh(
  db: DbOrTx,
  input: { productIds: readonly string[]; reason: string; now?: Date },
): Promise<number> {
  const now = input.now ?? new Date();
  const ids = await activeProductIds(db, input.productIds);
  let queued = 0;
  for (const [index, productId] of ids.entries()) {
    const id = await enqueueOutboxEvent(db, {
      eventType: PRODUCT_CARD_REFRESH_EVENT,
      dedupeKey: `${PRODUCT_CARD_REFRESH_EVENT}:${productId}:${input.reason}:${now.getTime()}`,
      aggregateType: "product",
      aggregateId: productId,
      payload: { productId },
      nextAttemptAt: new Date(now.getTime() + CARD_REFRESH_DELAY_MS + index * CARD_REFRESH_STAGGER_MS),
    });
    if (id) queued += 1;
  }
  return queued;
}
