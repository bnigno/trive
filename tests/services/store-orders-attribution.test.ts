import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { createStoreOrder, type CreateStoreOrderInput } from "@/services/store-orders";
import { siteOrdersByOrigin } from "@/services/site-carts";
import { transitionOrder } from "@/services/orders";
import { createTestDb, createTestVariant, type TestDb } from "../helpers/db";

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
  it("grava o link de story guardado no navegador, normalizado", async () => {
    const { variantId, rateId } = await setupStore();
    const at = new Date(Date.now() - 3600_000).toISOString();
    const result = await createStoreOrder(sdb, input(variantId, rateId, { origin: { kind: "campaign", ref: "Dunas", at } }));
    expect(await attributionOf(result.orderId)).toEqual({ kind: "campaign", ref: "dunas", touchedAt: at });
  });

  it("origem estragada ou vencida NÃO derruba o pedido — só fica sem origem", async () => {
    const { variantId, rateId } = await setupStore();
    const broken = await createStoreOrder(sdb, input(variantId, rateId, { origin: { kind: "campaign", ref: 42 } }));
    expect(await attributionOf(broken.orderId)).toBeNull();

    const old = new Date(Date.now() - 8 * 24 * 3600_000).toISOString();
    const expired = await createStoreOrder(
      sdb,
      input(variantId, rateId, { customer: { fullName: "Bia Lima", phone: "(91) 99999-0002", marketingOptIn: false }, origin: { kind: "coupon", ref: "AMIGA7K", at: old } }),
    );
    expect(await attributionOf(expired.orderId)).toBeNull();
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

    const rows = await siteOrdersByOrigin(sdb, { from: new Date(Date.now() - 3600_000), to: new Date(Date.now() + 60_000) });
    expect(rows).toEqual([
      { kind: "campaign", ref: "dunas", label: "/ig/dunas «Dunas no story»", orders: 2, paidOrders: 1, paidCents: 4990 + 1990 },
      { kind: null, ref: null, label: "sem origem conhecida", orders: 1, paidOrders: 0, paidCents: 0 },
    ]);
  });
});
