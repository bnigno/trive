// Avisos de pedido que não existiam: cancelamento e reembolso para a cliente,
// chargeback e taxa divergente para o dono. Mesma regra dos marcos de pedido
// (src/queue/handlers): skip nunca lança; só falha real do provedor lança e
// o retry da fila reprocessa com idempotência (dedupe_key UNIQUE).
import { eq } from "drizzle-orm";
import { z } from "zod";

import type { MessagingProvider } from "@/adapters/zapi";
import { friendlyCancelReason } from "@/core/orders/reasons";
import { customers, orders } from "@/db/schema";
import { formatCentsBRL } from "@/lib/money";
import type { DbOrTx } from "@/queue/enqueue";
import { getSettingsMap } from "@/services/settings";
import {
  buildOrderVars,
  sendTemplateMessage,
  sendToOwner,
  type SendWaMessageResult,
} from "@/services/wa-messaging";

export const ORDER_CANCELED_TEMPLATE_KEY = "order_canceled";
export const ORDER_REFUNDED_TEMPLATE_KEY = "order_refunded";
export const OWNER_CHARGEBACK_TEMPLATE_KEY = "owner_chargeback";
export const OWNER_FEE_DIVERGENT_TEMPLATE_KEY = "owner_fee_divergent";
export const OWNER_AMOUNT_DIVERGENT_TEMPLATE_KEY = "owner_amount_divergent";

export type OrderNoticeResult =
  | SendWaMessageResult
  | { skipped: "pedido_inexistente" | "sem_telefone" | "status_diferente" };

const orderIdSchema = z.object({ orderId: z.uuid() });

async function loadOrderNoticeContext(db: DbOrTx, orderId: string) {
  const [row] = await db
    .select({
      status: orders.status,
      orderNumber: orders.orderNumber,
      publicToken: orders.publicToken,
      paymentDueAt: orders.paymentDueAt,
      trackingCode: orders.shippingTrackingCode,
      totalCents: orders.totalCents,
      paymentMethod: orders.paymentMethod,
      cancelReason: orders.cancelReason,
      isGift: orders.isGift,
      customerId: customers.id,
      customerName: customers.fullName,
      phoneE164: customers.phoneE164,
    })
    .from(orders)
    .innerJoin(customers, eq(customers.id, orders.customerId))
    .where(eq(orders.id, orderId))
    .limit(1);
  if (!row) return null;

  const settings = await getSettingsMap(db, ["store_name"]);
  const storeName =
    typeof settings["store_name"] === "string" && settings["store_name"].trim() !== ""
      ? settings["store_name"].trim()
      : undefined;
  const vars = buildOrderVars({
    orderNumber: row.orderNumber,
    customerName: row.customerName,
    totalCents: row.totalCents,
    publicToken: row.publicToken,
    paymentDueAt: row.paymentDueAt,
    trackingCode: row.trackingCode,
    paymentMethod: row.paymentMethod,
    isGift: row.isGift,
    ...(storeName ? { storeName } : {}),
  });
  return { ...row, vars };
}

/** Cliente: "seu pedido #N foi cancelado — motivo amigável — link". Só com opt-in. */
export async function sendOrderCanceledWa(
  db: DbOrTx,
  provider: MessagingProvider,
  input: { orderId: string },
): Promise<OrderNoticeResult> {
  const { orderId } = orderIdSchema.parse(input);
  const ctx = await loadOrderNoticeContext(db, orderId);
  if (!ctx) return { skipped: "pedido_inexistente" };
  if (ctx.status !== "canceled") return { skipped: "status_diferente" };
  if (!ctx.phoneE164) return { skipped: "sem_telefone" };
  return sendTemplateMessage(db, provider, {
    templateKey: ORDER_CANCELED_TEMPLATE_KEY,
    phoneE164: ctx.phoneE164,
    vars: { ...ctx.vars, motivo: friendlyCancelReason(ctx.cancelReason) },
    customerId: ctx.customerId,
    orderId,
    dedupeKey: `wa.order_canceled:${orderId}`,
    requireOptIn: true,
  });
}

/** Cliente: reembolso confirmado pelo Mercado Pago. Só com opt-in. */
export async function sendOrderRefundedWa(
  db: DbOrTx,
  provider: MessagingProvider,
  input: { orderId: string },
): Promise<OrderNoticeResult> {
  const { orderId } = orderIdSchema.parse(input);
  const ctx = await loadOrderNoticeContext(db, orderId);
  if (!ctx) return { skipped: "pedido_inexistente" };
  if (ctx.status !== "refunded") return { skipped: "status_diferente" };
  if (!ctx.phoneE164) return { skipped: "sem_telefone" };
  return sendTemplateMessage(db, provider, {
    templateKey: ORDER_REFUNDED_TEMPLATE_KEY,
    phoneE164: ctx.phoneE164,
    vars: ctx.vars,
    customerId: ctx.customerId,
    orderId,
    dedupeKey: `wa.order_refunded:${orderId}`,
    requireOptIn: true,
  });
}

/** Dono: chargeback sinalizado pelo MP (nenhuma transição automática). */
export async function notifyOwnerChargeback(
  db: DbOrTx,
  provider: MessagingProvider,
  input: { orderId: string },
): Promise<OrderNoticeResult> {
  const { orderId } = orderIdSchema.parse(input);
  const ctx = await loadOrderNoticeContext(db, orderId);
  if (!ctx) return { skipped: "pedido_inexistente" };
  return sendToOwner(db, provider, {
    templateKey: OWNER_CHARGEBACK_TEMPLATE_KEY,
    vars: ctx.vars,
    dedupeKey: `wa.owner_chargeback:${orderId}`,
  });
}

const feeDivergentSchema = orderIdSchema.extend({
  estimatedCents: z.number().int().min(0),
  actualCents: z.number().int().min(0),
});

/** Dono: taxa real do MP diferente da estimada na precificação. */
export async function notifyOwnerFeeDivergent(
  db: DbOrTx,
  provider: MessagingProvider,
  input: { orderId: string; estimatedCents: number; actualCents: number },
): Promise<OrderNoticeResult> {
  const parsed = feeDivergentSchema.parse(input);
  const ctx = await loadOrderNoticeContext(db, parsed.orderId);
  if (!ctx) return { skipped: "pedido_inexistente" };
  const difference = parsed.actualCents - parsed.estimatedCents;
  return sendToOwner(db, provider, {
    templateKey: OWNER_FEE_DIVERGENT_TEMPLATE_KEY,
    vars: {
      ...ctx.vars,
      estimada: formatCentsBRL(parsed.estimatedCents),
      real: formatCentsBRL(parsed.actualCents),
      diferenca: `${difference > 0 ? "+" : difference < 0 ? "-" : ""}${formatCentsBRL(Math.abs(difference))}`,
    },
    dedupeKey: `wa.owner_fee_divergent:${parsed.orderId}`,
  });
}

const amountDivergentSchema = orderIdSchema.extend({
  expectedCents: z.number().int().min(0),
  paidCents: z.number().int().min(0),
});

/** Dono: o Mercado Pago recebeu valor diferente do total do pedido. */
export async function notifyOwnerAmountDivergent(
  db: DbOrTx,
  provider: MessagingProvider,
  input: { orderId: string; expectedCents: number; paidCents: number },
): Promise<OrderNoticeResult> {
  const parsed = amountDivergentSchema.parse(input);
  const ctx = await loadOrderNoticeContext(db, parsed.orderId);
  if (!ctx) return { skipped: "pedido_inexistente" };
  const difference = parsed.paidCents - parsed.expectedCents;
  return sendToOwner(db, provider, {
    templateKey: OWNER_AMOUNT_DIVERGENT_TEMPLATE_KEY,
    vars: {
      ...ctx.vars,
      esperado: formatCentsBRL(parsed.expectedCents),
      pago: formatCentsBRL(parsed.paidCents),
      diferenca: `${difference > 0 ? "+" : difference < 0 ? "-" : ""}${formatCentsBRL(Math.abs(difference))}`,
    },
    dedupeKey: `wa.owner_amount_divergent:${parsed.orderId}`,
  });
}
