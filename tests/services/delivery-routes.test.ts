// Rota do dia com banco real (PGlite): listagem agrupada, "Saiu"
// (paid → preparing → shipped numa transação, UM evento order.shipped),
// reagendamento com audit e o contexto do WhatsApp com {{janela}}.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";

import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { loadOrderWaContext } from "@/queue/handlers/wa-helpers";
import {
  addressLineOf,
  countRouteOfDay,
  dispatchOrder,
  listMotoboyWindows,
  listRouteOfDay,
  rescheduleOrderWindow,
} from "@/services/delivery-routes";
import { ServiceError, transitionOrder } from "@/services/orders";
import { createStoreOrder, type CreateStoreOrderInput } from "@/services/store-orders";
import { createTestDb, createTestVariant, FIXED_USER_ID, type TestDb } from "../helpers/db";

let db: TestDb;
let close: () => Promise<void>;
let sdb: DbOrTx;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  sdb = db as unknown as DbOrTx;
});

afterEach(async () => {
  await close();
});

const VALID_CPF = "529.982.247-25";
const WINDOWS = [
  { start: "16:00", end: "19:00", cutoff: "13:00" },
  { start: "19:00", end: "21:00", cutoff: "17:00" },
];
const MORNING = new Date("2026-09-18T13:30:00Z"); // 10:30 SP, sexta 18/09

async function activatePrice(variantId: string, priceCents: number): Promise<void> {
  await db.insert(schema.priceVersions).values({
    productVariantId: variantId,
    versionNumber: 1,
    status: "active",
    priceCents,
    origin: "initial",
    breakdown: {},
    costSnapshotCents: 1000,
    computedMarginRate: "0.3000",
    activatedAt: new Date(),
  });
}

async function setup(opts: { kind?: "motoboy" | "correios" } = {}) {
  const suffix = opts.kind === "correios" ? "PAC" : "MOTO";
  const { variantId } = await createTestVariant(db, { sku: `LONGO-DUNAS-${suffix}`, costCents: 1200, onHand: 10, name: `Longo Dunas ${suffix}` });
  await activatePrice(variantId, 15900);
  const [rate] = await db
    .insert(schema.shippingRates)
    .values(
      opts.kind === "correios"
        ? { name: "PAC", priceCents: 1990 }
        : { name: "Motoboy Belém", priceCents: 1500, kind: "motoboy", deliveryWindows: WINDOWS, deliveryDaysMin: 0, deliveryDaysMax: 0 },
    )
    .returning({ id: schema.shippingRates.id });
  return { variantId, rateId: rate.id };
}

function input(variantId: string, rateId: string, over: Partial<CreateStoreOrderInput> = {}): CreateStoreOrderInput {
  return {
    customer: { fullName: "Ana Souza", document: VALID_CPF, phone: "(91) 98888-1234", email: "ana@example.com", marketingOptIn: true },
    address: { postalCode: "66050-000", street: "Av. Nazaré", number: "100", complement: "apto 12", district: "Nazaré", city: "Belém", state: "PA" },
    items: [{ variantId, quantity: 1, expectedUnitPriceCents: 15900 }],
    shippingRateId: rateId,
    expectedShippingCents: 1500,
    ...over,
  };
}

async function paidMotoboyOrder(variantId: string, rateId: string, dayKey: string, w = WINDOWS[1], now = MORNING) {
  const created = await createStoreOrder(sdb, input(variantId, rateId, { deliveryWindow: { dayKey, ...w } }), { now });
  await transitionOrder(sdb, { orderId: created.orderId, to: "paid", userId: FIXED_USER_ID });
  return created;
}

async function outboxTypes(orderId: string): Promise<string[]> {
  const rows = await db
    .select({ eventType: schema.outboxEvents.eventType })
    .from(schema.outboxEvents)
    .where(eq(schema.outboxEvents.aggregateId, orderId))
    .orderBy(asc(schema.outboxEvents.createdAt));
  return rows.map((r) => r.eventType);
}

describe("listRouteOfDay", () => {
  it("agrupa por janela de hoje, com endereço, itens, dinheiro a receber e 'pagou depois do limite'", async () => {
    const { variantId, rateId } = await setup();
    const today = await paidMotoboyOrder(variantId, rateId, "2026-09-18", WINDOWS[1]);
    const tomorrow = await paidMotoboyOrder(variantId, rateId, "2026-09-19", WINDOWS[0]);
    // Dinheiro na entrega, janela das 16h: pago (baixa manual) às 14h SP — depois das 13h.
    const cash = await createStoreOrder(
      sdb,
      input(variantId, rateId, { deliveryWindow: { dayKey: "2026-09-18", ...WINDOWS[0] }, paymentMethod: "cash" }),
      { now: MORNING },
    );
    await transitionOrder(sdb, { orderId: cash.orderId, to: "paid", userId: FIXED_USER_ID });
    await db.update(schema.orders).set({ paidAt: new Date("2026-09-18T17:00:00Z") }).where(eq(schema.orders.id, cash.orderId));
    // Pedido ainda não pago não entra na rota.
    await createStoreOrder(sdb, input(variantId, rateId, { deliveryWindow: { dayKey: "2026-09-18", ...WINDOWS[1] } }), { now: MORNING });

    const route = await listRouteOfDay(sdb, { now: new Date("2026-09-18T14:00:00Z") });
    expect(route.todayKey).toBe("2026-09-18");
    expect(route.late).toEqual([]);
    expect(route.today.map((g) => [g.label, g.orders.map((o) => o.orderNumber)])).toEqual([
      ["16h–19h", [cash.orderNumber]],
      ["19h–21h", [today.orderNumber]],
    ]);
    expect(route.upcoming.map((d) => [d.dayKey, d.windows[0].orders.map((o) => o.orderNumber)])).toEqual([["2026-09-19", [tomorrow.orderNumber]]]);
    expect(route.todayCount).toBe(2);

    const cashRow = route.today[0].orders[0];
    expect(cashRow).toMatchObject({
      customerName: "Ana Souza",
      phoneE164: "+5591988881234",
      addressLine: "Av. Nazaré, 100, apto 12 — Nazaré, Belém",
      postalCode: "66050000",
      itemsCount: 1,
      itemsSummary: ["Longo Dunas MOTO"],
      paymentMethod: "cash",
      collectCashCents: 15900 + 1500,
      paidAfterCutoff: true,
      windowLabel: "sexta 18/09, 16h–19h",
    });
    expect(route.today[1].orders[0]).toMatchObject({ collectCashCents: null, paidAfterCutoff: false });

    // No dia seguinte o pedido de hoje que não saiu vira atrasado; o de amanhã vira hoje.
    const nextDay = await listRouteOfDay(sdb, { now: new Date("2026-09-19T12:00:00Z") });
    expect(nextDay.late.map((o) => o.orderNumber).sort()).toEqual([cash.orderNumber, today.orderNumber].sort());
    expect(nextDay.today[0].orders.map((o) => o.orderNumber)).toEqual([tomorrow.orderNumber]);
    expect(await countRouteOfDay(sdb, { now: new Date("2026-09-19T12:00:00Z") })).toEqual({ today: 1, late: 2 });
  });

  it("addressLineOf tolera retrato incompleto ou lixo", () => {
    expect(addressLineOf({ street: "Rua A", number: "1", district: "Centro", city: "Belém" })).toEqual({ line: "Rua A, 1 — Centro, Belém", postalCode: null });
    expect(addressLineOf({ street: "Rua A" })).toEqual({ line: "Rua A", postalCode: null });
    expect(addressLineOf(null)).toEqual({ line: null, postalCode: null });
    expect(addressLineOf("x")).toEqual({ line: null, postalCode: null });
  });
});

describe("dispatchOrder ('Saiu')", () => {
  it("paid → preparing → shipped numa transação: dois registros de histórico, UM order.shipped; segunda vez é idempotente", async () => {
    const { variantId, rateId } = await setup();
    const created = await paidMotoboyOrder(variantId, rateId, "2026-09-18");

    const result = await dispatchOrder(sdb, { orderId: created.orderId, userId: FIXED_USER_ID });
    expect(result).toMatchObject({ from: "paid", to: "shipped", idempotent: false });

    const [order] = await db.select().from(schema.orders).where(eq(schema.orders.id, created.orderId));
    expect(order.status).toBe("shipped");
    expect(order.shippedAt).not.toBeNull();

    const history = await db
      .select({ from: schema.orderStatusHistory.fromStatus, to: schema.orderStatusHistory.toStatus })
      .from(schema.orderStatusHistory)
      .where(eq(schema.orderStatusHistory.orderId, created.orderId))
      .orderBy(asc(schema.orderStatusHistory.createdAt));
    expect(history.slice(-2)).toEqual([
      { from: "paid", to: "preparing" },
      { from: "preparing", to: "shipped" },
    ]);
    const types = await outboxTypes(created.orderId);
    expect(types.filter((t) => t === "order.shipped")).toHaveLength(1);
    expect(types).toContain("order.preparing");

    const again = await dispatchOrder(sdb, { orderId: created.orderId, userId: FIXED_USER_ID });
    expect(again.idempotent).toBe(true);
    expect((await outboxTypes(created.orderId)).filter((t) => t === "order.shipped")).toHaveLength(1);

    // Some da rota depois que saiu.
    const route = await listRouteOfDay(sdb, { now: new Date("2026-09-18T14:00:00Z") });
    expect(route.todayCount).toBe(0);
  });

  it("em separação (já embalado) também sai; pedido Correios ou não pago é recusado", async () => {
    const { variantId, rateId } = await setup();
    const created = await paidMotoboyOrder(variantId, rateId, "2026-09-18");
    await transitionOrder(sdb, { orderId: created.orderId, to: "preparing", userId: FIXED_USER_ID });
    const result = await dispatchOrder(sdb, { orderId: created.orderId, userId: FIXED_USER_ID });
    expect(result).toMatchObject({ from: "preparing", to: "shipped" });

    const pac = await setup({ kind: "correios" });
    const pacOrder = await createStoreOrder(sdb, input(pac.variantId, pac.rateId, { expectedShippingCents: 1990 }));
    await transitionOrder(sdb, { orderId: pacOrder.orderId, to: "paid", userId: FIXED_USER_ID });
    await expect(dispatchOrder(sdb, { orderId: pacOrder.orderId, userId: FIXED_USER_ID })).rejects.toMatchObject({ code: "NOT_MOTOBOY" });

    const unpaid = await createStoreOrder(sdb, input(variantId, rateId, { deliveryWindow: { dayKey: "2026-09-18", ...WINDOWS[1] } }), { now: MORNING });
    await expect(dispatchOrder(sdb, { orderId: unpaid.orderId, userId: FIXED_USER_ID })).rejects.toBeInstanceOf(ServiceError);
    const [still] = await db.select({ status: schema.orders.status }).from(schema.orders).where(eq(schema.orders.id, unpaid.orderId));
    expect(still.status).toBe("pending_payment");
  });

  it("o contexto do WhatsApp do pedido de motoboy traz {{janela}} e {{dia}} para o aviso 'Saiu da maison'", async () => {
    const { variantId, rateId } = await setup();
    const created = await paidMotoboyOrder(variantId, rateId, "2026-09-18");
    const ctx = await loadOrderWaContext(sdb, created.orderId);
    expect(ctx?.hasDeliveryWindow).toBe(true);
    expect(ctx?.vars.janela).toBe("19h e 21h");
    expect(ctx?.vars.nome).toBe("Ana");
    expect(["hoje", "amanhã"].includes(ctx!.vars.dia) || /\d{2}\/\d{2}$/.test(ctx!.vars.dia)).toBe(true);

    const pac = await setup({ kind: "correios" });
    const pacOrder = await createStoreOrder(sdb, input(pac.variantId, pac.rateId, { expectedShippingCents: 1990 }));
    const pacCtx = await loadOrderWaContext(sdb, pacOrder.orderId);
    expect(pacCtx?.hasDeliveryWindow).toBe(false);
    expect(pacCtx?.vars.janela).toBe("");
  });
});

describe("rescheduleOrderWindow", () => {
  it("troca a janela por outra da faixa (hoje ou dia futuro), regrava o rótulo e deixa audit; dia passado e janela inexistente são recusados", async () => {
    const { variantId, rateId } = await setup();
    const created = await paidMotoboyOrder(variantId, rateId, "2026-09-18");
    expect(await listMotoboyWindows(sdb)).toEqual([{ rateName: "Motoboy Belém", windows: WINDOWS }]);

    const now = new Date("2026-09-19T12:00:00Z"); // sábado: o pedido está atrasado
    const choice = await rescheduleOrderWindow(sdb, { orderId: created.orderId, userId: FIXED_USER_ID, dayKey: "2026-09-19", window: WINDOWS[0], now });
    expect(choice).toEqual({ dayKey: "2026-09-19", ...WINDOWS[0] });

    const [order] = await db.select().from(schema.orders).where(eq(schema.orders.id, created.orderId));
    expect(order.deliveryWindow).toEqual({ dayKey: "2026-09-19", ...WINDOWS[0], rateName: "Motoboy Belém", label: "sábado 19/09, 16h–19h" });
    expect(order.status).toBe("paid");

    const audits = await db.select({ action: schema.auditLog.action }).from(schema.auditLog).where(eq(schema.auditLog.entityId, created.orderId));
    expect(audits.map((a) => a.action)).toContain("order.reschedule_window");

    const route = await listRouteOfDay(sdb, { now });
    expect(route.late).toEqual([]);
    expect(route.today[0].orders[0].orderNumber).toBe(created.orderNumber);

    await expect(
      rescheduleOrderWindow(sdb, { orderId: created.orderId, userId: FIXED_USER_ID, dayKey: "2026-09-18", window: WINDOWS[0], now }),
    ).rejects.toMatchObject({ code: "PAST_DAY" });
    await expect(
      rescheduleOrderWindow(sdb, { orderId: created.orderId, userId: FIXED_USER_ID, dayKey: "2026-09-20", window: { start: "08:00", end: "10:00", cutoff: "07:00" }, now }),
    ).rejects.toMatchObject({ code: "WINDOW_UNKNOWN" });

    await dispatchOrder(sdb, { orderId: created.orderId, userId: FIXED_USER_ID });
    await expect(
      rescheduleOrderWindow(sdb, { orderId: created.orderId, userId: FIXED_USER_ID, dayKey: "2026-09-20", window: WINDOWS[0], now }),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
  });
});
