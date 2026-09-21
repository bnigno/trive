// Proteção de preço: a queda do preço ativo gera a diferença em cupom para
// quem pagou mais na janela — um por pedido e peça, idempotente, com o aviso.
import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeMessagingProvider } from "@/adapters/zapi/fake";
import * as schema from "@/db/schema";
import { initialWaTemplates } from "@/db/seed-data";
import type { DbOrTx } from "@/queue/enqueue";
import { sendCouponIssuedWa } from "@/services/coupon-notices";
import { protectPricesAfterDrop } from "@/services/price-protection";
import { createTestCustomer, createTestDb, createTestVariant, type TestDb } from "../helpers/db";

let db: TestDb;
let close: () => Promise<void>;
let sdb: DbOrTx;

const NOW = new Date("2026-09-21T18:00:00.000Z");

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  sdb = db as unknown as DbOrTx;
  await db.insert(schema.settings).values([
    { key: "price_protection_enabled", value: true },
    { key: "price_protection_days", value: 14 },
    { key: "wa_enabled", value: true },
  ]);
  const template = initialWaTemplates.find((row) => row.key === "price_protection_coupon");
  if (!template) throw new Error("template price_protection_coupon ausente no seed");
  await db.insert(schema.waTemplates).values({ key: template.key, label: template.label, bodyTemplate: template.bodyTemplate, variables: template.variables });
});

afterEach(async () => {
  await close();
});

async function activePrice(variantId: string, priceCents: number, previousPriceCents: number | null, version = 1): Promise<string> {
  if (version > 1) {
    await db.update(schema.priceVersions).set({ status: "superseded", supersededAt: NOW }).where(eq(schema.priceVersions.productVariantId, variantId));
  }
  const [row] = await db
    .insert(schema.priceVersions)
    .values({ productVariantId: variantId, versionNumber: version, status: "active", priceCents, previousPriceCents, origin: "manual", breakdown: {}, costSnapshotCents: 1000, computedMarginRate: "0.3000", activatedAt: NOW })
    .returning({ id: schema.priceVersions.id });
  return row.id;
}

async function paidOrder(input: { variantId: string; unitPriceCents: number; quantity?: number; paidAt?: Date; status?: string; name?: string; optIn?: boolean }) {
  const customerId = await createTestCustomer(db, input.name ?? "Maria Aparecida");
  await db.update(schema.customers).set({ marketingOptIn: input.optIn ?? true }).where(eq(schema.customers.id, customerId));
  const total = input.unitPriceCents * (input.quantity ?? 1);
  const [order] = await db
    .insert(schema.orders)
    .values({ customerId, status: input.status ?? "paid", paidAt: input.paidAt ?? new Date(NOW.getTime() - 3 * 86_400_000), subtotalCents: total, discountCents: 0, shippingCents: 0, totalCents: total })
    .returning({ id: schema.orders.id, orderNumber: schema.orders.orderNumber });
  await db.insert(schema.orderItems).values({ orderId: order.id, productVariantId: input.variantId, skuSnapshot: "LD-M", nameSnapshot: "Longo Dunas", quantity: input.quantity ?? 1, unitPriceCents: input.unitPriceCents, unitCostCents: 1000, totalCents: total });
  return { customerId, orderId: order.id, orderNumber: order.orderNumber };
}

async function outbox(eventType: string) {
  return (await db.select().from(schema.outboxEvents).orderBy(asc(schema.outboxEvents.createdAt))).filter((e) => e.eventType === eventType);
}

describe("protectPricesAfterDrop", () => {
  it("queda de 199 → 179 com 2 unidades pagas há 3 dias: cupom fixo de R$ 40, aviso, audit; reprocessar não duplica", async () => {
    const { variantId } = await createTestVariant(db, { sku: "LD-M", name: "Longo Dunas" });
    const { customerId, orderId, orderNumber } = await paidOrder({ variantId, unitPriceCents: 19900, quantity: 2 });
    const versionId = await activePrice(variantId, 17900, 19900, 2);

    expect(await protectPricesAfterDrop(sdb, { versionId, variantId, priceCents: 17900, now: NOW })).toEqual({ issued: 1, already: 0 });
    const [coupon] = await db.select().from(schema.coupons);
    expect(coupon).toMatchObject({
      origin: "price_protection",
      type: "fixed",
      value: 4000,
      customerId,
      orderId,
      maxUses: 1,
      perCustomerLimit: 1,
      dedupeKey: `price_protection:${orderId}:${variantId}`,
      note: `Longo Dunas baixou de R$ 199,00 para R$ 179,00 (pedido #${orderNumber})`,
    });
    expect(coupon.code).toMatch(/^MARIA-/);
    expect(coupon.expiresAt).toEqual(new Date("2026-10-22T02:59:59.000Z")); // 21/10 23:59:59 SP
    const issued = await outbox("coupon.issued");
    expect(issued).toHaveLength(1);
    expect(issued[0].payload).toEqual({ couponId: coupon.id, vars: { peca: "Longo Dunas" } });
    expect(await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "coupon.price_protection"))).toHaveLength(1);

    expect(await protectPricesAfterDrop(sdb, { versionId, variantId, priceCents: 17900, now: NOW })).toEqual({ issued: 0, already: 1 });
    expect(await db.select().from(schema.coupons)).toHaveLength(1);
    expect(await outbox("coupon.issued")).toHaveLength(1);

    // O aviso, pelo template da origem.
    const provider = new FakeMessagingProvider();
    expect(await sendCouponIssuedWa(sdb, provider, { couponId: coupon.id, vars: { peca: "Longo Dunas" }, now: new Date("2026-09-22T13:00:00.000Z") })).toMatchObject({ sent: true });
    const body = provider.sentMessages[0].body;
    expect(body).toContain(`Maria, Longo Dunas que você levou no pedido #${orderNumber} baixou de preço`);
    expect(body).toContain(`A diferença (R$ 40,00) virou o cupom ${coupon.code}, válido até 21/10`);
  });

  it("fora da janela, reembolsado, preço que sobe, versão inicial e desligado: nada", async () => {
    const { variantId } = await createTestVariant(db, { sku: "LD-M2", name: "Longo Dunas" });
    await paidOrder({ variantId, unitPriceCents: 19900, paidAt: new Date(NOW.getTime() - 20 * 86_400_000), name: "Antiga" });
    await paidOrder({ variantId, unitPriceCents: 19900, status: "refunded", name: "Reembolsada" });
    await paidOrder({ variantId, unitPriceCents: 17000, name: "Pagou menos" });
    const drop = await activePrice(variantId, 17900, 19900, 2);
    expect(await protectPricesAfterDrop(sdb, { versionId: drop, variantId, priceCents: 17900, now: NOW })).toEqual({ issued: 0, already: 0 });

    const rise = await activePrice(variantId, 21900, 17900, 3);
    expect(await protectPricesAfterDrop(sdb, { versionId: rise, variantId, priceCents: 21900, now: NOW })).toEqual({ skipped: "sem_queda" });
    const initial = await activePrice(variantId, 15000, null, 4);
    expect(await protectPricesAfterDrop(sdb, { versionId: initial, variantId, priceCents: 15000, now: NOW })).toEqual({ skipped: "sem_queda" });
    expect(await protectPricesAfterDrop(sdb, { versionId: "00000000-0000-4000-8000-00000000dead", variantId, priceCents: 15000, now: NOW })).toEqual({ skipped: "versao_inexistente" });

    await db.update(schema.settings).set({ value: false }).where(eq(schema.settings.key, "price_protection_enabled"));
    expect(await protectPricesAfterDrop(sdb, { versionId: drop, variantId, priceCents: 17900, now: NOW })).toEqual({ skipped: "desligado" });
    expect(await db.select().from(schema.coupons)).toHaveLength(0);
  });

  it("dois pedidos de clientes diferentes na janela: um cupom para cada, com a diferença de cada uma", async () => {
    const { variantId } = await createTestVariant(db, { sku: "LD-M3", name: "Longo Dunas" });
    await paidOrder({ variantId, unitPriceCents: 19900, name: "Ana" });
    await paidOrder({ variantId, unitPriceCents: 18900, quantity: 3, name: "Bia" });
    const drop = await activePrice(variantId, 17900, 19900, 2);
    expect(await protectPricesAfterDrop(sdb, { versionId: drop, variantId, priceCents: 17900, now: NOW })).toEqual({ issued: 2, already: 0 });
    const values = (await db.select({ value: schema.coupons.value }).from(schema.coupons)).map((c) => c.value).sort((a, b) => a - b);
    expect(values).toEqual([2000, 3000]);
  });
});
