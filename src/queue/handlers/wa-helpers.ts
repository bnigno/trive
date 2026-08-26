// Contexto de WhatsApp dos handlers de pedido: UMA busca de pedido + cliente
// + settings, compartilhada pelos marcos (store_created/paid/shipped). Os
// helpers de formatação das variáveis ({{nome}}, {{pedido}}, ...) são puros e
// vivem em wa-messaging (buildOrderVars) — a recuperação de não pagos usa os
// mesmos.
import { eq } from "drizzle-orm";

import { customers, orders, settings } from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { buildOrderVars } from "@/services/wa-messaging";

export interface OrderWaContext {
  orderId: string;
  /** 'cash' troca o template de confirmação (order_confirmed_cash). */
  paymentMethod: string | null;
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

  return {
    orderId: row.id,
    paymentMethod: row.paymentMethod,
    customer: {
      id: row.customerId,
      fullName: row.customerName,
      phoneE164: row.customerPhone,
    },
    vars: buildOrderVars({
      orderNumber: row.orderNumber,
      customerName: row.customerName,
      totalCents: row.totalCents,
      publicToken: row.publicToken,
      paymentDueAt: row.paymentDueAt,
      trackingCode: row.trackingCode,
      storeName,
      paymentMethod: row.paymentMethod,
    }),
  };
}
