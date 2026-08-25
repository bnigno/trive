import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import {
  computeTotalWeightGrams,
  DEFAULT_ITEM_WEIGHT_GRAMS,
  getPublicProductBySlug,
  listPublicCategories,
  listPublicProducts,
  publicImageUrl,
  publicThumbUrl,
  quoteShipping,
  ServiceError,
} from "@/services/store-catalog";
import { createTestDb, type TestDb } from "../helpers/db";

let db: TestDb;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
});

afterEach(async () => {
  await close();
});

// ---------------------------------------------------------------------------
// Fixtures locais: produto público = ativo + variante ativa + preço ativo.
// price_versions inserido direto (status 'active', breakdown {}) como
// combinado — o fluxo completo de aprovação é coberto em pricing.test.ts.
// ---------------------------------------------------------------------------

interface VariantSpec {
  sku: string;
  attributes?: Record<string, string>;
  weightGrams?: number;
  onHand?: number;
  reserved?: number;
  /** null = variante SEM preço ativo. */
  priceCents?: number | null;
  compareAtPriceCents?: number;
  priceStatus?: string;
  isActive?: boolean;
}

async function createPublicProduct(
  opts: {
    name: string;
    slug?: string;
    status?: "draft" | "active" | "archived";
    brand?: string;
    categoryId?: string;
    attributesSchema?: string[];
    createdAt?: Date;
    variants: VariantSpec[];
  },
): Promise<{ productId: string; variantIds: string[] }> {
  const [product] = await db
    .insert(schema.products)
    .values({
      name: opts.name,
      slug: opts.slug ?? opts.name.toLowerCase().replace(/\s+/g, "-"),
      status: opts.status ?? "active",
      brand: opts.brand ?? null,
      categoryId: opts.categoryId ?? null,
      attributesSchema: opts.attributesSchema ?? [],
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    })
    .returning({ id: schema.products.id });

  const variantIds: string[] = [];
  for (const [index, spec] of opts.variants.entries()) {
    const [variant] = await db
      .insert(schema.productVariants)
      .values({
        productId: product.id,
        sku: spec.sku,
        // Distinto por SKU para respeitar o unique (product_id, attributes).
        attributes: spec.attributes ?? { sku: spec.sku },
        weightGrams: spec.weightGrams ?? null,
        isActive: spec.isActive ?? true,
      })
      .returning({ id: schema.productVariants.id });
    variantIds.push(variant.id);

    await db.insert(schema.stockLevels).values({
      productVariantId: variant.id,
      onHand: spec.onHand ?? 0,
      reserved: spec.reserved ?? 0,
    });

    if (spec.priceCents !== null && spec.priceCents !== undefined) {
      await db.insert(schema.priceVersions).values({
        productVariantId: variant.id,
        versionNumber: index + 1,
        status: spec.priceStatus ?? "active",
        priceCents: spec.priceCents,
        compareAtPriceCents: spec.compareAtPriceCents ?? null,
        origin: "initial",
        breakdown: {},
        costSnapshotCents: 0,
        computedMarginRate: "0.3000",
        activatedAt: new Date(),
      });
    }
  }

  return { productId: product.id, variantIds };
}

async function createCategory(name: string, slug: string): Promise<string> {
  const [category] = await db
    .insert(schema.categories)
    .values({ name, slug })
    .returning({ id: schema.categories.id });
  return category.id;
}

// ---------------------------------------------------------------------------
// listPublicProducts
// ---------------------------------------------------------------------------

describe("listPublicProducts", () => {
  it("não lista produto sem preço ativo (sem versão ou versão draft)", async () => {
    await createPublicProduct({
      name: "Com Preço",
      variants: [{ sku: "CP-1", priceCents: 5000 }],
    });
    await createPublicProduct({
      name: "Sem Preço",
      variants: [{ sku: "SP-1", priceCents: null }],
    });
    await createPublicProduct({
      name: "Preço Draft",
      variants: [{ sku: "PD-1", priceCents: 7000, priceStatus: "draft" }],
    });

    const rows = await listPublicProducts(db);
    expect(rows.map((row) => row.name)).toEqual(["Com Preço"]);
  });

  it("não lista produto draft nem produto cuja única variante com preço está inativa", async () => {
    await createPublicProduct({
      name: "Rascunho",
      status: "draft",
      variants: [{ sku: "RA-1", priceCents: 5000 }],
    });
    await createPublicProduct({
      name: "Variante Inativa",
      variants: [{ sku: "VI-1", priceCents: 5000, isActive: false }],
    });

    expect(await listPublicProducts(db)).toEqual([]);
  });

  it("calcula menor/maior preço entre 2 variantes, disponibilidade e primeira imagem", async () => {
    const { productId } = await createPublicProduct({
      name: "Colar Sol",
      brand: "TRIVË",
      variants: [
        { sku: "CS-P", priceCents: 5000, onHand: 3, reserved: 1 },
        { sku: "CS-G", priceCents: 8990, onHand: 0 },
      ],
    });
    await db.insert(schema.productImages).values([
      { productId, storagePath: "products/x/b-full.webp", sortOrder: 1 },
      { productId, storagePath: "products/x/a-full.webp", sortOrder: 0 },
    ]);
    await createPublicProduct({
      name: "Esgotado",
      variants: [{ sku: "ESG-1", priceCents: 1000, onHand: 2, reserved: 2 }],
    });

    const rows = await listPublicProducts(db);
    const colar = rows.find((row) => row.name === "Colar Sol");
    expect(colar).toMatchObject({
      brand: "TRIVË",
      priceFromCents: 5000,
      priceToCents: 8990,
      imagePath: "products/x/a-full.webp",
      available: true,
    });
    const esgotado = rows.find((row) => row.name === "Esgotado");
    expect(esgotado).toMatchObject({ available: false, imagePath: null });
  });

  it("ordena por created_at desc, filtra por categoria e busca por nome/marca (ILIKE)", async () => {
    const categoryId = await createCategory("Colares", "colares");
    await createPublicProduct({
      name: "Antigo",
      categoryId,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      variants: [{ sku: "ANT-1", priceCents: 1000 }],
    });
    await createPublicProduct({
      name: "Recente",
      brand: "Marca Nova",
      createdAt: new Date("2026-02-01T00:00:00Z"),
      variants: [{ sku: "REC-1", priceCents: 2000 }],
    });

    const all = await listPublicProducts(db);
    expect(all.map((row) => row.name)).toEqual(["Recente", "Antigo"]);
    expect(all.find((row) => row.name === "Antigo")?.categoryName).toBe("Colares");

    const byCategory = await listPublicProducts(db, { categorySlug: "colares" });
    expect(byCategory.map((row) => row.name)).toEqual(["Antigo"]);

    const byBrand = await listPublicProducts(db, { q: "marca no" });
    expect(byBrand.map((row) => row.name)).toEqual(["Recente"]);

    const byName = await listPublicProducts(db, { q: "ANTIGO" });
    expect(byName.map((row) => row.name)).toEqual(["Antigo"]);
  });
});

// ---------------------------------------------------------------------------
// listPublicCategories
// ---------------------------------------------------------------------------

describe("listPublicCategories", () => {
  it("lista apenas categorias com produto ativo com preço, com contagem", async () => {
    const comProduto = await createCategory("Anéis", "aneis");
    await createCategory("Vazia", "vazia");
    const semPreco = await createCategory("Sem Preço", "sem-preco");

    await createPublicProduct({
      name: "Anel Um",
      categoryId: comProduto,
      variants: [{ sku: "AN-1", priceCents: 1500 }],
    });
    await createPublicProduct({
      name: "Anel Dois",
      categoryId: comProduto,
      variants: [{ sku: "AN-2", priceCents: 2500 }],
    });
    await createPublicProduct({
      name: "Nunca Precificado",
      categoryId: semPreco,
      variants: [{ sku: "NP-1", priceCents: null }],
    });

    const rows = await listPublicCategories(db);
    expect(rows).toEqual([
      { id: comProduto, name: "Anéis", slug: "aneis", productCount: 2 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// getPublicProductBySlug
// ---------------------------------------------------------------------------

describe("getPublicProductBySlug", () => {
  it("retorna detalhe com apenas variantes ativas com preço e availableQty", async () => {
    const categoryId = await createCategory("Brincos", "brincos");
    const { productId } = await createPublicProduct({
      name: "Brinco Lua",
      slug: "brinco-lua",
      brand: "TRIVË",
      categoryId,
      attributesSchema: ["cor"],
      variants: [
        {
          sku: "BL-PRATA",
          attributes: { cor: "prata" },
          priceCents: 4500,
          compareAtPriceCents: 5900,
          weightGrams: 120,
          onHand: 5,
          reserved: 2,
        },
        { sku: "BL-DOURADO", attributes: { cor: "dourado" }, priceCents: null },
        { sku: "BL-INATIVO", priceCents: 3000, isActive: false },
      ],
    });
    await db.insert(schema.productImages).values([
      { productId, storagePath: "products/b/2-full.webp", sortOrder: 1 },
      { productId, storagePath: "products/b/1-full.webp", sortOrder: 0 },
    ]);

    const detail = await getPublicProductBySlug(db, "brinco-lua");
    expect(detail).not.toBeNull();
    expect(detail).toMatchObject({
      name: "Brinco Lua",
      slug: "brinco-lua",
      brand: "TRIVË",
      categoryName: "Brincos",
      attributesSchema: ["cor"],
      images: ["products/b/1-full.webp", "products/b/2-full.webp"],
    });
    expect(detail!.variants).toHaveLength(1);
    expect(detail!.variants[0]).toEqual({
      variantId: expect.any(String),
      sku: "BL-PRATA",
      attributes: { cor: "prata" },
      priceCents: 4500,
      compareAtPriceCents: 5900,
      availableQty: 3,
      weightGrams: 120,
    });
  });

  it("retorna null para slug inexistente, produto draft e produto sem variante com preço", async () => {
    await createPublicProduct({
      name: "Oculto",
      slug: "oculto",
      status: "draft",
      variants: [{ sku: "OC-1", priceCents: 1000 }],
    });
    await createPublicProduct({
      name: "Sem Preço Ativo",
      slug: "sem-preco-ativo",
      variants: [{ sku: "SPA-1", priceCents: null }],
    });

    expect(await getPublicProductBySlug(db, "nao-existe")).toBeNull();
    expect(await getPublicProductBySlug(db, "oculto")).toBeNull();
    expect(await getPublicProductBySlug(db, "sem-preco-ativo")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// quoteShipping
// ---------------------------------------------------------------------------

async function insertRate(opts: {
  name: string;
  cepStart: string;
  cepEnd: string;
  weightMinGrams?: number;
  weightMaxGrams?: number;
  priceCents: number;
  deliveryDaysMin?: number;
  deliveryDaysMax?: number;
  isActive?: boolean;
  sortOrder?: number;
}): Promise<void> {
  await db.insert(schema.shippingRates).values({
    name: opts.name,
    cepStart: opts.cepStart,
    cepEnd: opts.cepEnd,
    weightMinGrams: opts.weightMinGrams ?? 0,
    weightMaxGrams: opts.weightMaxGrams ?? 30000,
    priceCents: opts.priceCents,
    deliveryDaysMin: opts.deliveryDaysMin ?? 2,
    deliveryDaysMax: opts.deliveryDaysMax ?? 7,
    isActive: opts.isActive ?? true,
    sortOrder: opts.sortOrder ?? 0,
  });
}

describe("quoteShipping", () => {
  it("retorna faixas que cobrem o CEP ordenadas por preço; vazio fora da faixa", async () => {
    await insertRate({
      name: "Sedex SP",
      cepStart: "01000000",
      cepEnd: "01999999",
      priceCents: 2490,
      deliveryDaysMin: 1,
      deliveryDaysMax: 3,
    });
    await insertRate({
      name: "PAC SP",
      cepStart: "01000000",
      cepEnd: "01999999",
      priceCents: 1590,
      deliveryDaysMin: 4,
      deliveryDaysMax: 9,
    });
    await insertRate({
      name: "Inativa SP",
      cepStart: "01000000",
      cepEnd: "01999999",
      priceCents: 100,
      isActive: false,
    });

    // CEP com máscara é normalizado para 8 dígitos.
    const quotes = await quoteShipping(db, { cep: "01310-100", totalWeightGrams: 500 });
    expect(quotes.map((quote) => quote.name)).toEqual(["PAC SP", "Sedex SP"]);
    expect(quotes[0]).toEqual({
      rateId: expect.any(String),
      name: "PAC SP",
      priceCents: 1590,
      deliveryDaysMin: 4,
      deliveryDaysMax: 9,
    });

    // Fora da faixa de CEP: a UI mostra "não entregamos para este CEP".
    expect(await quoteShipping(db, { cep: "99999999", totalWeightGrams: 500 })).toEqual([]);
  });

  it("inclui CEP nas fronteiras cepStart e cepEnd (comparação de string)", async () => {
    await insertRate({
      name: "Faixa Exata",
      cepStart: "04500000",
      cepEnd: "04599999",
      priceCents: 2000,
    });

    expect(await quoteShipping(db, { cep: "04500000", totalWeightGrams: 100 })).toHaveLength(1);
    expect(await quoteShipping(db, { cep: "04599999", totalWeightGrams: 100 })).toHaveLength(1);
    expect(await quoteShipping(db, { cep: "04499999", totalWeightGrams: 100 })).toEqual([]);
    expect(await quoteShipping(db, { cep: "04600000", totalWeightGrams: 100 })).toEqual([]);
  });

  it("peso nas fronteiras min e max é INCLUSO; fora delas não", async () => {
    await insertRate({
      name: "Meio Quilo a Um",
      cepStart: "00000000",
      cepEnd: "99999999",
      weightMinGrams: 500,
      weightMaxGrams: 1000,
      priceCents: 3000,
    });

    expect(await quoteShipping(db, { cep: "01310100", totalWeightGrams: 500 })).toHaveLength(1);
    expect(await quoteShipping(db, { cep: "01310100", totalWeightGrams: 1000 })).toHaveLength(1);
    expect(await quoteShipping(db, { cep: "01310100", totalWeightGrams: 499 })).toEqual([]);
    expect(await quoteShipping(db, { cep: "01310100", totalWeightGrams: 1001 })).toEqual([]);
  });

  it("lança erro pt-BR para CEP inválido", async () => {
    await expect(
      quoteShipping(db, { cep: "1234", totalWeightGrams: 100 }),
    ).rejects.toThrow("CEP inválido. Informe um CEP com 8 dígitos.");
    await expect(
      quoteShipping(db, { cep: "abcdefgh", totalWeightGrams: 100 }),
    ).rejects.toThrow(ServiceError);
  });
});

// ---------------------------------------------------------------------------
// Peso do carrinho e URLs públicas (funções puras)
// ---------------------------------------------------------------------------

describe("computeTotalWeightGrams", () => {
  it("usa 300g como padrão para item sem peso cadastrado", () => {
    expect(DEFAULT_ITEM_WEIGHT_GRAMS).toBe(300);
    expect(
      computeTotalWeightGrams([
        { weightGrams: 120, quantity: 2 },
        { weightGrams: null, quantity: 3 },
      ]),
    ).toBe(120 * 2 + 300 * 3);
  });
});

describe("publicImageUrl", () => {
  const originalEnv = process.env.NEXT_PUBLIC_SUPABASE_URL;
  afterEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = originalEnv;
  });

  it("monta a URL pública do bucket product-images e o thumb por convenção", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://abc.supabase.co/";
    expect(publicImageUrl("products/p1/img-full.webp")).toBe(
      "https://abc.supabase.co/storage/v1/object/public/product-images/products/p1/img-full.webp",
    );
    expect(publicThumbUrl("products/p1/img-full.webp")).toBe(
      "https://abc.supabase.co/storage/v1/object/public/product-images/products/p1/img-thumb.webp",
    );
  });
});
