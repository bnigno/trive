import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as schema from "@/db/schema";
import { createProduct } from "@/services/catalog";
import { getProductLabelSheet } from "@/services/product-labels";
import { createTestDb, FIXED_USER_ID, type TestDb } from "../helpers/db";

let db: TestDb;
let close: () => Promise<void>;

beforeEach(async () => {
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://trivemaison.com.br");
  ({ db, close } = await createTestDb());
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await close();
});

async function seedProduct() {
  const { product, variants } = await createProduct(db, {
    name: "Longo Dunas",
    composition: "100% linho",
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

    const sheet = await getProductLabelSheet(db, { productId: product.id, model: "adesiva", quantities: null });

    expect(sheet.productName).toBe("Longo Dunas");
    expect(sheet.storeName).toBe("Trivé Teste");
    expect(sheet.productUrl).toBe(`https://trivemaison.com.br/produto/${product.slug}`);
    // createProduct nasce em rascunho: a página avisa que o QR ainda não funciona.
    expect(sheet.productStatus).toBe("draft");
    expect(sheet.labels[0]).toMatchObject({ composition: "100% linho", productUrl: sheet.productUrl });
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
      model: "adesiva",
      quantities: { [variants[1].id]: 5 },
    });

    expect(sheet.lines.map((line) => [line.sku, line.quantity])).toEqual([
      ["DUNAS-VERDE-M", 5],
      ["DUNAS-VERDE-P", 0],
    ]);
    expect(sheet.labels).toHaveLength(5);
    expect(sheet.storeName).toBe("TRIVÉ");
  });

  it("gráfica: sem teto de folhas — a quantidade pedida vai inteira para a lista", async () => {
    const { product, variants } = await seedProduct();
    const sheet = await getProductLabelSheet(db, {
      productId: product.id,
      model: "cabide",
      format: "grafica",
      quantities: { [variants[0].id]: 150, [variants[1].id]: 150 },
    });
    expect(sheet.designs.map((design) => design.quantity)).toEqual([150, 150]);
    expect(sheet.truncated).toBe(false);
  });

  it("tag de cabide: folhas de 9 e um modelo por variação pedida", async () => {
    const { product, variants } = await seedProduct();
    const sheet = await getProductLabelSheet(db, {
      productId: product.id,
      model: "cabide",
      quantities: { [variants[0].id]: 12, [variants[1].id]: 3 },
    });
    expect(sheet.sheets.map((s) => s.length)).toEqual([9, 6]);
    expect(sheet.designs.map((design) => [design.sku, design.quantity])).toEqual([
      ["DUNAS-VERDE-M", 3],
      ["DUNAS-VERDE-P", 12],
    ]);
  });

  it("produto inexistente lança", async () => {
    await expect(
      getProductLabelSheet(db, { productId: "00000000-0000-4000-8000-000000000000", model: "cabide", quantities: null }),
    ).rejects.toThrow();
  });
});
