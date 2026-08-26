// Fase 3 — Processamento de eventos de pagamento do Mercado Pago.
//
// Princípios (plano da Fase 3):
// - O processador NUNCA confia no payload do webhook: sempre reconsulta a API
//   via gateway.getPayment e decide a partir do estado ATUAL do pedido, com
//   SELECT FOR UPDATE (transição guardada por estado).
// - Efeitos externos só via outbox na mesma transação; a própria consulta ao
//   gateway é o único efeito fora dela.
// - A taxa REAL do MP fecha o ciclo da precificação: gravamos em
//   orders.mp_fee_cents e comparamos com a estimativa da payment_fee_rules
//   vigente — divergência relevante vira evento 'mp.fee_divergent' (1x por
//   pedido) para o dono revisar a margem.
import { and, asc, desc, eq, gte, isNotNull, isNull, lt } from "drizzle-orm";
import { z } from "zod";

import type { PaymentGateway } from "@/adapters/mercadopago";
import {
  MP_PAYMENT_METHODS,
  type MpPaymentMethod,
} from "@/core/orders/payment-methods";
import type { OrderStatus } from "@/core/orders/state-machine";
import { auditLog, orders, paymentFeeRules } from "@/db/schema";
import { enqueueOutboxEvent, type DbOrTx } from "@/queue/enqueue";
import { ServiceError, transitionOrder } from "@/services/orders";

export { ServiceError };

/**
 * Métodos que o Mercado Pago pode reportar e sincronizar no pedido.
 * pix_manual/cash existem na coluna orders.payment_method mas nunca vêm da
 * API do MP — são marcados pelos fluxos manuais (bot/checkout).
 */
const ORDER_PAYMENT_METHODS = MP_PAYMENT_METHODS;
type OrderPaymentMethod = MpPaymentMethod;

/** Status em que o pagamento foi consumado (estoque já baixado). */
const PAID_LIKE_STATUSES: readonly OrderStatus[] = [
  "paid",
  "preparing",
  "shipped",
  "delivered",
];

export type PaymentEventAction =
  | "paid"
  | "refunded"
  | "chargeback_flagged"
  | "noop";

// ---------------------------------------------------------------------------
// processPaymentEvent
// ---------------------------------------------------------------------------

const processPaymentEventSchema = z.object({
  mpPaymentId: z.string().min(1, "Informe o id do pagamento do Mercado Pago."),
});

export type ProcessPaymentEventInput = z.input<
  typeof processPaymentEventSchema
>;

/**
 * Reconsulta o pagamento na API do MP e aplica o efeito no pedido:
 * - approved  && pending_payment → transitionOrder 'paid' (ator SISTEMA;
 *   estoque, financeiro e outbox acontecem no serviço de pedidos);
 * - approved  && já pago (ou além) → no-op idempotente;
 * - refunded  && pago/preparing/shipped/delivered → transitionOrder 'refunded'
 *   SEM devolução física de estoque (restock false — mercadoria pode não voltar);
 * - charged_back → NÃO transiciona: registra audit + outbox 'payment.chargeback'
 *   (dedupe por pedido) e o dono decide no admin;
 * - rejected/cancelled && pending_payment → nada (o cliente pode tentar de
 *   novo; a reserva expira sozinha pelo cron).
 * Sempre sincroniza mp_payment_id, payment_method, installments e mp_fee_cents
 * quando presentes, e compara a taxa real com a estimada (divergência → outbox).
 */
export async function processPaymentEvent(
  db: DbOrTx,
  gateway: PaymentGateway,
  input: ProcessPaymentEventInput,
): Promise<{ orderId: string; action: PaymentEventAction }> {
  const parsed = processPaymentEventSchema.parse(input);

  // Fonte da verdade é a API do MP — nunca o payload do webhook.
  const payment = await gateway.getPayment(parsed.mpPaymentId);

  const orderId = await resolveOrderId(
    db,
    payment.paymentId,
    payment.externalReference,
  );
  if (orderId === null) {
    // Vira failed→dead na fila (DLQ) — visível para investigação manual.
    throw new ServiceError(
      "ORDER_NOT_FOUND_FOR_PAYMENT",
      `Pedido não encontrado para o pagamento ${payment.paymentId}.`,
    );
  }

  return db.transaction(async (tx) => {
    const [order] = await tx
      .select()
      .from(orders)
      .where(eq(orders.id, orderId))
      .for("update");
    if (!order) {
      throw new ServiceError(
        "ORDER_NOT_FOUND_FOR_PAYMENT",
        `Pedido não encontrado para o pagamento ${payment.paymentId}.`,
      );
    }

    const from = order.status as OrderStatus;

    // (1) Sincroniza SEMPRE os dados do pagamento no pedido (quando vierem).
    // 'other' não entra em orders.payment_method (check constraint) — fica null.
    const method: OrderPaymentMethod | null = (
      ORDER_PAYMENT_METHODS as readonly string[]
    ).includes(payment.paymentMethod)
      ? (payment.paymentMethod as OrderPaymentMethod)
      : null;

    const updateSet: Partial<typeof orders.$inferInsert> = {};
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    const syncField = (
      field: "mpPaymentId" | "paymentMethod" | "installments" | "mpFeeCents",
      value: string | number,
    ) => {
      if (order[field] === value) return;
      before[field] = order[field];
      after[field] = value;
      updateSet[field] = value as never;
    };
    syncField("mpPaymentId", payment.paymentId);
    if (method !== null) syncField("paymentMethod", method);
    if (payment.installments !== null)
      syncField("installments", payment.installments);
    if (payment.feeCents !== null) syncField("mpFeeCents", payment.feeCents);

    if (Object.keys(updateSet).length > 0) {
      await tx
        .update(orders)
        .set({ ...updateSet, updatedAt: new Date() })
        .where(eq(orders.id, order.id));
      await tx.insert(auditLog).values({
        actorType: "system",
        actorId: null,
        action: "payment.sync",
        entityType: "order",
        entityId: order.id,
        before,
        after,
      });
    }

    // (2) Divergência entre taxa real e estimada (fecha o ciclo da precificação).
    if (payment.feeCents !== null && method !== null) {
      await checkFeeDivergence(tx, {
        orderId: order.id,
        orderNumber: order.orderNumber,
        totalCents: order.totalCents,
        method,
        installments: payment.installments,
        actualCents: payment.feeCents,
      });
    }

    // (3) Transição guardada pelo estado ATUAL do pedido.
    let action: PaymentEventAction = "noop";
    switch (payment.status) {
      case "approved":
        if (from === "pending_payment") {
          await transitionOrder(tx, {
            orderId: order.id,
            to: "paid",
            userId: null,
            reason: "Pagamento aprovado pelo Mercado Pago",
          });
          action = "paid";
        }
        // Já pago (ou além): reprocessamento/reenvio de webhook → no-op.
        // canceled/refunded (ex.: pagou após a reserva expirar): não há
        // transição válida — o dono resolve o estorno no admin (fase futura).
        break;

      case "refunded":
        if (PAID_LIKE_STATUSES.includes(from)) {
          await transitionOrder(tx, {
            orderId: order.id,
            to: "refunded",
            userId: null,
            reason: "Reembolso confirmado pelo Mercado Pago",
            // restock NÃO: devolução física ao estoque é decisão do dono.
          });
          action = "refunded";
        }
        break;

      case "charged_back":
        if (PAID_LIKE_STATUSES.includes(from)) {
          // NÃO transiciona automaticamente: chargeback é disputa, não
          // reembolso — o dono decide no admin. Flag via outbox (dedupe).
          const enqueuedId = await enqueueOutboxEvent(tx, {
            eventType: "payment.chargeback",
            dedupeKey: `payment.chargeback:${order.id}`,
            aggregateType: "order",
            aggregateId: order.id,
            payload: {
              orderId: order.id,
              orderNumber: order.orderNumber,
              mpPaymentId: payment.paymentId,
              totalCents: order.totalCents,
            },
          });
          if (enqueuedId !== null) {
            await tx.insert(auditLog).values({
              actorType: "system",
              actorId: null,
              action: "payment.chargeback",
              entityType: "order",
              entityId: order.id,
              after: {
                mpPaymentId: payment.paymentId,
                status: from,
              },
              reason: "Chargeback recebido do Mercado Pago",
            });
          }
          action = "chargeback_flagged";
        }
        break;

      // pending/in_mediation: aguardar; rejected/cancelled com pedido
      // pending_payment: nada — o cliente pode tentar pagar de novo e a
      // reserva expira sozinha (cron reservation-expiry).
      default:
        break;
    }

    return { orderId: order.id, action };
  });
}

async function resolveOrderId(
  db: DbOrTx,
  paymentId: string,
  externalReference: string | null,
): Promise<string | null> {
  const [byPayment] = await db
    .select({ id: orders.id })
    .from(orders)
    .where(eq(orders.mpPaymentId, paymentId))
    .limit(1);
  if (byPayment) return byPayment.id;

  const ref = z.uuid().safeParse(externalReference ?? "");
  if (!ref.success) return null;
  const [byRef] = await db
    .select({ id: orders.id })
    .from(orders)
    .where(eq(orders.id, ref.data))
    .limit(1);
  return byRef?.id ?? null;
}

/**
 * Compara a taxa REAL cobrada pelo MP com a estimada pela payment_fee_rules
 * vigente do método (a mesma base usada na precificação). Divergência acima de
 * max(50 centavos, 10% da estimada) → outbox 'mp.fee_divergent' (1x por
 * pedido, via dedupeKey) + audit, para o dono revisar a margem prevista.
 */
async function checkFeeDivergence(
  tx: DbOrTx,
  input: {
    orderId: string;
    orderNumber: number;
    totalCents: number;
    method: OrderPaymentMethod;
    installments: number | null;
    actualCents: number;
  },
): Promise<void> {
  // Vigente = effective_to IS NULL; entre as regras do método, a de menor
  // installments_max que cubra o parcelamento usado (regra mais específica).
  const [rule] = await tx
    .select({
      percentRate: paymentFeeRules.percentRate,
      fixedFeeCents: paymentFeeRules.fixedFeeCents,
    })
    .from(paymentFeeRules)
    .where(
      and(
        eq(paymentFeeRules.paymentMethod, input.method),
        isNull(paymentFeeRules.effectiveTo),
        gte(paymentFeeRules.installmentsMax, input.installments ?? 1),
      ),
    )
    .orderBy(
      asc(paymentFeeRules.installmentsMax),
      desc(paymentFeeRules.effectiveFrom),
    )
    .limit(1);
  if (!rule) return; // Sem regra vigente do método → sem estimativa p/ comparar.

  const estimatedCents =
    Math.round(input.totalCents * Number(rule.percentRate)) +
    rule.fixedFeeCents;
  const toleranceCents = Math.max(50, Math.round(estimatedCents * 0.1));
  if (Math.abs(input.actualCents - estimatedCents) <= toleranceCents) return;

  const enqueuedId = await enqueueOutboxEvent(tx, {
    eventType: "mp.fee_divergent",
    dedupeKey: `mp.fee_divergent:${input.orderId}`,
    aggregateType: "order",
    aggregateId: input.orderId,
    payload: {
      orderId: input.orderId,
      estimatedCents,
      actualCents: input.actualCents,
    },
  });
  if (enqueuedId !== null) {
    await tx.insert(auditLog).values({
      actorType: "system",
      actorId: null,
      action: "payment.fee_divergent",
      entityType: "order",
      entityId: input.orderId,
      after: {
        orderNumber: input.orderNumber,
        estimatedCents,
        actualCents: input.actualCents,
        toleranceCents,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// reconcilePendingMpOrders — rede de segurança diária contra webhook perdido
// ---------------------------------------------------------------------------

const reconcilePendingMpOrdersSchema = z.object({
  limit: z.number().int().positive().max(200).default(30),
});

export type ReconcilePendingMpOrdersInput = z.input<
  typeof reconcilePendingMpOrdersSchema
>;

export interface ReconcilePendingMpOrdersResult {
  scanned: number;
  processed: number;
  paid: number;
  skipped: number;
  failed: number;
}

/**
 * Varre pedidos da loja em pending_payment com preferência do MP criada há
 * mais de 10 min e reprocessa os que já têm mp_payment_id conhecido (webhook
 * pode ter chegado e o processamento falhado, ou o reenvio se perdido).
 *
 * LIMITAÇÃO (proposital): sem mp_payment_id ainda, o pedido é PULADO — o
 * webhook é o caminho normal. A busca por external_reference via
 * GET /v1/payments/search entra quando houver credencial real para validar o
 * shape da resposta (produção ainda sem credenciais do MP).
 */
export async function reconcilePendingMpOrders(
  db: DbOrTx,
  gateway: PaymentGateway,
  input: ReconcilePendingMpOrdersInput = {},
): Promise<ReconcilePendingMpOrdersResult> {
  const parsed = reconcilePendingMpOrdersSchema.parse(input);
  const cutoff = new Date(Date.now() - 10 * 60_000);

  const rows = await db
    .select({ id: orders.id, mpPaymentId: orders.mpPaymentId })
    .from(orders)
    .where(
      and(
        eq(orders.status, "pending_payment"),
        eq(orders.channel, "store"),
        isNotNull(orders.mpPreferenceId),
        lt(orders.createdAt, cutoff),
      ),
    )
    .orderBy(asc(orders.createdAt))
    .limit(parsed.limit);

  const result: ReconcilePendingMpOrdersResult = {
    scanned: rows.length,
    processed: 0,
    paid: 0,
    skipped: 0,
    failed: 0,
  };

  for (const row of rows) {
    if (!row.mpPaymentId) {
      result.skipped += 1;
      continue;
    }
    try {
      const { action } = await processPaymentEvent(db, gateway, {
        mpPaymentId: row.mpPaymentId,
      });
      result.processed += 1;
      if (action === "paid") result.paid += 1;
    } catch (error) {
      result.failed += 1;
      console.warn(
        `[conciliação MP] falha ao reprocessar pedido ${row.id}:`,
        error,
      );
    }
  }

  return result;
}
