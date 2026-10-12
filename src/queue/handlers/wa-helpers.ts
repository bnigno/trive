// Contexto de WhatsApp dos handlers de pedido: UMA busca de pedido + cliente
// + settings, compartilhada pelos marcos (store_created/paid/shipped). Os
// helpers de formatação das variáveis ({{nome}}, {{pedido}}, ...) são puros e
// vivem em wa-messaging (buildOrderVars) — a recuperação de não pagos usa os
// mesmos.
import { eq } from "drizzle-orm";

import { customers, orders, settings } from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { findAnnouncedPredecessor, findReplacedOrder } from "@/services/order-replacements";
import { buildOrderVars } from "@/services/wa-messaging";

export interface OrderWaContext {
  orderId: string;
  /** 'cash' troca o template de confirmação (order_confirmed_cash). */
  paymentMethod: string | null;
  /** Motoboy: o "enviado" vira "saiu da maison, chega hoje entre 19h e 21h". */
  hasDeliveryWindow: boolean;
  /** Pedido refeito: o antigo que este substituiu ("seu pedido #A foi atualizado e agora é o #B"). */
  replaces: { id: string; orderNumber: number } | null;
  /** Os pedidos refeitos desde o número que ela conhece até o anterior direto (o "o que mudou" soma todos). */
  redoHops: string[];
  customer: {
    id: string;
    fullName: string;
    phoneE164: string | null;
  };
  vars: Record<string, string>;
}

/**
 * Carrega o contexto de WhatsApp do pedido (ou null se o pedido sumiu — o
 * handler simplesmente não envia; o e-mail do mesmo evento já teria lançado).
 */
export async function loadOrderWaContext(
  db: DbOrTx,
  orderId: string,
): Promise<OrderWaContext | null> {
  const [row] = await db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      publicToken: orders.publicToken,
      paymentDueAt: orders.paymentDueAt,
      trackingCode: orders.shippingTrackingCode,
      paymentMethod: orders.paymentMethod,
      totalCents: orders.totalCents,
      isGift: orders.isGift,
      deliveryWindow: orders.deliveryWindow,
      customerId: customers.id,
      customerName: customers.fullName,
      customerPhone: customers.phoneE164,
    })
    .from(orders)
    .innerJoin(customers, eq(customers.id, orders.customerId))
    .where(eq(orders.id, orderId))
    .limit(1);
  if (!row) return null;

  const [storeNameRow] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, "store_name"))
    .limit(1);
  const storeName =
    typeof storeNameRow?.value === "string" && storeNameRow.value.trim() !== ""
      ? storeNameRow.value.trim()
      : undefined;
  const replaced = await findReplacedOrder(db, row.id);
  const announced = replaced ? await findAnnouncedPredecessor(db, row.id) : null;

  return {
    orderId: row.id,
    paymentMethod: row.paymentMethod,
    hasDeliveryWindow: row.deliveryWindow !== null,
    replaces: replaced
      ? { id: replaced.id, orderNumber: replaced.orderNumber }
      : null,
    redoHops: announced?.hops ?? [],
    customer: {
      id: row.customerId,
      fullName: row.customerName,
      phoneE164: row.customerPhone,
    },
    vars: {
      ...buildOrderVars({
        orderNumber: row.orderNumber,
        customerName: row.customerName,
        totalCents: row.totalCents,
        publicToken: row.publicToken,
        paymentDueAt: row.paymentDueAt,
        trackingCode: row.trackingCode,
        storeName,
        paymentMethod: row.paymentMethod,
        isGift: row.isGift,
        deliveryWindow: row.deliveryWindow,
        // {{dia}} vale pela hora em que a peça SAIU, não pela hora em que a
        // fila rodou (retry depois da meia-noite não vira "ontem").
        now: row.deliveryWindow?.dispatchedAt
          ? new Date(row.deliveryWindow.dispatchedAt)
          : undefined,
      }),
      ...(announced ? { pedido_anterior: String(announced.orderNumber) } : {}),
    },
  };
}
