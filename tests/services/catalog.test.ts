import { count, eq, inArray } from "drizzle-orm";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeFileStorage } from "@/adapters/storage/fake";
import * as schema from "@/db/schema";
import {
  addProductImage,
  addVariant,
  createCategory,
  createProduct,
  getProductDetail,
  listProducts,
  removeProductImage,
  ServiceError,
  setProductImageColor,
  thumbPathFor,
  updateProduct,
} from "@/services/catalog";
import {
  createTestDb,
  createTestSupplier,
  FIXED_USER_ID,
  type TestDb,
} from "../helpers/db";

let db: TestDb;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
});

afterEach(async () => {
  await close();
});

async function makePng(): Promise<Buffer> {
  return sharp({
    create: {
      width: 10,
      height: 10,
      channels: 3,
      background: { r: 200, g: 30, b: 90 },
    },
  })
    .png()
    .toBuffer();
}

describe("createProduct", () => {
  it("creates product with 2 variants and 2 zeroed stock levels", async () => {
    const { product, variants } = await createProduct(db, {
      name: "Colar Lua",
      brand: "TRIVË",
      variants: [
        { sku: "COL-LUA-PRATA", attributes: { cor: "prata" }, costCents: 1500 },
        { sku: "COL-LUA-DOURADO", attributes: { cor: "dourado" } },
      ],
      attributesSchema: ["cor"],
      userId: FIXED_USER_ID,
    });

    expect(product.slug).toBe("colar-lua");
    expect(variants).toHaveLength(2);

    const levels = await db
      .select()
      .from(schema.stockLevels)
      .where(
        inArray(
          schema.stockLevels.productVariantId,
          variants.map((variant) => variant.id),
        ),
      );
    expect(levels).toHaveLength(2);
    for (const level of levels) {
      expect(level.onHand).toBe(0);
      expect(level.reserved).toBe(0);
    }

    // Custo inicial registrado no ledger append-only apenas para quem informou.
    const costs = await db
      .select()
      .from(schema.variantCosts)
      .where(
        inArray(
          schema.variantCosts.productVariantId,
          variants.map((variant) => variant.id),
        ),
      );
    expect(costs).toHaveLength(1);
    expect(costs[0].costCents).toBe(1500);

    const audits = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "product.create"));
    expect(audits).toHaveLength(1);
    expect(audits[0].entityId).toBe(product.id);
  });

  it("adds -2 suffix when slug collides", async () => {
    const first = await createProduct(db, {
      name: "Anel Sol",
      variants: [{ sku: "ANEL-SOL-1" }],
      userId: FIXED_USER_ID,
    });
    const second = await createProduct(db, {
      name: "Anel Sol",
      variants: [{ sku: "ANEL-SOL-2" }],
      userId: FIXED_USER_ID,
    });
    const third = await createProduct(db, {
      name: "Anel Sol",
      variants: [{ sku: "ANEL-SOL-3" }],
      userId: FIXED_USER_ID,
    });

    expect(first.product.slug).toBe("anel-sol");
    expect(second.product.slug).toBe("anel-sol-2");
    expect(third.product.slug).toBe("anel-sol-3");
  });

  it("rejects duplicated SKU with a friendly message", async () => {
    await createProduct(db, {
      name: "Brinco Estrela",
      variants: [{ sku: "BRI-EST" }],
      userId: FIXED_USER_ID,
    });

    await expect(
      createProduct(db, {
        name: "Outro Produto",
        variants: [{ sku: "BRI-EST" }],
        userId: FIXED_USER_ID,
      }),
    ).rejects.toThrow("Já existe uma variação com este SKU.");

    // A transação inteira reverte: o produto que falhou não fica pela metade.
    const [{ value: total }] = await db
      .select({ value: count() })
      .from(schema.products);
    expect(Number(total)).toBe(1);
  });

  it("rejects duplicated SKU within the same payload", async () => {
    await expect(
      createProduct(db, {
        name: "Pulseira",
        variants: [{ sku: "PUL-1" }, { sku: "PUL-1" }],
        userId: FIXED_USER_ID,
      }),
    ).rejects.toThrow(ServiceError);
  });

  it("rejects attributes that only differ in case (normalized before the check)", async () => {
    await expect(
      createProduct(db, {
        name: "Camisa Linho",
        attributesSchema: ["cor"],
        variants: [
          { sku: "CAM-LIN-VERDE", attributes: { cor: "verde" } },
          { sku: "CAM-LIN-VERDE-2", attributes: { cor: "  Verde " } },
        ],
        userId: FIXED_USER_ID,
      }),
    ).rejects.toThrow("Há variações com os mesmos atributos no cadastro.");
  });
});

describe("createProduct com grade cor × tamanho", () => {
  // 3 cores × 3 tamanhos, mas só 6 combinações realmente existem na loja.
  const GRID = [
    { cor: "verde", tamanho: "p", quantity: 3 },
    { cor: "verde", tamanho: "g", quantity: 2 },
    { cor: "amarelo", tamanho: "m", quantity: 1 },
    { cor: "amarelo", tamanho: "g", quantity: 1 },
    { cor: "azul", tamanho: "p", quantity: 2 },
    { cor: "azul", tamanho: "m", quantity: 1 },
  ];

  async function createPolo() {
    return createProduct(db, {
      name: "Polo Piquê",
      attributesSchema: ["cor", "tamanho"],
      variants: GRID.map((cell) => ({
        sku: `POLO-${cell.cor.toUpperCase()}-${cell.tamanho.toUpperCase()}`,
        attributes: { cor: cell.cor, tamanho: cell.tamanho },
        costCents: 4000,
        initialQuantity: cell.quantity,
        priceCents: 8990,
      })),
      userId: FIXED_USER_ID,
    });
  }

  it("creates only the 6 informed combinations, never the full 3×3 grid", async () => {
    const { product, variants } = await createPolo();
    expect(variants).toHaveLength(6);

    const detail = await getProductDetail(db, product.id);
    expect(detail.variants).toHaveLength(6);
    // Valores normalizados: "verde" → "Verde", "p" → "P" (sigla de tamanho).
    const cells = detail.variants
      .map((variant) => `${variant.attributes.cor}/${variant.attributes.tamanho}`)
      .sort();
    expect(cells).toEqual([
      "Amarelo/G",
      "Amarelo/M",
      "Azul/M",
      "Azul/P",
      "Verde/G",
      "Verde/P",
    ]);
  });

  it("records the exact on_hand of each cell and the matching ledger movements", async () => {
    const { variants } = await createPolo();
    const idBySku = new Map(variants.map((v) => [v.sku, v.id]));

    const levels = await db
      .select()
      .from(schema.stockLevels)
      .where(
        inArray(
          schema.stockLevels.productVariantId,
          variants.map((variant) => variant.id),
        ),
      );
    expect(levels).toHaveLength(6);
    const onHandById = new Map(
      levels.map((level) => [level.productVariantId, level.onHand]),
    );
    for (const cell of GRID) {
      const sku = `POLO-${cell.cor.toUpperCase()}-${cell.tamanho.toUpperCase()}`;
      expect(onHandById.get(idBySku.get(sku)!)).toBe(cell.quantity);
    }

    const movements = await db
      .select()
      .from(schema.stockMovements)
      .where(
        inArray(
          schema.stockMovements.productVariantId,
          variants.map((variant) => variant.id),
        ),
      );
    expect(movements).toHaveLength(6);
    const deltaById = new Map(
      movements.map((movement) => [
        movement.productVariantId,
        movement.quantityDelta,
      ]),
    );
    for (const cell of GRID) {
      const sku = `POLO-${cell.cor.toUpperCase()}-${cell.tamanho.toUpperCase()}`;
      expect(deltaById.get(idBySku.get(sku)!)).toBe(cell.quantity);
    }
    for (const movement of movements) {
      expect(movement.type).toBe("purchase_in");
      expect(movement.idempotencyKey).toBe(
        `purchase_in:${movement.referenceId}:${movement.productVariantId}`,
      );
    }
  });

  it("activates one price version per variant", async () => {
    const { variants } = await createPolo();

    const prices = await db
      .select()
      .from(schema.priceVersions)
      .where(
        inArray(
          schema.priceVersions.productVariantId,
          variants.map((variant) => variant.id),
        ),
      );
    expect(prices).toHaveLength(6);
    for (const price of prices) {
      expect(price.status).toBe("active");
      expect(price.priceCents).toBe(8990);
      expect(price.versionNumber).toBe(1);
      expect(price.origin).toBe("initial");
      expect(price.costSnapshotCents).toBe(4000);
      // (8990 − 4000) ÷ 8990 = 0,5551 — inverso da calculadora de preços.
      expect(Number(price.computedMarginRate)).toBeCloseTo(0.5551, 4);
      expect(price.activatedAt).not.toBeNull();
    }
  });

  it("creates no movement when the quantity is zero or absent", async () => {
    const { variants } = await createProduct(db, {
      name: "Polo Sem Estoque",
      attributesSchema: ["cor"],
      variants: [
        { sku: "POLO-SEM-1", attributes: { cor: "verde" }, initialQuantity: 0 },
        { sku: "POLO-SEM-2", attributes: { cor: "azul" } },
      ],
      userId: FIXED_USER_ID,
    });

    const movements = await db
      .select()
      .from(schema.stockMovements)
      .where(
        inArray(
          schema.stockMovements.productVariantId,
          variants.map((variant) => variant.id),
        ),
      );
    expect(movements).toHaveLength(0);

    const levels = await db
      .select()
      .from(schema.stockLevels)
      .where(
        inArray(
          schema.stockLevels.productVariantId,
          variants.map((variant) => variant.id),
        ),
      );
    expect(levels.map((level) => level.onHand)).toEqual([0, 0]);
  });

  it("lets the database UNIQUE (product_id, attributes) reject a repeated cell", async () => {
    const { product } = await createPolo();

    // Sem pré-checagem em memória neste caminho: quem recusa é o UNIQUE do
    // banco — e o jsonb compara igual mesmo com as chaves em outra ordem.
    await expect(
      addVariant(db, {
        productId: product.id,
        sku: "POLO-VERDE-P-BIS",
        attributes: { tamanho: "P", cor: "Verde" },
        userId: FIXED_USER_ID,
      }),
    ).rejects.toThrow(
      "Já existe uma variação deste produto com os mesmos atributos.",
    );

    const [{ value: total }] = await db
      .select({ value: count() })
      .from(schema.productVariants);
    expect(Number(total)).toBe(6);
  });
});

describe("createCategory", () => {
  it("slugifies with accents and suffixes on collision", async () => {
    const first = await createCategory(db, {
      name: "Coleções",
      userId: FIXED_USER_ID,
    });
    const second = await createCategory(db, {
      name: "Coleções",
      userId: FIXED_USER_ID,
    });
    expect(first.slug).toBe("colecoes");
    expect(second.slug).toBe("colecoes-2");
  });
});

describe("addVariant / updateProduct", () => {
  it("adds a variant with its own zeroed stock level", async () => {
    const { product } = await createProduct(db, {
      name: "Colar Mar",
      variants: [{ sku: "COL-MAR-P", attributes: { tamanho: "P" } }],
      userId: FIXED_USER_ID,
    });

    const variant = await addVariant(db, {
      productId: product.id,
      sku: "COL-MAR-M",
      attributes: { tamanho: "M" },
      userId: FIXED_USER_ID,
    });

    const [level] = await db
      .select()
      .from(schema.stockLevels)
      .where(eq(schema.stockLevels.productVariantId, variant.id));
    expect(level.onHand).toBe(0);
  });

  it("sets and clears the product supplier (nullable)", async () => {
    const supplierId = await createTestSupplier(db, {
      name: "Fornecedor do Produto",
    });
    const { product } = await createProduct(db, {
      name: "Brinco Lua",
      variants: [{ sku: "BRI-LUA" }],
      userId: FIXED_USER_ID,
    });
    expect(product.supplierId).toBeNull();

    const linked = await updateProduct(db, {
      productId: product.id,
      supplierId,
      userId: FIXED_USER_ID,
    });
    expect(linked.supplierId).toBe(supplierId);

    const cleared = await updateProduct(db, {
      productId: product.id,
      supplierId: null,
      userId: FIXED_USER_ID,
    });
    expect(cleared.supplierId).toBeNull();
  });

  it("archives a product keeping the row (snapshots preserved)", async () => {
    const { product } = await createProduct(db, {
      name: "Tornozeleira",
      variants: [{ sku: "TOR-1" }],
      userId: FIXED_USER_ID,
    });

    const updated = await updateProduct(db, {
      productId: product.id,
      status: "archived",
      userId: FIXED_USER_ID,
    });
    expect(updated.status).toBe("archived");

    const [row] = await db
      .select()
      .from(schema.products)
      .where(eq(schema.products.id, product.id));
    expect(row).toBeDefined();
    expect(row.deletedAt).toBe(null);
  });
});

describe("listProducts / getProductDetail", () => {
  it("returns variant count, active price range and stock", async () => {
    const { product, variants } = await createProduct(db, {
      name: "Colar Sol",
      variants: [
        { sku: "COL-SOL-P", attributes: { tamanho: "P" }, costCents: 1200 },
        { sku: "COL-SOL-M", attributes: { tamanho: "M" }, costCents: 1300 },
      ],
      userId: FIXED_USER_ID,
    });

    await db.insert(schema.priceVersions).values({
      productVariantId: variants[0].id,
      versionNumber: 1,
      status: "active",
      priceCents: 9990,
      origin: "initial",
      breakdown: {},
      costSnapshotCents: 1200,
      computedMarginRate: "0.3000",
    });

    const list = await listProducts(db, { search: "Colar Sol" });
    expect(list).toHaveLength(1);
    expect(list[0].variantCount).toBe(2);
    expect(list[0].minActivePriceCents).toBe(9990);
    expect(list[0].maxActivePriceCents).toBe(9990);
    expect(list[0].totalOnHand).toBe(0);

    const detail = await getProductDetail(db, product.id);
    expect(detail.variants).toHaveLength(2);
    const priced = detail.variants.find((v) => v.sku === "COL-SOL-P");
    const unpriced = detail.variants.find((v) => v.sku === "COL-SOL-M");
    expect(priced?.activePriceCents).toBe(9990);
    expect(priced?.costCents).toBe(1200);
    expect(priced?.onHand).toBe(0);
    expect(unpriced?.activePriceCents).toBe(null);
  });

  it("finds products by variant SKU", async () => {
    await createProduct(db, {
      name: "Pingente Lua",
      variants: [{ sku: "PIN-LUA-77" }],
      userId: FIXED_USER_ID,
    });
    const bySku = await listProducts(db, { search: "PIN-LUA-77" });
    expect(bySku).toHaveLength(1);
    expect(bySku[0].name).toBe("Pingente Lua");
  });
});

describe("addProductImage / removeProductImage", () => {
  it("stores -full and -thumb webp files and creates the row", async () => {
    const storage = new FakeFileStorage();
    const { product } = await createProduct(db, {
      name: "Colar Vento",
      variants: [{ sku: "COL-VEN" }],
      userId: FIXED_USER_ID,
    });

    const image = await addProductImage(db, storage, {
      productId: product.id,
      data: await makePng(),
      contentType: "image/png",
      altText: "Colar Vento em fundo neutro",
      userId: FIXED_USER_ID,
    });

    const paths = storage.list();
    expect(paths).toHaveLength(2);
    const fullPath = paths.find((p) => p.endsWith("-full.webp"));
    const thumbPath = paths.find((p) => p.endsWith("-thumb.webp"));
    expect(fullPath).toBeDefined();
    expect(thumbPath).toBeDefined();
    expect(fullPath).toMatch(new RegExp(`^products/${product.id}/`));
    expect(thumbPathFor(fullPath!)).toBe(thumbPath);

    // Conteúdo realmente convertido para webp, sem upscale (fonte 10px).
    const stored = storage.get(fullPath!);
    expect(stored?.contentType).toBe("image/webp");
    const metadata = await sharp(Buffer.from(stored!.data)).metadata();
    expect(metadata.format).toBe("webp");
    expect(metadata.width).toBe(10);

    const rows = await db
      .select()
      .from(schema.productImages)
      .where(eq(schema.productImages.productId, product.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].storagePath).toBe(fullPath);
    expect(image.fullUrl).toBe(`memory://${fullPath}`);
    expect(image.thumbUrl).toBe(`memory://${thumbPath}`);
  });

  it("rejects non-image payloads with a friendly error", async () => {
    const storage = new FakeFileStorage();
    const { product } = await createProduct(db, {
      name: "Colar Chuva",
      variants: [{ sku: "COL-CHU" }],
      userId: FIXED_USER_ID,
    });

    await expect(
      addProductImage(db, storage, {
        productId: product.id,
        data: Buffer.from("isto não é uma imagem"),
        contentType: "image/png",
        userId: FIXED_USER_ID,
      }),
    ).rejects.toThrow("Não foi possível processar a imagem");
    expect(storage.list()).toHaveLength(0);
  });

  it("stores the normalized color and returns it in getProductDetail", async () => {
    const storage = new FakeFileStorage();
    const { product } = await createProduct(db, {
      name: "Polo Cor",
      attributesSchema: ["cor", "tamanho"],
      variants: [
        { sku: "POLO-COR-VE-P", attributes: { cor: "verde", tamanho: "p" } },
        { sku: "POLO-COR-AZ-M", attributes: { cor: "azul", tamanho: "m" } },
      ],
      userId: FIXED_USER_ID,
    });

    const image = await addProductImage(db, storage, {
      productId: product.id,
      data: await makePng(),
      contentType: "image/png",
      color: "  verde ",
      userId: FIXED_USER_ID,
    });
    expect(image.color).toBe("Verde");

    const detail = await getProductDetail(db, product.id);
    expect(detail.images).toHaveLength(1);
    expect(detail.images[0].color).toBe("Verde");
  });

  it("returns color null for a photo of the whole product in getProductDetail", async () => {
    const storage = new FakeFileStorage();
    const { product } = await createProduct(db, {
      name: "Polo Sem Cor",
      attributesSchema: ["cor", "tamanho"],
      variants: [
        { sku: "POLO-SC-VE-P", attributes: { cor: "verde", tamanho: "p" } },
      ],
      userId: FIXED_USER_ID,
    });

    const image = await addProductImage(db, storage, {
      productId: product.id,
      data: await makePng(),
      contentType: "image/png",
      userId: FIXED_USER_ID,
    });
    expect(image.color).toBe(null);

    const detail = await getProductDetail(db, product.id);
    expect(detail.images).toHaveLength(1);
    expect(detail.images[0].color).toBe(null);
    expect(detail.images[0].storagePath).toBe(image.storagePath);
  });

  it("rejects a color no variant has, without leaving files behind", async () => {
    const storage = new FakeFileStorage();
    const { product } = await createProduct(db, {
      name: "Polo Cor Errada",
      attributesSchema: ["cor", "tamanho"],
      variants: [
        { sku: "POLO-ERR-VE-P", attributes: { cor: "verde", tamanho: "p" } },
      ],
      userId: FIXED_USER_ID,
    });

    await expect(
      addProductImage(db, storage, {
        productId: product.id,
        data: await makePng(),
        contentType: "image/png",
        color: "vermelho",
        userId: FIXED_USER_ID,
      }),
    ).rejects.toThrow('Nenhuma variação deste produto tem a cor "Vermelho".');

    expect(storage.list()).toHaveLength(0);
    const rows = await db
      .select()
      .from(schema.productImages)
      .where(eq(schema.productImages.productId, product.id));
    expect(rows).toHaveLength(0);
  });

  it("keeps the color free when the product has no color axis", async () => {
    const storage = new FakeFileStorage();
    const { product } = await createProduct(db, {
      name: "Colar Sem Eixo",
      variants: [{ sku: "COL-SEM-EIXO" }],
      userId: FIXED_USER_ID,
    });

    const image = await addProductImage(db, storage, {
      productId: product.id,
      data: await makePng(),
      contentType: "image/png",
      color: "dourado",
      userId: FIXED_USER_ID,
    });
    expect(image.color).toBe("Dourado");
  });

  it("removes the row and both files from storage", async () => {
    const storage = new FakeFileStorage();
    const { product } = await createProduct(db, {
      name: "Colar Rio",
      variants: [{ sku: "COL-RIO" }],
      userId: FIXED_USER_ID,
    });
    const image = await addProductImage(db, storage, {
      productId: product.id,
      data: await makePng(),
      contentType: "image/png",
      userId: FIXED_USER_ID,
    });
    expect(storage.list()).toHaveLength(2);

    await removeProductImage(db, storage, {
      imageId: image.id,
      userId: FIXED_USER_ID,
    });

    expect(storage.list()).toHaveLength(0);
    const rows = await db
      .select()
      .from(schema.productImages)
      .where(eq(schema.productImages.productId, product.id));
    expect(rows).toHaveLength(0);
  });
});

describe("setProductImageColor", () => {
  async function productWithPhoto(storage: FakeFileStorage) {
    const { product } = await createProduct(db, {
      name: "Blusa Reetiqueta",
      attributesSchema: ["cor", "tamanho"],
      variants: [
        { sku: "BLU-RE-VE-P", attributes: { cor: "verde", tamanho: "p" } },
        { sku: "BLU-RE-AZ-P", attributes: { cor: "azul", tamanho: "p" } },
      ],
      userId: FIXED_USER_ID,
    });
    const image = await addProductImage(db, storage, {
      productId: product.id,
      data: await makePng(),
      contentType: "image/png",
      userId: FIXED_USER_ID,
    });
    return { product, image };
  }

  it("tags a photo of the whole product with a color, normalized, with audit", async () => {
    const storage = new FakeFileStorage();
    const { product, image } = await productWithPhoto(storage);
    expect(image.color).toBe(null);

    const updated = await setProductImageColor(db, {
      imageId: image.id,
      color: "  verde ",
      userId: FIXED_USER_ID,
    });
    expect(updated.color).toBe("Verde");

    const detail = await getProductDetail(db, product.id);
    expect(detail.images[0].color).toBe("Verde");

    const audits = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "product_image.set_color"));
    expect(audits).toHaveLength(1);
    expect(audits[0].entityId).toBe(image.id);
    expect(audits[0].before).toEqual({ color: null });
    expect(audits[0].after).toEqual({ color: "Verde" });
  });

  it("clears the color back to a photo of the whole product", async () => {
    const storage = new FakeFileStorage();
    const { product, image } = await productWithPhoto(storage);
    await setProductImageColor(db, {
      imageId: image.id,
      color: "azul",
      userId: FIXED_USER_ID,
    });

    const cleared = await setProductImageColor(db, {
      imageId: image.id,
      color: null,
      userId: FIXED_USER_ID,
    });
    expect(cleared.color).toBe(null);

    const detail = await getProductDetail(db, product.id);
    expect(detail.images[0].color).toBe(null);
  });

  it("rejects a color no variant has and keeps the photo as it was", async () => {
    const storage = new FakeFileStorage();
    const { product, image } = await productWithPhoto(storage);

    await expect(
      setProductImageColor(db, {
        imageId: image.id,
        color: "vermelho",
        userId: FIXED_USER_ID,
      }),
    ).rejects.toThrow('Nenhuma variação deste produto tem a cor "Vermelho".');

    const detail = await getProductDetail(db, product.id);
    expect(detail.images[0].color).toBe(null);
  });

  it("does not write an audit entry when the color did not change", async () => {
    const storage = new FakeFileStorage();
    const { image } = await productWithPhoto(storage);

    await setProductImageColor(db, {
      imageId: image.id,
      color: null,
      userId: FIXED_USER_ID,
    });

    const audits = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "product_image.set_color"));
    expect(audits).toHaveLength(0);
  });

  it("fails with a friendly message for an unknown photo", async () => {
    await expect(
      setProductImageColor(db, {
        imageId: "00000000-0000-4000-8000-000000000000",
        color: "verde",
        userId: FIXED_USER_ID,
      }),
    ).rejects.toThrow("Imagem não encontrada.");
  });
});
