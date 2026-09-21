// Cupom de desculpas pelo atraso: a hora real da parada × a janela prometida,
// a carência da dona, a emissão idempotente e o aviso (coupon.issued).
import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeMessagingProvider } from "@/adapters/zapi/fake";
import * as schema from "@/db/schema";
import { initialWaTemplates } from "@/db/seed-data";
import type { DbOrTx } from "@/queue/enqueue";
import { sendCouponIssuedWa } from "@/services/coupon-notices";
import { issueLateDeliveryCoupon, lateDeliveryForOrder } from "@/services/late-delivery";
import { createTestCustomer, createTestDb, FIXED_USER_ID, type TestDb } from "../helpers/db";

let db: TestDb;
let close: () => Promise<void>;
let sdb: DbOrTx;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  sdb = db as unknown as DbOrTx;
  await db.insert(schema.settings).values([
    { key: "late_delivery_coupon_enabled", value: true },
    { key: "late_delivery_grace_minutes", value: 30 },
    { key: "late_delivery_coupon_percent", value: 10 },
    { key: "late_delivery_coupon_days", value: 30 },
    { key: "wa_enabled", value: true },
  ]);
  const template = initialWaTemplates.find((row) => row.key === "late_delivery_coupon");
  if (!template) throw new Error("template late_delivery_coupon ausente no seed");
  await db.insert(schema.waTemplates).values({ key: template.key, label: template.label, bodyTemplate: template.bodyTemplate, variables: template.variables });
});

afterEach(async () => {
  await close();
});

// Janela de sábado 19/09/2026, 19h–21h (SP). Fim = 2026-09-20T00:00Z.
const WINDOW = { dayKey: "2026-09-19", start: "19:00", end: "21:00", cutoff: "17:00", rateName: "Motoboy Belém", label: "sábado 19/09, 19h–21h" };
const sp = (iso: string) => new Date(`${iso}-03:00`);
let couriers = 0;

async function deliveredOrder(input: { deliveredAt: Date; status?: string; optIn?: boolean; window?: typeof WINDOW | null }) {
  const customerId = await createTestCustomer(db, "Maria Aparecida");
  await db.update(schema.customers).set({ marketingOptIn: input.optIn ?? true }).where(eq(schema.customers.id, customerId));
  const [order] = await db
    .insert(schema.orders)
    .values({
      customerId,
      status: input.status ?? "delivered",
      paidAt: sp("2026-09-19T10:00:00"),
      deliveredAt: input.deliveredAt,
      subtotalCents: 15900,
      discountCents: 0,
      shippingCents: 1500,
      totalCents: 17400,
      deliveryWindow: input.window === undefined ? WINDOW : input.window,
    })
    .returning({ id: schema.orders.id, orderNumber: schema.orders.orderNumber });
  couriers += 1;
  const [courier] = await db
    .insert(schema.couriers)
    .values({ name: `Carlos ${couriers}`, phoneE164: `+55919876${String(couriers).padStart(4, "0")}` })
    .returning({ id: schema.couriers.id });
  const [run] = await db
    .insert(schema.deliveryRuns)
    .values({ courierId: courier.id, status: "finished", createdBy: FIXED_USER_ID, startedAt: sp("2026-09-19T18:00:00"), finishedAt: input.deliveredAt })
    .returning({ id: schema.deliveryRuns.id });
  const [stop] = await db
    .insert(schema.deliveryStops)
    .values({ runId: run.id, orderId: order.id, sequence: 1, destAddress: "Av. Nazaré, 100", status: "delivered", deliveredAt: input.deliveredAt })
    .returning({ id: schema.deliveryStops.id });
  return { customerId, orderId: order.id, orderNumber: order.orderNumber, stopId: stop.id };
}

async function outbox(eventType: string) {
  return (await db.select().from(schema.outboxEvents).orderBy(asc(schema.outboxEvents.createdAt))).filter((e) => e.eventType === eventType);
}

describe("issueLateDeliveryCoupon", () => {
  it("45 min depois da janela: cupom pessoal DESCULPA-…, aviso enfileirado, audit; rodar de novo não duplica", async () => {
    const { orderId, customerId, stopId } = await deliveredOrder({ deliveredAt: sp("2026-09-19T21:45:00") });

    const first = await issueLateDeliveryCoupon(sdb, { stopId, now: sp("2026-09-19T21:45:10") });
    expect(first).toMatchObject({ issued: true, minutesLate: 45, created: true });
    if (!("issued" in first)) throw new Error("esperava emissão");
    expect(first.code).toMatch(/^DESCULPA-[A-Z2-9]{5}$/);

    const [coupon] = await db.select().from(schema.coupons).where(eq(schema.coupons.id, first.couponId));
    expect(coupon).toMatchObject({
      origin: "late_delivery",
      type: "percent",
      value: 10,
      customerId,
      orderId,
      maxUses: 1,
      perCustomerLimit: 1,
      dedupeKey: `late_delivery:${orderId}`,
      expiresAt: sp("2026-10-19T21:45:00"),
    });
    expect(coupon.note).toBe("Entrega 45 min depois da janela (sábado, 19 de setembro, 19h–21h)");

    const issued = await outbox("coupon.issued");
    expect(issued).toHaveLength(1);
    expect(issued[0].payload).toEqual({ couponId: first.couponId, vars: { atraso: "45 min" } });
    expect(await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "coupon.late_delivery"))).toHaveLength(1);

    // Retry do handler: mesmo cupom, nada novo.
    const again = await issueLateDeliveryCoupon(sdb, { stopId });
    expect(again).toMatchObject({ issued: true, couponId: first.couponId, created: false });
    expect(await outbox("coupon.issued")).toHaveLength(1);
    expect(await db.select().from(schema.coupons)).toHaveLength(1);

    // A página do pedido vê o atraso e o cupom.
    const forOrder = await lateDeliveryForOrder(sdb, orderId);
    expect(forOrder?.lateness).toMatchObject({ late: true, minutesLate: 45 });
    expect(forOrder?.coupon).toMatchObject({ code: first.code, value: 10, isActive: true });
  });

  it("dentro da carência (20 min) não emite; sem janela não emite; desligado não emite; cancelado não emite", async () => {
    const onTime = await deliveredOrder({ deliveredAt: sp("2026-09-19T21:20:00") });
    expect(await issueLateDeliveryCoupon(sdb, { stopId: onTime.stopId })).toEqual({ skipped: "no_prazo", minutesLate: 20 });
    expect((await lateDeliveryForOrder(sdb, onTime.orderId))?.lateness).toMatchObject({ late: false, minutesLate: 20 });

    const correios = await deliveredOrder({ deliveredAt: sp("2026-09-19T23:00:00"), window: null });
    expect(await issueLateDeliveryCoupon(sdb, { stopId: correios.stopId })).toEqual({ skipped: "sem_janela" });

    const canceled = await deliveredOrder({ deliveredAt: sp("2026-09-19T23:00:00"), status: "canceled" });
    expect(await issueLateDeliveryCoupon(sdb, { stopId: canceled.stopId })).toEqual({ skipped: "pedido_cancelado" });

    expect(await issueLateDeliveryCoupon(sdb, { stopId: "00000000-0000-4000-8000-00000000dead" })).toEqual({ skipped: "parada_inexistente" });

    await db.update(schema.settings).set({ value: false }).where(eq(schema.settings.key, "late_delivery_coupon_enabled"));
    const late = await deliveredOrder({ deliveredAt: sp("2026-09-19T23:00:00") });
    expect(await issueLateDeliveryCoupon(sdb, { stopId: late.stopId })).toEqual({ skipped: "desligado" });
    expect(await db.select().from(schema.coupons)).toHaveLength(0);
  });
});

describe("sendCouponIssuedWa (coupon.issued)", () => {
  it("manda o template da origem com nome, código, valor, validade, pedido e atraso; dedupe por cupom", async () => {
    const { orderNumber, stopId } = await deliveredOrder({ deliveredAt: sp("2026-09-19T21:45:00") });
    const issued = await issueLateDeliveryCoupon(sdb, { stopId });
    if (!("issued" in issued)) throw new Error("esperava emissão");
    const provider = new FakeMessagingProvider();
    const now = sp("2026-09-20T10:00:00"); // dentro da janela 9–21

    const result = await sendCouponIssuedWa(sdb, provider, { couponId: issued.couponId, vars: { atraso: "45 min" }, now });
    expect(result).toMatchObject({ sent: true });
    expect(provider.sentMessages).toHaveLength(1);
    const body = provider.sentMessages[0].body;
    expect(body).toContain("Maria, desculpa pelo atraso");
    expect(body).toContain(`pedido #${orderNumber} passou 45 min da janela`);
    expect(body).toContain(`o cupom ${issued.code} vale 10% na sua próxima compra, até 19/10`);
    expect(body).toContain("responda SAIR");

    // Segundo envio (retry): o dedupe de wa_messages segura.
    expect(await sendCouponIssuedWa(sdb, provider, { couponId: issued.couponId, now })).toEqual({ skipped: "ja_enviado" });
    expect(provider.sentMessages).toHaveLength(1);
  });

  it("sem opt-in não avisa (o cupom existe do mesmo jeito); fora da janela re-enfileira datado; cupom desativado não avisa", async () => {
    const semOptIn = await deliveredOrder({ deliveredAt: sp("2026-09-19T21:45:00"), optIn: false });
    const a = await issueLateDeliveryCoupon(sdb, { stopId: semOptIn.stopId });
    if (!("issued" in a)) throw new Error("esperava emissão");
    const provider = new FakeMessagingProvider();
    expect(await sendCouponIssuedWa(sdb, provider, { couponId: a.couponId, now: sp("2026-09-20T10:00:00") })).toEqual({ skipped: "sem_opt_in" });
    expect(await db.select().from(schema.coupons).where(eq(schema.coupons.id, a.couponId))).toHaveLength(1);

    const tarde = await deliveredOrder({ deliveredAt: sp("2026-09-19T21:45:00") });
    const b = await issueLateDeliveryCoupon(sdb, { stopId: tarde.stopId });
    if (!("issued" in b)) throw new Error("esperava emissão");
    expect(await sendCouponIssuedWa(sdb, provider, { couponId: b.couponId, vars: { atraso: "45 min" }, now: sp("2026-09-19T21:50:00") })).toEqual({ skipped: "fora_da_janela" });
    const deferred = (await outbox("coupon.issued")).filter((e) => e.dedupeKey?.endsWith(":2026-09-19"));
    expect(deferred).toHaveLength(1);
    expect(deferred[0].payload).toEqual({ couponId: b.couponId, vars: { atraso: "45 min" } });
    expect(deferred[0].nextAttemptAt).toEqual(sp("2026-09-20T09:00:00"));
    expect(provider.sentMessages).toHaveLength(0);

    await db.update(schema.coupons).set({ isActive: false }).where(eq(schema.coupons.id, b.couponId));
    expect(await sendCouponIssuedWa(sdb, provider, { couponId: b.couponId, now: sp("2026-09-20T10:00:00") })).toEqual({ skipped: "inativo" });
    expect(await sendCouponIssuedWa(sdb, provider, { couponId: "00000000-0000-4000-8000-00000000dead", now: sp("2026-09-20T10:00:00") })).toEqual({ skipped: "cupom_inexistente" });
  });
});
