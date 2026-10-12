// A cadeia dos pedidos refeitos (#A → #B → #C): quem este substituiu e onde
// a cadeia termina. Só leitura, sem dependência de outros services — o
// checkout (página pública), os avisos e o próprio refazer usam.
import { and, eq, inArray } from "drizzle-orm";

import { orders, waMessages } from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";

/** O pedido que este substituiu (para os avisos do pedido novo), ou null. */
export async function findReplacedOrder(db: DbOrTx, newOrderId: string): Promise<{ id: string; orderNumber: number; giftRecipientName: string | null; giftMessage: string | null } | null> {
  const [row] = await db
    .select({ id: orders.id, orderNumber: orders.orderNumber, giftRecipientName: orders.giftRecipientName, giftMessage: orders.giftMessage })
    .from(orders)
    .where(eq(orders.replacedByOrderId, newOrderId))
    .limit(1);
  return row ?? null;
}

const REPLACEMENT_CHAIN_MAX = 20;

/** O fim da cadeia de pedidos refeitos a partir deste (#A → #B → #C devolve o #C), ou null se ele nunca foi refeito. */
export async function findLatestReplacement(
  db: DbOrTx,
  orderId: string,
): Promise<{ id: string; orderNumber: number; status: string; publicToken: string } | null> {
  let latest: { id: string; orderNumber: number; status: string; publicToken: string } | null = null;
  let nextId: string | null = orderId;
  for (let hop = 0; nextId && hop <= REPLACEMENT_CHAIN_MAX; hop += 1) {
    const [row] = await db
      .select({ id: orders.id, orderNumber: orders.orderNumber, status: orders.status, publicToken: orders.publicToken, replacedByOrderId: orders.replacedByOrderId })
      .from(orders)
      .where(eq(orders.id, nextId))
      .limit(1);
    if (!row) break;
    if (hop > 0) latest = { id: row.id, orderNumber: row.orderNumber, status: row.status, publicToken: row.publicToken };
    nextId = row.replacedByOrderId;
  }
  return latest;
}

/** Página do pedido no painel: "Substituído pelo #B" e "Refeito a partir do #A". */
export async function getOrderReplacementLinks(
  db: DbOrTx,
  order: { id: string; replacedByOrderId: string | null },
): Promise<{ replacedBy: { id: string; orderNumber: number } | null; replaces: { id: string; orderNumber: number } | null }> {
  const [replacedBy] = order.replacedByOrderId
    ? await db.select({ id: orders.id, orderNumber: orders.orderNumber }).from(orders).where(eq(orders.id, order.replacedByOrderId)).limit(1)
    : [];
  const replaces = await findReplacedOrder(db, order.id);
  return { replacedBy: replacedBy ?? null, replaces: replaces ? { id: replaces.id, orderNumber: replaces.orderNumber } : null };
}

/**
 * O número que ela conhece: o último pedido da cadeia antes deste cuja
 * confirmação (ou "foi atualizado") saiu de fato. Refeito duas vezes em
 * segundos, o do meio nunca chegou a ela — "seu pedido #B foi atualizado"
 * citaria um número que ela nunca viu. Sem nenhum anunciado, o anterior direto.
 * `hops` = os pedidos refeitos desde esse número até o anterior direto, em
 * ordem: o "o que mudou" soma as mudanças de todos.
 */
export async function findAnnouncedPredecessor(
  db: DbOrTx,
  orderId: string,
): Promise<{ id: string; orderNumber: number; hops: string[] } | null> {
  const direct = await findReplacedOrder(db, orderId);
  const walked: string[] = [];
  let current = direct;
  for (let hop = 0; current && hop < 20; hop += 1) {
    walked.push(current.id);
    const [announced] = await db
      .select({ id: waMessages.id })
      .from(waMessages)
      .where(
        and(
          inArray(waMessages.dedupeKey, [`wa.order_confirmed:${current.id}`, `wa.order_updated:${current.id}`]),
          inArray(waMessages.status, ["sent", "delivered", "read"]),
        ),
      )
      .limit(1);
    if (announced) return { id: current.id, orderNumber: current.orderNumber, hops: [...walked].reverse() };
    current = await findReplacedOrder(db, current.id);
  }
  return direct ? { id: direct.id, orderNumber: direct.orderNumber, hops: [direct.id] } : null;
}
