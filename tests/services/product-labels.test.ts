import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import { createProduct } from "@/services/catalog";
import { getProductLabelSheet } from "@/services/product-labels";
import { createTestDb, FIXED_USER_ID, type TestDb } from "../helpers/db";

let db: TestDb;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
});

afterEach(async () => {
  await close();
});

async function seedProduct() {
  const { product, variants } = await createProduct(db, {
    name: "Longo Dunas",
    attributesSchema: ["cor", "tamanho"],
    variants: [
      { sku: "DUNAS-VERDE-P", attributes: { cor: "Verde", tamanho: "P" }, costCents: 9000 },
      { sku: "DUNAS-VERDE-M", attributes: { cor: "Verde", tamanho: "M" }, costCents: 9000 },
    ],
    userId: FIXED_USER_ID,
  });
  await db.insert(schema.priceVersions).values({
    productVariantId: variants[0].id,
    versionNumber: 1,
    status: "active",
    priceCents: 28900,
    origin: "initial",
    breakdown: {},
    costSnapshotCents: 9000,
    computedMarginRate: "0.3000",
  });
  return { product, variants };
}

describe("getProductLabelSheet", () => {
  it("sem quantidades: uma etiqueta por variação ativa, com preço ativo e nome da loja", async () => {
    const { product } = await seedProduct();
    await db.insert(schema.settings).values({ key: "store_name", value: "Trivé Teste" });

    const sheet = await getProductLabelSheet(db, { productId: product.id, quantities: null });

    expect(sheet.productName).toBe("Longo Dunas");
    expect(sheet.storeName).toBe("Trivé Teste");
    // getProductDetail ordena pelo SKU: M antes de P.
    expect(sheet.labels.map((label) => [label.sku, label.variantLabel, label.priceCents])).toEqual([
      ["DUNAS-VERDE-M", "Verde · M", null],
      ["DUNAS-VERDE-P", "Verde · P", 28900],
    ]);
    expect(sheet.withoutPrice).toEqual(["DUNAS-VERDE-M"]);
    expect(sheet.sheets).toHaveLength(1);
  });

  it("com quantidades: só a variação pedida, na quantidade pedida", async () => {
    const { product, variants } = await seedProduct();

    const sheet = await getProductLabelSheet(db, {
      productId: product.id,
      quantities: { [variants[1].id]: 5 },
    });

    expect(sheet.lines.map((line) => [line.sku, line.quantity])).toEqual([
      ["DUNAS-VERDE-M", 5],
      ["DUNAS-VERDE-P", 0],
    ]);
    expect(sheet.labels).toHaveLength(5);
    expect(sheet.storeName).toBe("TRIVÉ");
  });

  it("produto inexistente lança", async () => {
    await expect(
      getProductLabelSheet(db, { productId: "00000000-0000-4000-8000-000000000000", quantities: null }),
    ).rejects.toThrow();
  });
});
