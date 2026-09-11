// Prontidão lida do banco: fotos, preços (ativo/pendente), estoque, peso, sala
// e capa viram o selo de cada peça e o termômetro do painel.
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import { getReadinessSummary, listProductReadiness } from "@/services/catalog-readiness";
import { createTestDb, createTestVariant, type TestDb } from "../helpers/db";

let db: TestDb;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
});

afterEach(async () => {
  await close();
});

const LONG_DESCRIPTION = "Linho leve que respira no calor de Belém. ".repeat(6);

async function createCategory(coverPath: string | null): Promise<string> {
  const [row] = await db
    .insert(schema.categories)
    .values({ name: `Sala ${Math.random().toString(36).slice(2, 6)}`, slug: `sala-${Math.random().toString(36).slice(2, 8)}`, coverPath })
    .returning({ id: schema.categories.id });
  return row.id;
}

async function addPhotos(productId: string, total: number): Promise<void> {
  for (let index = 0; index < total; index++) {
    await db.insert(schema.productImages).values({
      productId,
      storagePath: `products/${productId}/${index}-full.webp`,
      sortOrder: index,
    });
  }
}

async function addPrice(variantId: string, status: "active" | "pending_approval"): Promise<void> {
  await db.insert(schema.priceVersions).values({
    productVariantId: variantId,
    versionNumber: 1,
    status,
    priceCents: 28900,
    origin: "initial",
    breakdown: {},
    costSnapshotCents: 10000,
    computedMarginRate: "0.3000",
    ...(status === "active" ? { activatedAt: new Date() } : {}),
  });
}

/** Peça completa: ativa, descrição longa, sala com capa, 2 fotos, peso, preço e estoque. */
async function createReadyProduct(): Promise<{ productId: string; variantId: string }> {
  const { productId, variantId } = await createTestVariant(db, { onHand: 3 });
  const categoryId = await createCategory("categories/x-full.webp");
  await db
    .update(schema.products)
    .set({ description: LONG_DESCRIPTION, categoryId })
    .where(eq(schema.products.id, productId));
  await db.update(schema.productVariants).set({ weightGrams: 300 }).where(eq(schema.productVariants.id, variantId));
  await addPhotos(productId, 2);
  await addPrice(variantId, "active");
  return { productId, variantId };
}

describe("listProductReadiness", () => {
  it("peça completa é 'pronta'", async () => {
    const { productId } = await createReadyProduct();
    const readiness = await listProductReadiness(db, { productIds: [productId] });
    expect(readiness.get(productId)).toEqual({ level: "ready", issues: [], primaryIssue: null });
  });

  it("sem preço bloqueia; com versão pendente diz que aguarda aprovação", async () => {
    const semPreco = await createTestVariant(db, { onHand: 2 });
    const pendente = await createTestVariant(db, { onHand: 2 });
    await addPrice(pendente.variantId, "pending_approval");

    const readiness = await listProductReadiness(db);
    expect(readiness.get(semPreco.productId)?.primaryIssue?.code).toBe("no_price");
    expect(readiness.get(pendente.productId)?.primaryIssue?.code).toBe("price_pending");
  });

  it("uma foto só, peso ausente e sala sem capa são avisos (quase pronta)", async () => {
    const { productId, variantId } = await createReadyProduct();
    await db.delete(schema.productImages).where(eq(schema.productImages.productId, productId));
    await addPhotos(productId, 1);
    await db.update(schema.productVariants).set({ weightGrams: null }).where(eq(schema.productVariants.id, variantId));
    const semCapa = await createCategory(null);
    await db.update(schema.products).set({ categoryId: semCapa }).where(eq(schema.products.id, productId));

    const result = (await listProductReadiness(db, { productIds: [productId] })).get(productId);
    expect(result?.level).toBe("almost");
    expect(result?.issues.map((issue) => issue.code)).toEqual([
      "one_photo",
      "category_no_cover",
      "no_weight",
    ]);
  });

  it("sem estoque disponível (reservado conta) e sem foto bloqueiam", async () => {
    const { productId, variantId } = await createReadyProduct();
    await db
      .update(schema.stockLevels)
      .set({ onHand: 1, reserved: 1 })
      .where(eq(schema.stockLevels.productVariantId, variantId));
    await db.delete(schema.productImages).where(eq(schema.productImages.productId, productId));

    const result = (await listProductReadiness(db, { productIds: [productId] })).get(productId);
    expect(result?.level).toBe("blocked");
    expect(result?.issues.map((issue) => issue.code)).toEqual(["no_stock", "no_photo"]);
  });

  it("filtra por productIds, ignora apagadas e devolve mapa vazio para lista vazia", async () => {
    const a = await createReadyProduct();
    const b = await createReadyProduct();
    await db.update(schema.products).set({ deletedAt: new Date() }).where(eq(schema.products.id, b.productId));

    expect((await listProductReadiness(db, { productIds: [a.productId] })).size).toBe(1);
    expect((await listProductReadiness(db)).has(b.productId)).toBe(false);
    expect((await listProductReadiness(db, { productIds: [] })).size).toBe(0);
  });
});

describe("getReadinessSummary", () => {
  it("conta as prontas sobre as não arquivadas", async () => {
    await createReadyProduct();
    const rascunho = await createTestVariant(db, { onHand: 1 });
    await db.update(schema.products).set({ status: "draft" }).where(eq(schema.products.id, rascunho.productId));
    const arquivada = await createTestVariant(db, { onHand: 1 });
    await db.update(schema.products).set({ status: "archived" }).where(eq(schema.products.id, arquivada.productId));

    expect(await getReadinessSummary(db)).toEqual({ ready: 1, total: 2, allReady: false });

    await db.update(schema.products).set({ status: "archived" }).where(eq(schema.products.id, rascunho.productId));
    expect(await getReadinessSummary(db)).toEqual({ ready: 1, total: 1, allReady: true });
  });
});
