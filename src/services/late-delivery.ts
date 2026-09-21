// Cupom de desculpas pelo atraso do motoboy. O "Entregue" do motoboy
// (completeStopTx) enfileira delivery.stop_delivered na MESMA transação; o
// handler compara a hora real com a janela prometida e, se passou da
// carência, emite um cupom pessoal (idempotente pela dedupe_key) e agenda o
// aviso — separado do "entregue", com dedupe e janela de envio próprios. A
// decisão fica no handler, não na transação do motoboy: um bug aqui vai para
// a fila, nunca trava o "Entregue" no campo.
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { assessLateness, lateDeliveryCouponExpiry, lateDeliveryNote, minutesLateLabel, type Lateness } from "@/core/delivery/lateness";
import { auditLog, coupons, customers, deliveryStops, orders } from "@/db/schema";
import { enqueueOutboxEvent, type DbOrTx } from "@/queue/enqueue";
import { enqueueCouponIssued } from "@/services/coupon-notices";
import { issueCoupon } from "@/services/coupons";
import { getSettingsMap } from "@/services/settings";

export const STOP_DELIVERED_EVENT = "delivery.stop_delivered";
export const stopDeliveredPayloadSchema = z.object({ orderId: z.uuid(), stopId: z.uuid() });

export interface LateDeliverySettings {
  enabled: boolean;
  graceMinutes: number;
  percent: number;
  days: number;
}

export const LATE_DELIVERY_DEFAULTS: LateDeliverySettings = { enabled: false, graceMinutes: 30, percent: 10, days: 30 };

export async function loadLateDeliverySettings(db: DbOrTx): Promise<LateDeliverySettings> {
  const map = await getSettingsMap(db, [
    "late_delivery_coupon_enabled",
    "late_delivery_grace_minutes",
    "late_delivery_coupon_percent",
    "late_delivery_coupon_days",
  ]);
  const num = (key: string, fallback: number) => (typeof map[key] === "number" ? (map[key] as number) : fallback);
  return {
    enabled: map["late_delivery_coupon_enabled"] === true,
    graceMinutes: num("late_delivery_grace_minutes", LATE_DELIVERY_DEFAULTS.graceMinutes),
    percent: num("late_delivery_coupon_percent", LATE_DELIVERY_DEFAULTS.percent),
    days: num("late_delivery_coupon_days", LATE_DELIVERY_DEFAULTS.days),
  };
}

/** Chamado dentro de completeStopTx, logo depois do UPDATE de delivered_at. */
export async function enqueueStopDelivered(tx: DbOrTx, input: { orderId: string; stopId: string }): Promise<void> {
  await enqueueOutboxEvent(tx, {
    eventType: STOP_DELIVERED_EVENT,
    dedupeKey: `delivery.stop_delivered:${input.stopId}`,
    aggregateType: "order",
    aggregateId: input.orderId,
    payload: input,
  });
}

export type LateDeliveryResult =
  | { issued: true; couponId: string; code: string; minutesLate: number; created: boolean }
  | { skipped: "desligado" | "parada_inexistente" | "nao_entregue" | "sem_janela" | "no_prazo" | "pedido_cancelado"; minutesLate?: number };

/** Decide e emite. Idempotente: a dedupe_key late_delivery:<orderId> segura o retry. */
export async function issueLateDeliveryCoupon(db: DbOrTx, input: { stopId: string; now?: Date }): Promise<LateDeliveryResult> {
  const settings = await loadLateDeliverySettings(db);
  if (!settings.enabled) return { skipped: "desligado" };

  const [row] = await db
    .select({
      stopStatus: deliveryStops.status,
      deliveredAt: deliveryStops.deliveredAt,
      orderId: orders.id,
      orderStatus: orders.status,
      deliveryWindow: orders.deliveryWindow,
      customerId: orders.customerId,
      customerName: customers.fullName,
    })
    .from(deliveryStops)
    .innerJoin(orders, eq(orders.id, deliveryStops.orderId))
    .innerJoin(customers, eq(customers.id, orders.customerId))
    .where(eq(deliveryStops.id, input.stopId))
    .limit(1);
  if (!row) return { skipped: "parada_inexistente" };
  if (row.stopStatus !== "delivered" || !row.deliveredAt) return { skipped: "nao_entregue" };
  if (row.orderStatus === "canceled" || row.orderStatus === "refunded") return { skipped: "pedido_cancelado" };
  const window = row.deliveryWindow;
  if (!window) return { skipped: "sem_janela" };

  const lateness = assessLateness({ window, deliveredAt: row.deliveredAt, graceMinutes: settings.graceMinutes });
  if (!lateness.late) return { skipped: "no_prazo", minutesLate: lateness.minutesLate };

  const deliveredAt = row.deliveredAt;
  return db.transaction(async (tx) => {
    const issued = await issueCoupon(tx, {
      dedupeKey: `late_delivery:${row.orderId}`,
      customerId: row.customerId,
      origin: "late_delivery",
      type: "percent",
      value: settings.percent,
      expiresAt: lateDeliveryCouponExpiry(deliveredAt, settings.days),
      note: lateDeliveryNote({ minutesLate: lateness.minutesLate, window }),
      orderId: row.orderId,
      codePrefix: "DESCULPA",
      now: input.now,
    });
    if (issued.created) {
      await enqueueCouponIssued(tx, { couponId: issued.couponId, vars: { atraso: minutesLateLabel(lateness.minutesLate) } });
      await tx.insert(auditLog).values({
        actorType: "system",
        actorId: null,
        action: "coupon.late_delivery",
        entityType: "order",
        entityId: row.orderId,
        after: { couponId: issued.couponId, code: issued.code, minutesLate: lateness.minutesLate, percent: settings.percent },
      });
    }
    return { issued: true, couponId: issued.couponId, code: issued.code, minutesLate: lateness.minutesLate, created: issued.created };
  });
}

/** Para a página do pedido: atrasou? e o cupom de desculpas, se houver. */
export async function lateDeliveryForOrder(
  db: DbOrTx,
  orderId: string,
): Promise<{ lateness: Lateness; coupon: { code: string; value: number; expiresAt: Date | null; isActive: boolean } | null } | null> {
  const [row] = await db
    .select({ deliveryWindow: orders.deliveryWindow, deliveredAt: deliveryStops.deliveredAt })
    .from(orders)
    .innerJoin(deliveryStops, and(eq(deliveryStops.orderId, orders.id), eq(deliveryStops.status, "delivered")))
    .where(eq(orders.id, orderId))
    .limit(1);
  if (!row || !row.deliveredAt || !row.deliveryWindow) return null;
  const settings = await loadLateDeliverySettings(db);
  const lateness = assessLateness({ window: row.deliveryWindow, deliveredAt: row.deliveredAt, graceMinutes: settings.graceMinutes });
  const [coupon] = await db
    .select({ code: coupons.code, value: coupons.value, expiresAt: coupons.expiresAt, isActive: coupons.isActive })
    .from(coupons)
    .where(and(eq(coupons.orderId, orderId), eq(coupons.origin, "late_delivery")))
    .limit(1);
  return { lateness, coupon: coupon ?? null };
}
