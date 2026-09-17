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
  completeDispatchedOrder,
  countRouteOfDay,
  dispatchOrder,
  listMotoboyWindows,
  listRouteOfDay,
  rescheduleOrderWindow,
} from "@/services/delivery-routes";
import { transitionOrder } from "@/services/orders";
import { listOrdersAwaitingPacking } from "@/services/packing";
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
        : { name: "Motoboy Belém", priceCents: 1500, kind: "motoboy", cepStart: "66000000", cepEnd: "66999999", deliveryWindows: WINDOWS, deliveryDaysMin: 0, deliveryDaysMax: 0 },
    )
    .returning({ id: schema.shippingRates.id });
  return { variantId, rateId: rate.id };
}

/** Fora da área do motoboy: onde o motoboy chega, o pedido pelos Correios é recusado (SHIPPING_MOTOBOY_ONLY). */
const SP_ADDRESS = { postalCode: "01310-100", street: "Av. Paulista", number: "1000", complement: "", district: "Bela Vista", city: "São Paulo", state: "SP" };

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
      // Já pago (baixa manual): o motoboy NÃO recebe de novo.
      collectCashCents: null,
      paidAfterCutoff: true,
      windowLabel: "sexta 18/09, 16h–19h",
    });
    expect(route.today[1].orders[0]).toMatchObject({ collectCashCents: null, paidAfterCutoff: false });

    // Às 19h30 a janela 16h–19h já terminou: atrasado no mesmo dia; a 19h–21h ainda não.
    const evening = await listRouteOfDay(sdb, { now: new Date("2026-09-18T22:30:00Z") });
    expect(evening.late.map((o) => o.orderNumber)).toEqual([cash.orderNumber]);
    expect(evening.today.map((g) => g.label)).toEqual(["19h–21h"]);
    expect(evening.todayCount).toBe(1);

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

  it("dinheiro na entrega: entra na rota ainda 'aguardando pagamento'; 'Saiu' marca a saída sem transição e avisa pela fila; some para 'na rua'; não repete", async () => {
    const { variantId, rateId } = await setup();
    const cash = await createStoreOrder(
      sdb,
      input(variantId, rateId, { deliveryWindow: { dayKey: "2026-09-18", ...WINDOWS[1] }, paymentMethod: "cash" }),
      { now: MORNING },
    );
    const before = await listRouteOfDay(sdb, { now: new Date("2026-09-18T14:00:00Z") });
    expect(before.today[0].orders.map((o) => [o.orderNumber, o.status, o.collectCashCents, o.dispatchedAt])).toEqual([
      [cash.orderNumber, "pending_payment", 15900 + 1500, null],
    ]);

    const dispatchedAt = new Date("2026-09-18T20:30:00Z");
    const result = await dispatchOrder(sdb, { orderId: cash.orderId, userId: FIXED_USER_ID, now: dispatchedAt });
    expect(result).toMatchObject({ from: "pending_payment", to: "pending_payment", idempotent: false });

    const [order] = await db.select().from(schema.orders).where(eq(schema.orders.id, cash.orderId));
    expect(order.status).toBe("pending_payment");
    expect(order.deliveryWindow?.dispatchedAt).toBe(dispatchedAt.toISOString());
    expect(order.deliveryWindow?.label).toBe("sexta 18/09, 19h–21h");
    const types = await outboxTypes(cash.orderId);
    expect(types.filter((t) => t === "order.out_for_delivery")).toHaveLength(1);
    expect(types).not.toContain("order.shipped");

    const after = await listRouteOfDay(sdb, { now: new Date("2026-09-18T21:00:00Z") });
    expect(after.today).toEqual([]);
    expect(after.out.map((o) => [o.orderNumber, o.dispatchedAt?.toISOString()])).toEqual([[cash.orderNumber, dispatchedAt.toISOString()]]);
    expect(after.todayCount).toBe(0);

    // Segundo clique: nada de novo (nem aviso).
    expect((await dispatchOrder(sdb, { orderId: cash.orderId, userId: FIXED_USER_ID })).idempotent).toBe(true);
    // O motoboy voltou com o dinheiro: pago → ainda 'na rua' até marcar entregue; "Saiu" continua idempotente (sem order.shipped duplicando o aviso).
    await transitionOrder(sdb, { orderId: cash.orderId, to: "paid", userId: FIXED_USER_ID });
    expect((await dispatchOrder(sdb, { orderId: cash.orderId, userId: FIXED_USER_ID })).idempotent).toBe(true);
    expect((await outboxTypes(cash.orderId)).filter((t) => t === "order.out_for_delivery" || t === "order.shipped")).toEqual(["order.out_for_delivery"]);
    expect((await listRouteOfDay(sdb, { now: new Date("2026-09-18T21:00:00Z") })).out.map((o) => o.status)).toEqual(["paid"]);
    await transitionOrder(sdb, { orderId: cash.orderId, to: "delivered", userId: FIXED_USER_ID });
    expect((await listRouteOfDay(sdb, { now: new Date("2026-09-18T21:00:00Z") })).out).toEqual([]);
    // Já saiu: não reagenda.
    await expect(
      rescheduleOrderWindow(sdb, { orderId: cash.orderId, userId: FIXED_USER_ID, dayKey: "2026-09-19", window: WINDOWS[0], now: new Date("2026-09-18T21:00:00Z") }),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
  });

  it("janela que já passou não sai: reagende primeiro (WINDOW_PAST); depois de reagendar, sai e {{dia}} segue a hora da saída", async () => {
    const { variantId, rateId } = await setup();
    const created = await paidMotoboyOrder(variantId, rateId, "2026-09-18");
    const saturday = new Date("2026-09-19T12:00:00Z");
    await expect(dispatchOrder(sdb, { orderId: created.orderId, userId: FIXED_USER_ID, now: saturday })).rejects.toMatchObject({ code: "WINDOW_PAST" });
    expect(await outboxTypes(created.orderId)).not.toContain("order.shipped");

    await rescheduleOrderWindow(sdb, { orderId: created.orderId, userId: FIXED_USER_ID, dayKey: "2026-09-19", window: WINDOWS[1], now: saturday });
    const result = await dispatchOrder(sdb, { orderId: created.orderId, userId: FIXED_USER_ID, now: new Date("2026-09-19T20:00:00Z") });
    expect(result.to).toBe("shipped");
    // O contexto do WhatsApp usa a hora da saída, mesmo se a fila rodar no dia seguinte.
    const ctx = await loadOrderWaContext(sdb, created.orderId);
    expect(ctx?.vars.dia).toBe("hoje");
    expect(ctx?.vars.janela).toBe("19h e 21h");
  });

  it("completeDispatchedOrder: o motoboy voltou — paid → delivered, preparing → shipped → delivered; sem sair antes ou sem pagar, recusa", async () => {
    const { variantId, rateId } = await setup();
    // Dinheiro na entrega: saiu → pago → entregue.
    const cash = await createStoreOrder(
      sdb,
      input(variantId, rateId, { deliveryWindow: { dayKey: "2026-09-18", ...WINDOWS[1] }, paymentMethod: "cash" }),
      { now: MORNING },
    );
    await expect(completeDispatchedOrder(sdb, { orderId: cash.orderId, userId: FIXED_USER_ID })).rejects.toMatchObject({ code: "NOT_DISPATCHED" });
    await dispatchOrder(sdb, { orderId: cash.orderId, userId: FIXED_USER_ID, now: MORNING });
    await expect(completeDispatchedOrder(sdb, { orderId: cash.orderId, userId: FIXED_USER_ID })).rejects.toMatchObject({ code: "PAYMENT_PENDING" });
    await transitionOrder(sdb, { orderId: cash.orderId, to: "paid", userId: FIXED_USER_ID });
    expect(await completeDispatchedOrder(sdb, { orderId: cash.orderId, userId: FIXED_USER_ID })).toMatchObject({ from: "paid", idempotent: false });
    expect((await db.select({ s: schema.orders.status }).from(schema.orders).where(eq(schema.orders.id, cash.orderId)))[0].s).toBe("delivered");
    expect((await completeDispatchedOrder(sdb, { orderId: cash.orderId, userId: FIXED_USER_ID })).idempotent).toBe(true);
    expect((await outboxTypes(cash.orderId)).filter((t) => t === "order.shipped")).toEqual([]);

    // Saiu, pagou, e a dona passou pelo "Embalei" (preparing) — ainda tem saída.
    const cash2 = await createStoreOrder(
      sdb,
      input(variantId, rateId, { deliveryWindow: { dayKey: "2026-09-18", ...WINDOWS[1] }, paymentMethod: "cash" }),
      { now: MORNING },
    );
    await dispatchOrder(sdb, { orderId: cash2.orderId, userId: FIXED_USER_ID, now: MORNING });
    await transitionOrder(sdb, { orderId: cash2.orderId, to: "paid", userId: FIXED_USER_ID });
    await transitionOrder(sdb, { orderId: cash2.orderId, to: "preparing", userId: FIXED_USER_ID });
    expect(await completeDispatchedOrder(sdb, { orderId: cash2.orderId, userId: FIXED_USER_ID })).toMatchObject({ from: "preparing" });
    expect((await db.select({ s: schema.orders.status }).from(schema.orders).where(eq(schema.orders.id, cash2.orderId)))[0].s).toBe("delivered");
  });

  it("pedido que já saiu com o motoboy não aparece na mesa de embalagem", async () => {
    const { variantId, rateId } = await setup();
    const created = await paidMotoboyOrder(variantId, rateId, "2026-09-18");
    expect((await listOrdersAwaitingPacking(sdb)).map((o) => o.orderNumber)).toEqual([created.orderNumber]);
    const cash = await createStoreOrder(
      sdb,
      input(variantId, rateId, { deliveryWindow: { dayKey: "2026-09-18", ...WINDOWS[1] }, paymentMethod: "cash" }),
      { now: MORNING },
    );
    await dispatchOrder(sdb, { orderId: cash.orderId, userId: FIXED_USER_ID, now: MORNING });
    await transitionOrder(sdb, { orderId: cash.orderId, to: "paid", userId: FIXED_USER_ID });
    expect((await listOrdersAwaitingPacking(sdb)).map((o) => o.orderNumber)).toEqual([created.orderNumber]);
  });

  it("em separação (já embalado) também sai; pedido Correios ou online não pago é recusado", async () => {
    const { variantId, rateId } = await setup();
    const created = await paidMotoboyOrder(variantId, rateId, "2026-09-18");
    await transitionOrder(sdb, { orderId: created.orderId, to: "preparing", userId: FIXED_USER_ID });
    const result = await dispatchOrder(sdb, { orderId: created.orderId, userId: FIXED_USER_ID });
    expect(result).toMatchObject({ from: "preparing", to: "shipped" });

    const pac = await setup({ kind: "correios" });
    const pacOrder = await createStoreOrder(sdb, input(pac.variantId, pac.rateId, { expectedShippingCents: 1990, address: SP_ADDRESS }));
    await transitionOrder(sdb, { orderId: pacOrder.orderId, to: "paid", userId: FIXED_USER_ID });
    await expect(dispatchOrder(sdb, { orderId: pacOrder.orderId, userId: FIXED_USER_ID })).rejects.toMatchObject({ code: "NOT_MOTOBOY" });

    const unpaid = await createStoreOrder(sdb, input(variantId, rateId, { deliveryWindow: { dayKey: "2026-09-18", ...WINDOWS[1] } }), { now: MORNING });
    await expect(dispatchOrder(sdb, { orderId: unpaid.orderId, userId: FIXED_USER_ID })).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    expect(await outboxTypes(unpaid.orderId)).not.toContain("order.out_for_delivery");
    const [still] = await db.select({ status: schema.orders.status }).from(schema.orders).where(eq(schema.orders.id, unpaid.orderId));
    expect(still.status).toBe("pending_payment");
  });

  it("o contexto do WhatsApp do pedido de motoboy traz {{janela}} e {{dia}} para o aviso 'Saiu da TRIVÉ'", async () => {
    const { variantId, rateId } = await setup();
    const created = await paidMotoboyOrder(variantId, rateId, "2026-09-18");
    const ctx = await loadOrderWaContext(sdb, created.orderId);
    expect(ctx?.hasDeliveryWindow).toBe(true);
    expect(ctx?.vars.janela).toBe("19h e 21h");
    expect(ctx?.vars.nome).toBe("Ana");
    expect(ctx?.vars.loja).toBe("TRIVÉ");
    expect(["hoje", "amanhã"].includes(ctx!.vars.dia) || /\d{2}\/\d{2}$/.test(ctx!.vars.dia)).toBe(true);

    const pac = await setup({ kind: "correios" });
    const pacOrder = await createStoreOrder(sdb, input(pac.variantId, pac.rateId, { expectedShippingCents: 1990, address: SP_ADDRESS }));
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
      rescheduleOrderWindow(sdb, { orderId: created.orderId, userId: FIXED_USER_ID, dayKey: "2026-02-31", window: WINDOWS[0], now }),
    ).rejects.toThrow(/Dia inválido/);
    await expect(
      rescheduleOrderWindow(sdb, { orderId: created.orderId, userId: FIXED_USER_ID, dayKey: "2026-09-20", window: { start: "08:00", end: "10:00", cutoff: "07:00" }, now }),
    ).rejects.toMatchObject({ code: "WINDOW_UNKNOWN" });

    await dispatchOrder(sdb, { orderId: created.orderId, userId: FIXED_USER_ID });
    await expect(
      rescheduleOrderWindow(sdb, { orderId: created.orderId, userId: FIXED_USER_ID, dayKey: "2026-09-20", window: WINDOWS[0], now }),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
  });
});
