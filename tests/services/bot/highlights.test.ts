// Novidades e mais vendidas no caderninho da Lia: só nomes, só peças com
// estoque, por PRODUTO (nunca SKU), na janela certa; pedido cancelado ou
// velho não conta.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { BEST_SELLERS_DAYS, catalogHighlightLines, HIGHLIGHTS_MAX, NEW_ARRIVALS_DAYS } from "@/services/bot/highlights";
import { createTestCustomer, createTestDb, type TestDb } from "../../helpers/db";

const NOW = new Date("2026-09-20T15:00:00Z");
const DAY = 86_400_000;

let db: TestDb;
let sdb: DbOrTx;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  sdb = db as unknown as DbOrTx;
});

afterEach(async () => {
  await close();
});

async function seedProduct(name: string, opts: { createdAt?: Date; onHand?: number; variants?: number } = {}): Promise<{ productId: string; variantIds: string[] }> {
  const [product] = await db
    .insert(schema.products)
    .values({ name, slug: name.toLowerCase().replace(/\s+/g, "-"), status: "active", attributesSchema: ["tamanho"], ...(opts.createdAt ? { createdAt: opts.createdAt } : {}) })
    .returning({ id: schema.products.id });
  const variantIds: string[] = [];
  for (let index = 0; index < (opts.variants ?? 1); index += 1) {
    const [variant] = await db
      .insert(schema.productVariants)
      .values({ productId: product.id, sku: `SKU-${product.id.slice(0, 8)}-${index}`, attributes: { tamanho: ["P", "M", "G"][index] ?? "U" }, costCents: 100 })
      .returning({ id: schema.productVariants.id });
    await db.insert(schema.stockLevels).values({ productVariantId: variant.id, onHand: opts.onHand ?? 5, reserved: 0 });
    await db.insert(schema.priceVersions).values({ productVariantId: variant.id, versionNumber: 1, status: "active", priceCents: 10_000, origin: "initial", breakdown: {}, costSnapshotCents: 100, computedMarginRate: "0.3000", activatedAt: NOW });
    variantIds.push(variant.id);
  }
  return { productId: product.id, variantIds };
}

async function order(customerId: string, items: { variantId: string; quantity: number }[], opts: { paidAt?: Date; status?: string } = {}): Promise<void> {
  const total = items.reduce((sum, item) => sum + item.quantity * 10_000, 0);
  const [row] = await db
    .insert(schema.orders)
    .values({ customerId, status: opts.status ?? "paid", channel: "manual", subtotalCents: total, totalCents: total, paidAt: opts.paidAt ?? NOW })
    .returning({ id: schema.orders.id });
  for (const item of items) {
    await db.insert(schema.orderItems).values({
      orderId: row.id,
      productVariantId: item.variantId,
      skuSnapshot: `SKU-${item.variantId.slice(0, 6)}`,
      nameSnapshot: "peça",
      quantity: item.quantity,
      unitPriceCents: 10_000,
      unitCostCents: 100,
      totalCents: item.quantity * 10_000,
    });
  }
}

describe("catalogHighlightLines", () => {
  it("catálogo vazio: nada; novidades = peças COM estoque dos últimos 14 dias, da mais nova para a mais antiga, até 5", async () => {
    expect(await catalogHighlightLines(sdb, NOW)).toEqual([]);
    await seedProduct("Antiga", { createdAt: new Date(NOW.getTime() - (NEW_ARRIVALS_DAYS + 6) * DAY) });
    await seedProduct("Esgotada", { createdAt: new Date(NOW.getTime() - DAY), onHand: 0 });
    for (let index = 1; index <= HIGHLIGHTS_MAX + 2; index += 1) {
      await seedProduct(`Nova ${index}`, { createdAt: new Date(NOW.getTime() - index * DAY) });
    }
    const lines = await catalogHighlightLines(sdb, NOW);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(`Novidades (últimos ${NEW_ARRIVALS_DAYS} dias): Nova 1, Nova 2, Nova 3, Nova 4, Nova 5`);
    expect(lines[0]).not.toContain("Antiga");
    expect(lines[0]).not.toContain("Esgotada");
  });

  it("mais vendidas por PRODUTO (duas variações viram um nome), sem SKU; pedido velho ou cancelado não conta; esgotada não entra", async () => {
    const customerId = await createTestCustomer(db);
    const old = new Date(NOW.getTime() - 40 * DAY);
    const dunas = await seedProduct("Longo Dunas", { createdAt: old, variants: 2 });
    const maelle = await seedProduct("Blusa Maelle", { createdAt: old });
    const brisa = await seedProduct("Vestido Brisa", { createdAt: old });
    const zerada = await seedProduct("Zerada", { createdAt: old, onHand: 0 });
    await order(customerId, [{ variantId: dunas.variantIds[0], quantity: 1 }, { variantId: dunas.variantIds[1], quantity: 1 }]);
    await order(customerId, [{ variantId: maelle.variantIds[0], quantity: 1 }]);
    // Fora da janela e cancelado: não contam, mesmo com muitas unidades.
    await order(customerId, [{ variantId: brisa.variantIds[0], quantity: 10 }], { paidAt: new Date(NOW.getTime() - (BEST_SELLERS_DAYS + 5) * DAY) });
    await order(customerId, [{ variantId: brisa.variantIds[0], quantity: 10 }], { status: "canceled" });
    await order(customerId, [{ variantId: zerada.variantIds[0], quantity: 10 }]);

    const lines = await catalogHighlightLines(sdb, NOW);
    expect(lines).toEqual([`Mais vendidas (${BEST_SELLERS_DAYS} dias): Longo Dunas, Blusa Maelle`]);
    expect(lines[0]).not.toContain("SKU-");
  });
});
