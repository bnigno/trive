import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeCorreiosQuoter } from "@/adapters/superfrete/fake";
import * as schema from "@/db/schema";
import {
  computeTotalWeightGrams,
  DEFAULT_ITEM_WEIGHT_GRAMS,
  getPublicProductBySlug,
  listPublicCategories,
  listPublicProducts,
  listRelatedPublicProducts,
  publicImageUrl,
  publicMdUrl,
  publicThumbUrl,
  quoteDeliveryOptions,
  quoteSameDayPromise,
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
      brand: "TRIVÉ",
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
      brand: "TRIVÉ",
      priceFromCents: 5000,
      priceToCents: 8990,
      imagePath: "products/x/a-full.webp",
      hoverImagePath: "products/x/b-full.webp",
      available: true,
    });
    const esgotado = rows.find((row) => row.name === "Esgotado");
    expect(esgotado).toMatchObject({
      available: false,
      imagePath: null,
      hoverImagePath: null,
    });
  });

  it("produto com uma única foto não tem segunda foto para o hover", async () => {
    const { productId } = await createPublicProduct({
      name: "Uma Foto",
      variants: [{ sku: "UF-1", priceCents: 1000 }],
    });
    await db
      .insert(schema.productImages)
      .values({ productId, storagePath: "products/u/a-full.webp", sortOrder: 0 });

    const [row] = await listPublicProducts(db);
    expect(row).toMatchObject({
      imagePath: "products/u/a-full.webp",
      hoverImagePath: null,
    });
  });

  it("usa como capa a primeira foto por sort_order, mesmo que ela seja de uma cor", async () => {
    const { productId } = await createPublicProduct({
      name: "Camisa Cores",
      attributesSchema: ["cor"],
      variants: [
        { sku: "CC-VE", attributes: { cor: "Verde" }, priceCents: 9900, onHand: 1 },
      ],
    });
    await db.insert(schema.productImages).values([
      { productId, storagePath: "products/c/geral-full.webp", color: null, sortOrder: 1 },
      { productId, storagePath: "products/c/verde-full.webp", color: "Verde", sortOrder: 0 },
    ]);

    const rows = await listPublicProducts(db);
    const camisa = rows.find((row) => row.name === "Camisa Cores");
    expect(camisa?.imagePath).toBe("products/c/verde-full.webp");
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
      {
        id: comProduto,
        name: "Anéis",
        slug: "aneis",
        productCount: 2,
        coverPath: null,
        coverFocalY: 50,
      },
    ]);
  });

  it("devolve a capa e o foco da sala quando existem", async () => {
    const [category] = await db
      .insert(schema.categories)
      .values({
        name: "Vestidos",
        slug: "vestidos",
        coverPath: "categories/v/capa-full.webp",
        coverFocalY: 15,
      })
      .returning({ id: schema.categories.id });
    await createPublicProduct({
      name: "Vestido Um",
      categoryId: category.id,
      variants: [{ sku: "VE-1", priceCents: 1500 }],
    });

    const [row] = await listPublicCategories(db);
    expect(row).toMatchObject({
      slug: "vestidos",
      coverPath: "categories/v/capa-full.webp",
      coverFocalY: 15,
    });
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
      brand: "TRIVÉ",
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
      brand: "TRIVÉ",
      categoryName: "Brincos",
      attributesSchema: ["cor"],
      images: [
        { path: "products/b/1-full.webp", color: null },
        { path: "products/b/2-full.webp", color: null },
      ],
    });
    expect(detail!.variants).toHaveLength(1);
    expect(detail!.variants[0]).toEqual({
      variantId: expect.any(String),
      sku: "BL-PRATA",
      measurements: null,
      attributes: { cor: "prata" },
      priceCents: 4500,
      compareAtPriceCents: 5900,
      availableQty: 3,
      weightGrams: 120,
    });
  });

  it("expõe o cartão do post para a prévia do link (null enquanto não desenhado)", async () => {
    const { productId } = await createPublicProduct({
      name: "Longo Dunas",
      slug: "longo-dunas",
      variants: [{ sku: "LD-M", priceCents: 28900 }],
    });
    expect((await getPublicProductBySlug(db, "longo-dunas"))?.postCardPath).toBeNull();
    await db.update(schema.products).set({ postCardPath: "cards/ab/abc.jpg" }).where(eq(schema.products.id, productId));
    expect((await getPublicProductBySlug(db, "longo-dunas"))?.postCardPath).toBe("cards/ab/abc.jpg");
  });

  it("devolve a cor de cada foto (null = foto do produto inteiro) sem filtrar nada", async () => {
    const { productId } = await createPublicProduct({
      name: "Polo Cores",
      slug: "polo-cores",
      attributesSchema: ["cor", "tamanho"],
      variants: [
        { sku: "PC-VE-M", attributes: { cor: "Verde", tamanho: "M" }, priceCents: 12900 },
        { sku: "PC-AZ-M", attributes: { cor: "Azul", tamanho: "M" }, priceCents: 12900 },
      ],
    });
    await db.insert(schema.productImages).values([
      { productId, storagePath: "products/p/azul-full.webp", color: "Azul", sortOrder: 2 },
      { productId, storagePath: "products/p/geral-full.webp", color: null, sortOrder: 1 },
      { productId, storagePath: "products/p/verde-full.webp", color: "Verde", sortOrder: 0 },
    ]);

    const detail = await getPublicProductBySlug(db, "polo-cores");
    // Todas as fotos voltam, na ordem de sort_order: quem escolhe o que
    // mostrar por cor é a vitrine, não o service.
    expect(detail!.images).toEqual([
      { path: "products/p/verde-full.webp", color: "Verde" },
      { path: "products/p/geral-full.webp", color: null },
      { path: "products/p/azul-full.webp", color: "Azul" },
    ]);
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
      kind: "correios",
      deliveryWindows: [],
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

describe("quoteDeliveryOptions (motoboy com janelas)", () => {
  const WINDOWS = [
    { start: "16:00", end: "19:00", cutoff: "13:00" },
    { start: "19:00", end: "21:00", cutoff: "13:00" },
  ];

  async function insertMotoboy(): Promise<void> {
    await db.insert(schema.shippingRates).values({
      name: "Motoboy Belém",
      cepStart: "66000000",
      cepEnd: "66999999",
      weightMinGrams: 0,
      weightMaxGrams: 30000,
      priceCents: 1500,
      deliveryDaysMin: 0,
      deliveryDaysMax: 0,
      kind: "motoboy",
      deliveryWindows: WINDOWS,
      isActive: true,
      sortOrder: 0,
    });
  }

  it("antes da hora-limite (relógio de SP): janelas de hoje; depois: amanhã — e onde o motoboy chega os Correios não aparecem", async () => {
    await insertMotoboy();
    await insertRate({ name: "PAC Norte", cepStart: "66000000", cepEnd: "66999999", priceCents: 1990, deliveryDaysMin: 5, deliveryDaysMax: 9 });

    // 10:30 em São Paulo (13:30Z), sexta 18/09/2026.
    const before = await quoteDeliveryOptions(db, { cep: "66050-000", totalWeightGrams: 400, now: new Date("2026-09-18T13:30:00Z") });
    expect(before.map((o) => (o.kind === "motoboy" ? `${o.optionKey.split(":").slice(1).join(":")} ${o.label}` : o.kind))).toEqual([
      "2026-09-18:16:00 hoje, 16h–19h · pague até 13h",
      "2026-09-18:19:00 hoje, 19h–21h · pague até 13h",
    ]);
    expect(before[0]).toMatchObject({ kind: "motoboy", name: "Motoboy Belém", priceCents: 1500, when: "today", window: { dayKey: "2026-09-18", cutoff: "13:00" } });

    // 13:00 em ponto já passou do limite → amanhã; o PAC Norte continua fora (motoboy exclusivo na área).
    const after = await quoteDeliveryOptions(db, { cep: "66050-000", totalWeightGrams: 400, now: new Date("2026-09-18T16:00:00Z") });
    expect(after.map((o) => (o.kind === "motoboy" ? `${o.window.dayKey} ${o.label}` : o.kind))).toEqual([
      "2026-09-19 amanhã, 16h–19h",
      "2026-09-19 amanhã, 19h–21h",
    ]);

    // A cotação clássica continua uma linha por faixa: quem esconde os Correios é a expansão em opções.
    const classic = await quoteShipping(db, { cep: "66050-000", totalWeightGrams: 400 });
    expect(classic.map((q) => [q.name, q.kind, q.deliveryWindows.length])).toEqual([
      ["Motoboy Belém", "motoboy", 2],
      ["PAC Norte", "correios", 0],
    ]);
  });

  it("fora da faixa de CEP do motoboy não aparece janela; faixa Correios com janelas gravadas por engano é ignorada", async () => {
    await insertMotoboy();
    await insertRate({ name: "PAC SP", cepStart: "01000000", cepEnd: "05999999", priceCents: 1590 });
    await db.update(schema.shippingRates).set({ deliveryWindows: WINDOWS }).where(eq(schema.shippingRates.name, "PAC SP"));

    const sp = await quoteDeliveryOptions(db, { cep: "01310-100", totalWeightGrams: 400, now: new Date("2026-09-18T13:30:00Z") });
    expect(sp.map((o) => o.kind)).toEqual(["correios"]);
    expect(sp[0]).toMatchObject({ optionKey: expect.stringMatching(/^[0-9a-f-]{36}$/), deliveryDaysMin: 2, deliveryDaysMax: 7 });
  });
});

// ---------------------------------------------------------------------------
// quoteDeliveryOptions + Correios automático (SuperFrete): só onde NENHUMA
// faixa cobre o CEP, cache por 12 h com os mesmos ids, falha = lista vazia.
// ---------------------------------------------------------------------------

describe("quoteDeliveryOptions (Correios automático pela SuperFrete)", () => {
  const NOW = new Date("2026-09-19T15:00:00Z");
  const SP = "01310-100";
  let fake: FakeCorreiosQuoter;

  async function enableCorreiosAuto(opts: { enabled?: boolean; storeCep?: string; surchargeCents?: number } = {}): Promise<void> {
    await db.insert(schema.settings).values([
      { key: "correios_auto_enabled", value: opts.enabled ?? true },
      { key: "store_cep", value: opts.storeCep ?? "66045-335" },
      { key: "correios_surcharge_cents", value: opts.surchargeCents ?? 300 },
    ]);
  }

  async function insertMotoboyBelem(opts: { weightMaxGrams?: number; withWindows?: boolean } = {}): Promise<void> {
    await db.insert(schema.shippingRates).values({
      name: "Motoboy Belém",
      cepStart: "66000000",
      cepEnd: "66999999",
      weightMinGrams: 0,
      weightMaxGrams: opts.weightMaxGrams ?? 30000,
      priceCents: 1500,
      deliveryDaysMin: 0,
      deliveryDaysMax: 0,
      kind: "motoboy",
      deliveryWindows: opts.withWindows === false ? [] : [{ start: "19:00", end: "21:00", cutoff: "13:00" }],
      isActive: true,
      sortOrder: 0,
    });
  }

  beforeEach(() => {
    fake = new FakeCorreiosQuoter();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sem faixa para o CEP: PAC e SEDEX com o acréscimo, id da linha como rateId e peso cobrado mínimo de 300 g", async () => {
    await enableCorreiosAuto();
    const options = await quoteDeliveryOptions(db, { cep: SP, totalWeightGrams: 100, now: NOW }, { correios: fake });

    expect(options.map((o) => [o.name, o.kind, o.priceCents])).toEqual([
      ["PAC", "correios", 2290 + 300],
      ["SEDEX", "correios", 3990 + 300],
    ]);
    expect(options[0]).toMatchObject({ deliveryDaysMin: 6, deliveryDaysMax: 9, optionKey: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(options[0].optionKey).toBe(options[0].rateId);

    expect(fake.calls).toEqual([
      { fromCep: "66045335", toCep: "01310100", weightGrams: 300, package: { heightCm: 4, widthCm: 16, lengthCm: 24 }, services: ["PAC", "SEDEX"] },
    ]);

    const rows = await db.select().from(schema.shippingQuotes).orderBy(asc(schema.shippingQuotes.serviceCode));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      provider: "superfrete",
      serviceCode: "1",
      name: "PAC",
      cepFrom: "66045335",
      cepTo: "01310100",
      weightGrams: 300,
      providerPriceCents: 2290,
      surchargeCents: 300,
      priceCents: 2590,
      deliveryDaysMin: 6,
      deliveryDaysMax: 9,
    });
    expect(rows[0].batchId).toBe(rows[1].batchId);
    expect(rows[0].expiresAt.toISOString()).toBe("2026-09-20T15:00:00.000Z");
    expect(rows[0].raw).toMatchObject({ id: 1 });
    expect(rows.map((r) => r.id).sort()).toEqual(options.map((o) => o.rateId).sort());
  });

  it("a mesma pergunta em até 12 h reaproveita o lote (mesmos ids, sem nova chamada); depois de 12 h cota de novo com ids novos", async () => {
    await enableCorreiosAuto();
    const first = await quoteDeliveryOptions(db, { cep: SP, totalWeightGrams: 600, now: NOW }, { correios: fake });
    const again = await quoteDeliveryOptions(db, { cep: "01310100", totalWeightGrams: 600, now: new Date(NOW.getTime() + 11 * 3600_000) }, { correios: fake });
    expect(again.map((o) => o.rateId)).toEqual(first.map((o) => o.rateId));
    expect(fake.calls).toHaveLength(1);

    const later = await quoteDeliveryOptions(db, { cep: SP, totalWeightGrams: 600, now: new Date(NOW.getTime() + 13 * 3600_000) }, { correios: fake });
    expect(fake.calls).toHaveLength(2);
    expect(later.map((o) => o.rateId)).not.toEqual(first.map((o) => o.rateId));
    expect(await db.$count(schema.shippingQuotes)).toBe(4);

    // Peso, acréscimo ou CEP diferentes são outra pergunta.
    await quoteDeliveryOptions(db, { cep: SP, totalWeightGrams: 1200, now: NOW }, { correios: fake });
    expect(fake.calls).toHaveLength(3);
    await db.update(schema.settings).set({ value: 500 }).where(eq(schema.settings.key, "correios_surcharge_cents"));
    const dearer = await quoteDeliveryOptions(db, { cep: SP, totalWeightGrams: 600, now: NOW }, { correios: fake });
    expect(fake.calls).toHaveLength(4);
    expect(dearer[0].priceCents).toBe(2290 + 500);
  });

  it("lote recente mas já vencido (expires_at no passado) não é reaproveitado", async () => {
    await enableCorreiosAuto();
    await quoteDeliveryOptions(db, { cep: SP, totalWeightGrams: 600, now: NOW }, { correios: fake });
    await db.update(schema.shippingQuotes).set({ expiresAt: new Date(NOW.getTime() - 1000) });
    await quoteDeliveryOptions(db, { cep: SP, totalWeightGrams: 600, now: NOW }, { correios: fake });
    expect(fake.calls).toHaveLength(2);
  });

  it("onde um motoboy ativo cobre o CEP nunca chama o provedor — mesmo com o peso fora da faixa ou sem janela", async () => {
    await enableCorreiosAuto();
    await insertMotoboyBelem({ weightMaxGrams: 500 });
    const heavy = await quoteDeliveryOptions(db, { cep: "66050-000", totalWeightGrams: 900, now: NOW }, { correios: fake });
    expect(heavy).toEqual([]);

    await db.delete(schema.shippingRates);
    await insertMotoboyBelem({ withWindows: false });
    const noWindows = await quoteDeliveryOptions(db, { cep: "66050-000", totalWeightGrams: 300, now: NOW }, { correios: fake });
    expect(noWindows).toEqual([]);

    // Faixa de motoboy inativa não conta: aí os Correios automáticos entram.
    await db.update(schema.shippingRates).set({ isActive: false });
    const inactive = await quoteDeliveryOptions(db, { cep: "66050-000", totalWeightGrams: 300, now: NOW }, { correios: fake });
    expect(inactive.map((o) => o.name)).toEqual(["PAC", "SEDEX"]);
    expect(fake.calls).toHaveLength(1);
  });

  it("uma faixa manual de Correios ativa para o CEP vence: só ela aparece e o provedor não é chamado", async () => {
    await enableCorreiosAuto();
    await insertRate({ name: "PAC SP (manual)", cepStart: "01000000", cepEnd: "05999999", priceCents: 1590 });
    const options = await quoteDeliveryOptions(db, { cep: SP, totalWeightGrams: 600, now: NOW }, { correios: fake });
    expect(options.map((o) => o.name)).toEqual(["PAC SP (manual)"]);
    expect(fake.calls).toHaveLength(0);
  });

  it("desligado, sem CEP de origem, provedor fora do ar ou sem serviço para o trecho: lista vazia (o fluxo pela equipe), sem lançar", async () => {
    await enableCorreiosAuto({ enabled: false });
    expect(await quoteDeliveryOptions(db, { cep: SP, totalWeightGrams: 600, now: NOW }, { correios: fake })).toEqual([]);
    expect(fake.calls).toHaveLength(0);

    await db.update(schema.settings).set({ value: true }).where(eq(schema.settings.key, "correios_auto_enabled"));
    await db.update(schema.settings).set({ value: "" }).where(eq(schema.settings.key, "store_cep"));
    expect(await quoteDeliveryOptions(db, { cep: SP, totalWeightGrams: 600, now: NOW }, { correios: fake })).toEqual([]);
    expect(fake.calls).toHaveLength(0);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("sem CEP de origem"));

    await db.update(schema.settings).set({ value: "66045-335" }).where(eq(schema.settings.key, "store_cep"));
    fake.failNext("timeout");
    expect(await quoteDeliveryOptions(db, { cep: SP, totalWeightGrams: 600, now: NOW }, { correios: fake })).toEqual([]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("(timeout)"));
    expect(await db.$count(schema.shippingQuotes)).toBe(0);

    fake.set([]);
    expect(await quoteDeliveryOptions(db, { cep: SP, totalWeightGrams: 600, now: NOW }, { correios: fake })).toEqual([]);
    expect(await db.$count(schema.shippingQuotes)).toBe(0);
    expect(fake.calls).toHaveLength(2);
  });

  it("sem o provedor injetado (chamadores antigos) e no selo da página da peça, nada muda e nada é chamado", async () => {
    await enableCorreiosAuto();
    expect(await quoteDeliveryOptions(db, { cep: SP, totalWeightGrams: 600, now: NOW })).toEqual([]);
    expect(await quoteSameDayPromise(db, { cep: SP, totalWeightGrams: 600, now: NOW })).toBeNull();
    expect(await db.$count(schema.shippingQuotes)).toBe(0);
  });

  it("CEP de origem gravado sem hífen volta do jsonb como número e ainda assim serve", async () => {
    await enableCorreiosAuto({ storeCep: "66045335" });
    const map = await db.select().from(schema.settings).where(eq(schema.settings.key, "store_cep"));
    expect(typeof map[0].value).toBe("number");
    const options = await quoteDeliveryOptions(db, { cep: SP, totalWeightGrams: 600, now: NOW }, { correios: fake });
    expect(options.map((o) => o.name)).toEqual(["PAC", "SEDEX"]);
    expect(fake.calls[0].fromCep).toBe("66045335");
  });

  it("CEP inválido continua lançando cep_invalido antes de qualquer cotação", async () => {
    await enableCorreiosAuto();
    await expect(quoteDeliveryOptions(db, { cep: "123", totalWeightGrams: 600, now: NOW }, { correios: fake })).rejects.toMatchObject({ code: "cep_invalido" });
    expect(fake.calls).toHaveLength(0);
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

describe("categorySlug e excludeProductId", () => {
  it("getPublicProductBySlug devolve o slug da categoria (ou null sem categoria)", async () => {
    const [category] = await db
      .insert(schema.categories)
      .values({ name: "Brincos", slug: "brincos" })
      .returning({ id: schema.categories.id });
    await createPublicProduct({
      name: "Brinco Laço",
      categoryId: category.id,
      variants: [{ sku: "BL-1", priceCents: 9900, onHand: 2 }],
    });
    await createPublicProduct({
      name: "Peça Solta",
      variants: [{ sku: "PS-1", priceCents: 5900, onHand: 1 }],
    });

    await expect(getPublicProductBySlug(db, "brinco-laço")).resolves.toMatchObject({
      categoryName: "Brincos",
      categorySlug: "brincos",
    });
    await expect(getPublicProductBySlug(db, "peça-solta")).resolves.toMatchObject({
      categoryName: null,
      categorySlug: null,
    });
  });

  it("listPublicProducts deixa de fora o excludeProductId", async () => {
    const { productId } = await createPublicProduct({
      name: "Fora",
      variants: [{ sku: "F-1", priceCents: 1000, onHand: 1 }],
    });
    await createPublicProduct({
      name: "Dentro",
      variants: [{ sku: "D-1", priceCents: 1000, onHand: 1 }],
    });

    const rows = await listPublicProducts(db, { excludeProductId: productId });
    expect(rows.map((row) => row.name)).toEqual(["Dentro"]);
  });
});

describe("listRelatedPublicProducts", () => {
  async function seedCategory(name: string, slug: string): Promise<string> {
    const [category] = await db
      .insert(schema.categories)
      .values({ name, slug })
      .returning({ id: schema.categories.id });
    return category.id;
  }

  it("prefere peças da mesma categoria, sem a própria peça, respeitando o limite", async () => {
    const brincos = await seedCategory("Brincos", "brincos");
    const { productId } = await createPublicProduct({
      name: "Brinco A",
      categoryId: brincos,
      variants: [{ sku: "BA", priceCents: 1000, onHand: 1 }],
    });
    for (const name of ["Brinco B", "Brinco C", "Brinco D"]) {
      await createPublicProduct({
        name,
        categoryId: brincos,
        variants: [{ sku: name.replace(/\s/g, "-"), priceCents: 1000, onHand: 1 }],
      });
    }

    const related = await listRelatedPublicProducts(db, {
      productId,
      categorySlug: "brincos",
      limit: 2,
    });
    expect(related.scope).toBe("category");
    expect(related.items).toHaveLength(2);
    expect(related.items.map((item) => item.name)).not.toContain("Brinco A");
  });

  it("cai nas novidades da loja quando a categoria só tem a própria peça ou não existe", async () => {
    const brincos = await seedCategory("Brincos", "brincos");
    const { productId } = await createPublicProduct({
      name: "Brinco Único",
      categoryId: brincos,
      variants: [{ sku: "BU", priceCents: 1000, onHand: 1 }],
    });
    await createPublicProduct({
      name: "Bolsa Nova",
      variants: [{ sku: "BN", priceCents: 1000, onHand: 1 }],
    });
    await createPublicProduct({
      name: "Rascunho",
      status: "draft",
      variants: [{ sku: "RS", priceCents: 1000, onHand: 1 }],
    });

    const byCategory = await listRelatedPublicProducts(db, {
      productId,
      categorySlug: "brincos",
    });
    expect(byCategory.scope).toBe("latest");
    expect(byCategory.items.map((item) => item.name)).toEqual(["Bolsa Nova"]);

    const noCategory = await listRelatedPublicProducts(db, {
      productId,
      categorySlug: null,
    });
    expect(noCategory.scope).toBe("latest");
    expect(noCategory.items.map((item) => item.name)).toEqual(["Bolsa Nova"]);
  });
});

describe("publicMdUrl", () => {
  it("deriva a rendição média por convenção (-full.webp -> -md.webp)", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://x.supabase.co";
    expect(publicMdUrl("products/p1/abc-full.webp")).toBe(
      "https://x.supabase.co/storage/v1/object/public/product-images/products/p1/abc-md.webp",
    );
  });
});

describe("ficha da peça e medidas na vitrine", () => {
  it("getPublicProductBySlug expõe composição, cuidados, como veste e as medidas por variação", async () => {
    const { productId, variantIds } = await createPublicProduct({
      name: "Camisa Brisa",
      attributesSchema: ["tamanho"],
      variants: [
        { sku: "BRI-P", attributes: { tamanho: "P" }, onHand: 2, priceCents: 15900 },
        { sku: "BRI-M", attributes: { tamanho: "M" }, onHand: 2, priceCents: 15900 },
      ],
    });
    await db
      .update(schema.products)
      .set({ composition: "100% algodão", careNotes: "machine_cold", fitNotes: "Reta" })
      .where(eq(schema.products.id, productId));
    await db
      .update(schema.productVariants)
      .set({ measurements: { bust: 100, length: 70 } })
      .where(eq(schema.productVariants.id, variantIds[0]));
    await db
      .update(schema.productVariants)
      .set({ measurements: { garbage: true } })
      .where(eq(schema.productVariants.id, variantIds[1]));

    const detail = await getPublicProductBySlug(db, "camisa-brisa");
    expect(detail).toMatchObject({ composition: "100% algodão", careNotes: "machine_cold", fitNotes: "Reta" });
    const bySku = new Map(detail!.variants.map((v) => [v.sku, v.measurements]));
    expect(bySku.get("BRI-P")).toEqual({ bust: 100, length: 70 });
    // jsonb torto não derruba a página: vira null.
    expect(bySku.get("BRI-M")).toBeNull();
  });

  it("produto sem ficha devolve nulls", async () => {
    await createPublicProduct({
      name: "Lenço Mar",
      variants: [{ sku: "MAR-U", onHand: 1, priceCents: 5900 }],
    });
    const detail = await getPublicProductBySlug(db, "lenço-mar");
    expect(detail).toMatchObject({ composition: null, careNotes: null, fitNotes: null, curatorNote: null, curatorAudioPath: null, curatorAudioMime: null });
    expect(detail!.variants[0].measurements).toBeNull();
  });

  it("getPublicProductBySlug expõe a nota da curadora e o áudio (caminho e mime) para a página e a Lia", async () => {
    const { productId } = await createPublicProduct({
      name: "Longo Dunas",
      variants: [{ sku: "DUN-U", onHand: 1, priceCents: 28900 }],
    });
    await db
      .update(schema.products)
      .set({ curatorNote: "Escolhi pelo caimento no calor.", curatorAudioPath: `products/${productId}/nota-curadora-abc.webm`, curatorAudioMime: "audio/webm" })
      .where(eq(schema.products.id, productId));
    const detail = await getPublicProductBySlug(db, "longo-dunas");
    expect(detail).toMatchObject({
      curatorNote: "Escolhi pelo caimento no calor.",
      curatorAudioPath: `products/${productId}/nota-curadora-abc.webm`,
      curatorAudioMime: "audio/webm",
      publicNow: true,
    });
  });
});
