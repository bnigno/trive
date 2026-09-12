// Quando o post, o story e o carrossel de uma peça precisam ser (re)desenhados
// em segundo plano. Dois eventos com o mesmo handler: `product.published`
// (a peça entrou na vitrine) e `product.card_refresh` (mudou algo que está
// no cartão: preço, nome, foto, edição). Ambos saem NA MESMA transação da
// mudança (regra 5) e só para peça ativa — rascunho não tem cartão.

import { and, eq, gt, inArray, isNull, max } from "drizzle-orm";
import { z } from "zod";

import { outboxEvents, products } from "@/db/schema";
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
/**
 * Uma peça de cada vez, com folga entre elas — inclusive entre chamadas
 * diferentes (aprovação de preços em lote, troca de edição): nunca há uma
 * fila de desenhos vencidos ao mesmo tempo represando o resto.
 */
export const CARD_REFRESH_STAGGER_MS = 20_000;
/**
 * Um refresh já agendado para a peça e ainda longe de vencer cobre qualquer
 * mudança feita até lá (o handler lê o estado na hora de rodar): não entra
 * outro. A folga evita a corrida com um lote que esteja reclamando agora.
 */
const ALREADY_SCHEDULED_MARGIN_MS = 5_000;

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
 * ignorada — quando for publicada, `product.published` desenha tudo. Peça
 * com refresh já agendado também: aquele vai ler o estado novo.
 * Devolve quantos eventos entraram.
 */
export async function enqueueProductCardRefresh(
  db: DbOrTx,
  input: { productIds: readonly string[]; reason: string; now?: Date },
): Promise<number> {
  const now = input.now ?? new Date();
  const unique = [...new Set(input.productIds)];
  const active = await activeProductIds(db, unique);
  if (active.length === 0) return 0;

  const scheduledRows = await db
    .select({ productId: outboxEvents.aggregateId })
    .from(outboxEvents)
    .where(
      and(
        eq(outboxEvents.eventType, PRODUCT_CARD_REFRESH_EVENT),
        inArray(outboxEvents.aggregateId, active),
        inArray(outboxEvents.status, ["pending", "failed"]),
        gt(outboxEvents.nextAttemptAt, new Date(now.getTime() + ALREADY_SCHEDULED_MARGIN_MS)),
      ),
    );
  const alreadyScheduled = new Set(scheduledRows.map((row) => row.productId));
  const ids = active.filter((id) => !alreadyScheduled.has(id));
  if (ids.length === 0) return 0;

  // Entra na fila atrás do último refresh já marcado: um desenho de cada vez.
  const [tail] = await db
    .select({ latest: max(outboxEvents.nextAttemptAt) })
    .from(outboxEvents)
    .where(
      and(
        eq(outboxEvents.eventType, PRODUCT_CARD_REFRESH_EVENT),
        inArray(outboxEvents.status, ["pending", "failed"]),
      ),
    );
  const earliest = now.getTime() + CARD_REFRESH_DELAY_MS;
  const afterTail = tail?.latest ? tail.latest.getTime() + CARD_REFRESH_STAGGER_MS : 0;
  const base = Math.max(earliest, afterTail);

  let queued = 0;
  for (const [index, productId] of ids.entries()) {
    const id = await enqueueOutboxEvent(db, {
      eventType: PRODUCT_CARD_REFRESH_EVENT,
      dedupeKey: `${PRODUCT_CARD_REFRESH_EVENT}:${productId}:${input.reason}:${now.getTime()}`,
      aggregateType: "product",
      aggregateId: productId,
      payload: { productId },
      nextAttemptAt: new Date(base + index * CARD_REFRESH_STAGGER_MS),
    });
    if (id) queued += 1;
  }
  return queued;
}
