import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { createStoreOrder, type CreateStoreOrderInput } from "@/services/store-orders";
import { siteOrdersByOrigin } from "@/services/site-carts";
import { transitionOrder } from "@/services/orders";
import { createCoupon } from "@/services/coupons";
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

async function setupStore() {
  const { variantId } = await createTestVariant(db, { sku: "DUNAS-M", costCents: 1200, onHand: 10, name: "Longo Dunas" });
  await db.insert(schema.priceVersions).values({
    productVariantId: variantId,
    versionNumber: 1,
    status: "active",
    priceCents: 4990,
    origin: "initial",
    breakdown: {},
    costSnapshotCents: 1000,
    computedMarginRate: "0.3000",
    activatedAt: new Date(),
  });
  const [rate] = await db.insert(schema.shippingRates).values({ name: "PAC", priceCents: 1990 }).returning({ id: schema.shippingRates.id });
  return { variantId, rateId: rate.id };
}

function input(variantId: string, rateId: string, over: Partial<CreateStoreOrderInput> = {}): CreateStoreOrderInput {
  return {
    customer: { fullName: "Ana Souza", phone: "(91) 99999-0001", marketingOptIn: false },
    address: {
      postalCode: "66055-000",
      street: "Rua dos Mundurucus",
      number: "10",
      district: "Umarizal",
      city: "Belém",
      state: "PA",
    },
    items: [{ variantId, quantity: 1, expectedUnitPriceCents: 4990 }],
    shippingRateId: rateId,
    expectedShippingCents: 1990,
    ...over,
  };
}

async function attributionOf(orderId: string) {
  const [row] = await db.select({ attribution: schema.orders.attribution }).from(schema.orders).where(eq(schema.orders.id, orderId));
  return row.attribution;
}

describe("createStoreOrder — origem do pedido do site", () => {
  it("grava o link de story guardado no navegador, normalizado, com só o dia do toque", async () => {
    const { variantId, rateId } = await setupStore();
    await db.insert(schema.campaignLinks).values({ slug: "dunas", label: "Dunas no story" });
    const now = new Date("2026-10-05T15:00:00.000Z");
    const at = new Date(now.getTime() - 3600_000).toISOString();
    const result = await createStoreOrder(sdb, input(variantId, rateId, { origin: { kind: "campaign", ref: "Dunas", at } }), { now });
    expect(await attributionOf(result.orderId)).toEqual({ kind: "campaign", ref: "dunas", touchedOn: "2026-10-05" });
  });

  it("link ou cupom que não existe não vira origem (o navegador é da cliente)", async () => {
    const { variantId, rateId } = await setupStore();
    const at = new Date(Date.now() - 60_000).toISOString();
    const invented = await createStoreOrder(sdb, input(variantId, rateId, { origin: { kind: "campaign", ref: "inventado", at } }));
    expect(await attributionOf(invented.orderId)).toBeNull();
    const coupon = await createStoreOrder(
      sdb,
      input(variantId, rateId, { customer: { fullName: "Bia Lima", phone: "(91) 99999-0002", marketingOptIn: false }, origin: { kind: "coupon", ref: "NAOEXISTE", at } }),
    );
    expect(await attributionOf(coupon.orderId)).toBeNull();
  });

  it("origem estragada ou vencida NÃO derruba o pedido — só fica sem origem", async () => {
    const { variantId, rateId } = await setupStore();
    await createCoupon(sdb, { code: "AMIGA7K", type: "percent", value: 10, userId: FIXED_USER_ID });
    const broken = await createStoreOrder(sdb, input(variantId, rateId, { origin: { kind: "campaign", ref: 42 } }));
    expect(await attributionOf(broken.orderId)).toBeNull();

    // O cupom existe: o que derruba a origem aqui é só o prazo.
    const old = new Date(Date.now() - 8 * 24 * 3600_000).toISOString();
    const expired = await createStoreOrder(
      sdb,
      input(variantId, rateId, { customer: { fullName: "Bia Lima", phone: "(91) 99999-0002", marketingOptIn: false }, origin: { kind: "coupon", ref: "AMIGA7K", at: old } }),
    );
    expect(await attributionOf(expired.orderId)).toBeNull();
  });

  it("link de cupom que existe vira origem, com o código em maiúsculas", async () => {
    const { variantId, rateId } = await setupStore();
    await createCoupon(sdb, { code: "AMIGA7K", type: "percent", value: 10, userId: FIXED_USER_ID });
    const now = new Date("2026-10-05T15:00:00.000Z");
    const result = await createStoreOrder(
      sdb,
      input(variantId, rateId, { origin: { kind: "coupon", ref: "amiga7k", at: new Date(now.getTime() - 60_000).toISOString() } }),
      { now },
    );
    expect(await attributionOf(result.orderId)).toEqual({ kind: "coupon", ref: "AMIGA7K", touchedOn: "2026-10-05" });
  });

  it("sem origem = null (pedido antigo, navegador sem storage)", async () => {
    const { variantId, rateId } = await setupStore();
    const result = await createStoreOrder(sdb, input(variantId, rateId));
    expect(await attributionOf(result.orderId)).toBeNull();
  });
});

describe("siteOrdersByOrigin", () => {
  it("agrupa os pedidos do site por origem, com o rótulo do link e só o pago como venda", async () => {
    const { variantId, rateId } = await setupStore();
    await db.insert(schema.campaignLinks).values({ slug: "dunas", label: "Dunas no story" });
    const at = new Date(Date.now() - 60_000).toISOString();

    const paid = await createStoreOrder(sdb, input(variantId, rateId, { origin: { kind: "campaign", ref: "dunas", at } }));
    await transitionOrder(sdb, { orderId: paid.orderId, to: "paid", userId: null });
    await createStoreOrder(
      sdb,
      input(variantId, rateId, { customer: { fullName: "Bia Lima", phone: "(91) 99999-0002", marketingOptIn: false }, origin: { kind: "campaign", ref: "dunas", at } }),
    );
    await createStoreOrder(
      sdb,
      input(variantId, rateId, { customer: { fullName: "Cris Melo", phone: "(91) 99999-0003", marketingOptIn: false } }),
    );
    await createCoupon(sdb, { code: "AMIGA7K", type: "percent", value: 10, userId: FIXED_USER_ID });
    await createStoreOrder(
      sdb,
      input(variantId, rateId, { customer: { fullName: "Dani Reis", phone: "(91) 99999-0004", marketingOptIn: false }, origin: { kind: "coupon", ref: "AMIGA7K", at } }),
    );

    const rows = await siteOrdersByOrigin(sdb, { from: new Date(Date.now() - 3600_000), to: new Date(Date.now() + 60_000) });
    expect(rows).toEqual([
      { kind: "campaign", ref: "dunas", label: "story «Dunas no story»", path: "/ig/dunas", orders: 2, paidOrders: 1, paidCents: 4990 + 1990 },
      { kind: "coupon", ref: "AMIGA7K", label: "link de cupom", path: "/c/AMIGA7K", orders: 1, paidOrders: 0, paidCents: 0 },
      { kind: null, ref: null, label: "sem origem conhecida", path: null, orders: 1, paidOrders: 0, paidCents: 0 },
    ]);
  });
});
