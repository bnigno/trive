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
  thumbPathFor,
  updateProduct,
} from "@/services/catalog";
import { createTestDb, FIXED_USER_ID, type TestDb } from "../helpers/db";

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
