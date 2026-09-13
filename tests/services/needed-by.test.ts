// Data marcada com banco real (PGlite): gravação no pedido (needed_by,
// occasion, ship_by por Correios em dias úteis e por motoboy), o alias do
// presente, a lista com semáforo, o contador do Bom dia e o selo da cidade.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { buildDailyDigestData } from "@/services/daily-digest";
import { dispatchOrder } from "@/services/delivery-routes";
import { countOrdersMustShipToday, getCitySeal, getDeliveryHorizonDays, listOrdersWithNeededBy } from "@/services/needed-by";
import { transitionOrder } from "@/services/orders";
import { updateSetting } from "@/services/settings";
import { createStoreOrder, getPublicOrder, type CreateStoreOrderInput } from "@/services/store-orders";
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

const NOW = new Date("2026-10-05T13:00:00Z"); // segunda 5/10, 10h SP

async function setup() {
  const { variantId } = await createTestVariant(db, { sku: "DUNAS-M", costCents: 1200, onHand: 10, name: "Longo Dunas" });
  await db.insert(schema.priceVersions).values({
    productVariantId: variantId,
    versionNumber: 1,
    status: "active",
    priceCents: 15900,
    origin: "initial",
    breakdown: {},
    costSnapshotCents: 1000,
    computedMarginRate: "0.3000",
    activatedAt: new Date(),
  });
  const [pac] = await db.insert(schema.shippingRates).values({ name: "PAC", priceCents: 1990, deliveryDaysMin: 3, deliveryDaysMax: 5 }).returning({ id: schema.shippingRates.id });
  const [moto] = await db
    .insert(schema.shippingRates)
    .values({ name: "Motoboy", priceCents: 1500, kind: "motoboy", deliveryWindows: [{ start: "19:00", end: "21:00", cutoff: "17:00" }], deliveryDaysMin: 0, deliveryDaysMax: 0 })
    .returning({ id: schema.shippingRates.id });
  return { variantId, pacId: pac.id, motoId: moto.id };
}

function input(variantId: string, rateId: string, over: Partial<CreateStoreOrderInput> = {}): CreateStoreOrderInput {
  return {
    customer: { fullName: "Ana Souza", document: "529.982.247-25", phone: "(91) 98888-1234", email: "ana@example.com", marketingOptIn: true },
    address: { postalCode: "66050-000", street: "Av. Nazaré", number: "100", district: "Nazaré", city: "Belém", state: "PA" },
    items: [{ variantId, quantity: 1, expectedUnitPriceCents: 15900 }],
    shippingRateId: rateId,
    expectedShippingCents: 1990,
    ...over,
  };
}

describe("createStoreOrder com data marcada", () => {
  it("grava needed_by, ocasião e ship_by (Correios: 5 dias úteis antes, pulando fds e 12/10); a página pública mostra a linha", async () => {
    const { variantId, pacId } = await setup();
    const created = await createStoreOrder(sdb, input(variantId, pacId, { neededBy: "2026-10-16", occasion: "  aniversário da mãe " }), { now: NOW });
    const [order] = await db.select().from(schema.orders).where(eq(schema.orders.id, created.orderId));
    expect(order.neededBy).toBe("2026-10-16");
    expect(order.occasion).toBe("aniversário da mãe");
    expect(order.shipBy).toBe("2026-10-08");
    expect((await getPublicOrder(sdb, created.publicToken))?.neededByLabel).toBe("Para o dia 16/10 — aniversário da mãe");
  });

  it("motoboy: ship_by é o dia da janela; presente com data desejada vira data marcada; data no passado ou inexistente é recusada", async () => {
    const { variantId, pacId, motoId } = await setup();
    const moto = await createStoreOrder(
      sdb,
      input(variantId, motoId, { expectedShippingCents: 1500, deliveryWindow: { dayKey: "2026-10-05", start: "19:00", end: "21:00", cutoff: "17:00" }, neededBy: "2026-10-07" }),
      { now: NOW },
    );
    expect((await db.select().from(schema.orders).where(eq(schema.orders.id, moto.orderId)))[0].shipBy).toBe("2026-10-05");

    const gift = await createStoreOrder(sdb, input(variantId, pacId, { gift: { recipientName: "Mãe", deliverBy: "2026-10-20" } }), { now: NOW });
    const [giftRow] = await db.select().from(schema.orders).where(eq(schema.orders.id, gift.orderId));
    expect(giftRow.neededBy).toBe("2026-10-20");
    expect(giftRow.giftDeliverBy).toBe("2026-10-20");
    expect(giftRow.shipBy).toBe("2026-10-13");

    // A data do presente vinda da Lia (sem saber o dia de hoje) no passado não trava a venda: fica só informativa.
    const stale = await createStoreOrder(sdb, input(variantId, pacId, { gift: { recipientName: "Mãe", deliverBy: "2026-09-10" } }), { now: NOW });
    const [staleRow] = await db.select().from(schema.orders).where(eq(schema.orders.id, stale.orderId));
    expect(staleRow.giftDeliverBy).toBe("2026-09-10");
    expect(staleRow.neededBy).toBeNull();
    expect(staleRow.shipBy).toBeNull();
    // Motoboy com a janela depois da data marcada: o limite vira a própria data (vermelho no painel).
    const lateMoto = await createStoreOrder(
      sdb,
      input(variantId, motoId, { expectedShippingCents: 1500, deliveryWindow: { dayKey: "2026-10-06", start: "19:00", end: "21:00", cutoff: "17:00" }, neededBy: "2026-10-05" }),
      { now: new Date("2026-10-05T21:00:00Z") },
    );
    expect((await db.select().from(schema.orders).where(eq(schema.orders.id, lateMoto.orderId)))[0].shipBy).toBe("2026-10-05");

    await expect(createStoreOrder(sdb, input(variantId, pacId, { neededBy: "2026-10-04" }), { now: NOW })).rejects.toMatchObject({ code: "NEEDED_BY_INVALID" });
    await expect(createStoreOrder(sdb, input(variantId, pacId, { neededBy: "2026-02-31" }), { now: NOW })).rejects.toMatchObject({ code: "NEEDED_BY_INVALID" });
    await expect(createStoreOrder(sdb, input(variantId, pacId, { neededBy: "2026-10-16", occasion: "x".repeat(61) }), { now: NOW })).rejects.toThrow(/60 caracteres/);
  });
});

describe("listOrdersWithNeededBy / countOrdersMustShipToday", () => {
  it("só pedidos por sair (pago, em separação, dinheiro na entrega), do mais urgente ao mais folgado, com semáforo; quem já saiu não conta", async () => {
    const { variantId, pacId, motoId } = await setup();
    const green = await createStoreOrder(sdb, input(variantId, pacId, { neededBy: "2026-10-20" }), { now: NOW }); // sai até 13/10
    const red = await createStoreOrder(sdb, input(variantId, pacId, { neededBy: "2026-10-09" }), { now: NOW }); // sai até 2/10 (já atrasou)
    const amber = await createStoreOrder(sdb, input(variantId, pacId, { neededBy: "2026-10-14" }), { now: NOW }); // sai até 6/10 (12/10 é feriado)
    const unpaid = await createStoreOrder(sdb, input(variantId, pacId, { neededBy: "2026-10-30" }), { now: NOW });
    for (const o of [green, red, amber]) await transitionOrder(sdb, { orderId: o.orderId, to: "paid", userId: FIXED_USER_ID });
    const cash = await createStoreOrder(
      sdb,
      input(variantId, motoId, { expectedShippingCents: 1500, deliveryWindow: { dayKey: "2026-10-05", start: "19:00", end: "21:00", cutoff: "17:00" }, neededBy: "2026-10-05", paymentMethod: "cash" }),
      { now: NOW },
    );

    const rows = await listOrdersWithNeededBy(sdb, { now: NOW });
    expect(rows.map((r) => [r.orderNumber, r.light, r.shipByLabel])).toEqual([
      [red.orderNumber, "red", "Atrasou 3 dias"],
      [cash.orderNumber, "red", "Sai hoje"],
      [amber.orderNumber, "amber", "Sai amanhã"],
      [green.orderNumber, "green", "Sai até terça 13/10"],
    ]);
    expect(rows.map((r) => r.orderNumber)).not.toContain(unpaid.orderNumber);
    expect(rows[1]).toMatchObject({ isMotoboy: true, status: "pending_payment", dispatched: false });
    expect(await countOrdersMustShipToday(sdb, { now: NOW })).toBe(2);

    // Pedido antigo (antes do PR) com data mas sem ship_by: a lista e o contador usam a data marcada.
    await db.update(schema.orders).set({ shipBy: null }).where(eq(schema.orders.id, red.orderId));
    expect((await listOrdersWithNeededBy(sdb, { now: NOW })).find((r) => r.orderNumber === red.orderNumber)?.shipBy).toBe("2026-10-09");
    expect(await countOrdersMustShipToday(sdb, { now: new Date("2026-10-09T12:00:00Z") })).toBe(3);
    await db.update(schema.orders).set({ shipBy: "2026-10-02" }).where(eq(schema.orders.id, red.orderId));

    // Saiu com o motoboy: não conta mais como "precisa sair hoje".
    await dispatchOrder(sdb, { orderId: cash.orderId, userId: FIXED_USER_ID, now: NOW });
    expect(await countOrdersMustShipToday(sdb, { now: NOW })).toBe(1);
    expect((await listOrdersWithNeededBy(sdb, { now: NOW })).find((r) => r.orderNumber === cash.orderNumber)?.dispatched).toBe(true);
  });

  it("o Bom dia conta os que precisam sair no dia em que chega", async () => {
    const { variantId, pacId } = await setup();
    const red = await createStoreOrder(sdb, input(variantId, pacId, { neededBy: "2026-10-09" }), { now: NOW });
    await transitionOrder(sdb, { orderId: red.orderId, to: "paid", userId: FIXED_USER_ID });
    const data = await buildDailyDigestData(sdb, { date: "2026-10-04" });
    expect(data.waiting.mustShipToday).toBe(1);
  });
});

describe("Datas da cidade e o selo", () => {
  it("horizonte = maior prazo dos Correios ativos; selo com o dia-limite; sem datas → null", async () => {
    // Sem faixa de Correios: horizonte null e o selo só conta os dias.
    await updateSetting(sdb, { key: "city_dates", value: [{ name: "Círio", date: "2026-10-11" }], userId: FIXED_USER_ID });
    expect(await getDeliveryHorizonDays(sdb)).toBeNull();
    expect((await getCitySeal(sdb, { now: NOW }))?.text).toBe("Círio em 6 dias");
    await updateSetting(sdb, { key: "city_dates", value: [], userId: FIXED_USER_ID });
    await setup();
    expect(await getDeliveryHorizonDays(sdb)).toBe(5);
    expect(await getCitySeal(sdb, { now: NOW })).toBeNull();
    await updateSetting(sdb, { key: "city_dates", value: [{ name: "Círio", date: "2026-10-11" }, { name: "Natal", date: "2026-12-25" }], userId: FIXED_USER_ID });
    // 5 dias úteis antes de dom 11/10: sex 9, qui 8, qua 7, ter 6, seg 5 → 5/10 (hoje ainda dá)
    expect(await getCitySeal(sdb, { now: NOW })).toMatchObject({ name: "Círio", daysUntil: 6, orderBy: "2026-10-05", text: "Círio em 6 dias · peça até 05/10 para chegar pelos Correios" });
    await expect(updateSetting(sdb, { key: "city_dates", value: [{ name: "", date: "2026-10-11" }], userId: FIXED_USER_ID })).rejects.toThrow();
  });
});
