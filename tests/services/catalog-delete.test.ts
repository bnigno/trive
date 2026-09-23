// Excluir e restaurar peça: o que some, o que fica e o que volta.
// A peça não sai do banco (o ledger e o custo são append-only) — sai de vista
// por deleted_at. As fotos, essas, saem de verdade.
import { eq, inArray } from "drizzle-orm";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeFileStorage } from "@/adapters/storage/fake";
import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import {
  addProductImage,
  createProduct,
  getProductDetail,
  listProducts,
  mdPathFor,
  ServiceError,
  thumbPathFor,
  updateProduct,
} from "@/services/catalog";
import {
  deleteProduct,
  describeProductDeletion,
  restoreProduct,
} from "@/services/catalog-delete";
import { createManualOrder } from "@/services/orders";
import { listPublicProducts } from "@/services/store-catalog";
import { createStockHold } from "@/services/stock-holds";
import {
  createTestCustomer,
  createTestDb,
  FIXED_USER_ID,
  type TestDb,
} from "../helpers/db";

let db: TestDb;
let sdb: DbOrTx;
let storage: FakeFileStorage;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  sdb = db as unknown as DbOrTx;
  storage = new FakeFileStorage();
});

afterEach(async () => {
  await close();
});

async function makePng(): Promise<Buffer> {
  return sharp({
    create: { width: 10, height: 10, channels: 3, background: { r: 10, g: 20, b: 30 } },
  })
    .png()
    .toBuffer();
}

/** Peça ativa, com preço ativo e estoque — como no painel de verdade. */
async function makeSellableProduct(
  opts: { name?: string; sku?: string; onHand?: number; priceCents?: number } = {},
) {
  const { product, variants } = await createProduct(db, {
    name: opts.name ?? "Vestido Dunas",
    variants: [{ sku: opts.sku ?? "VES-DUNAS-M", attributes: {}, costCents: 4000 }],
    userId: FIXED_USER_ID,
  });
  const variantId = variants[0].id;
  await db.insert(schema.priceVersions).values({
    productVariantId: variantId,
    versionNumber: 1,
    status: "active",
    priceCents: opts.priceCents ?? 12900,
    origin: "initial",
    breakdown: {},
    costSnapshotCents: 4000,
    computedMarginRate: "0.3000",
    activatedAt: new Date(),
  });
  const onHand = opts.onHand ?? 3;
  if (onHand > 0) {
    await db
      .update(schema.stockLevels)
      .set({ onHand })
      .where(eq(schema.stockLevels.productVariantId, variantId));
    await db.insert(schema.stockMovements).values({
      productVariantId: variantId,
      type: "purchase_in",
      quantityDelta: onHand,
      referenceType: "seed",
      referenceId: product.id,
      idempotencyKey: `seed:${variantId}`,
    });
  }
  await updateProduct(db, { productId: product.id, userId: FIXED_USER_ID, status: "active" });
  return { productId: product.id, variantId };
}

async function addPhoto(productId: string): Promise<string> {
  const image = await addProductImage(db, storage, {
    productId,
    data: await makePng(),
    contentType: "image/png",
    userId: FIXED_USER_ID,
  });
  return image.storagePath;
}

describe("deleteProduct", () => {
  it("tira a peça de todas as listas e apaga as fotos do banco e do storage", async () => {
    const { productId } = await makeSellableProduct();
    const storagePath = await addPhoto(productId);
    expect(storage.list()).toHaveLength(3);

    const result = await deleteProduct(db, storage, {
      productId,
      userId: FIXED_USER_ID,
    });

    expect(result.deleted).toBe(true);
    expect(result.filesFailed).toEqual([]);

    // Sumiu de tudo o que o dono e a cliente enxergam.
    expect(await listProducts(db, {})).toHaveLength(0);
    expect(await listPublicProducts(db, {})).toHaveLength(0);
    await expect(getProductDetail(db, productId)).rejects.toThrow(ServiceError);

    // As fotos saíram das duas pontas: linha e arquivo (3 rendições).
    const images = await db
      .select()
      .from(schema.productImages)
      .where(eq(schema.productImages.productId, productId));
    expect(images).toHaveLength(0);
    expect(storage.list()).toEqual([]);
    expect(storage.has(storagePath)).toBe(false);
    expect(storage.has(mdPathFor(storagePath))).toBe(false);
    expect(storage.has(thumbPathFor(storagePath))).toBe(false);

    // A linha continua no banco — é ela que segura o histórico.
    const [row] = await db
      .select()
      .from(schema.products)
      .where(eq(schema.products.id, productId));
    expect(row.deletedAt).not.toBeNull();
    // A variação some junto; status e is_active ficam como estavam.
    const [variant] = await db
      .select()
      .from(schema.productVariants)
      .where(eq(schema.productVariants.productId, productId));
    expect(variant.deletedAt).not.toBeNull();
    expect(variant.isActive).toBe(true);
    expect(row.status).toBe("active");
  });

  it("aparece na lista de excluídas, com a data, e some das outras", async () => {
    const { productId } = await makeSellableProduct({ name: "Saia Maré", sku: "SAI-MARE" });
    await deleteProduct(db, storage, { productId, userId: FIXED_USER_ID });

    const deleted = await listProducts(db, { deleted: true });
    expect(deleted).toHaveLength(1);
    expect(deleted[0].name).toBe("Saia Maré");
    expect(deleted[0].deletedAt).toBeInstanceOf(Date);
    // A variação excluída ainda conta na lista das excluídas (é como o dono
    // reconhece a peça); nas listas normais, nada.
    expect(deleted[0].variantCount).toBe(1);
    expect(await listProducts(db, { status: "active" })).toHaveLength(0);
    expect(await listProducts(db, { search: "SAI-MARE" })).toHaveLength(0);
    expect(await listProducts(db, { search: "SAI-MARE", deleted: true })).toHaveLength(1);
  });

  it("solta os vínculos que não filtram sozinhos e libera a reserva gentil", async () => {
    const { productId, variantId } = await makeSellableProduct();
    const customerId = await createTestCustomer(db);

    const [drop] = await db
      .insert(schema.drops)
      .values({ name: "Primavera", publishAt: new Date() })
      .returning({ id: schema.drops.id });
    await db.insert(schema.dropProducts).values({ dropId: drop.id, productId });

    const [edition] = await db
      .insert(schema.cityEditions)
      .values({ name: "Belém", slug: "belem" })
      .returning({ id: schema.cityEditions.id });
    await db
      .insert(schema.cityEditionProducts)
      .values({ cityEditionId: edition.id, productId });

    const [link] = await db
      .insert(schema.campaignLinks)
      .values({ slug: "dunas", label: "Dunas no story", productId })
      .returning({ id: schema.campaignLinks.id });

    await db.insert(schema.stockAlerts).values({
      productVariantId: variantId,
      phoneE164: "+5591999990000",
      source: "lia",
    });

    await createStockHold(sdb, {
      variantId,
      phoneE164: "+5591988887777",
      customerId,
      quantity: 1,
    });
    const [reservedBefore] = await db
      .select()
      .from(schema.stockLevels)
      .where(eq(schema.stockLevels.productVariantId, variantId));
    expect(reservedBefore.reserved).toBe(1);

    await deleteProduct(db, storage, { productId, userId: FIXED_USER_ID });

    expect(
      await db.select().from(schema.dropProducts).where(eq(schema.dropProducts.productId, productId)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(schema.cityEditionProducts)
        .where(eq(schema.cityEditionProducts.productId, productId)),
    ).toHaveLength(0);
    const [linkRow] = await db
      .select()
      .from(schema.campaignLinks)
      .where(eq(schema.campaignLinks.id, link.id));
    expect(linkRow.productId).toBeNull();
    expect(
      await db
        .select()
        .from(schema.stockAlerts)
        .where(eq(schema.stockAlerts.productVariantId, variantId)),
    ).toHaveLength(0);

    // A reserva gentil foi liberada: o saldo reservado não fica preso.
    const [hold] = await db.select().from(schema.stockHolds);
    expect(hold.status).toBe("released");
    const [level] = await db
      .select()
      .from(schema.stockLevels)
      .where(eq(schema.stockLevels.productVariantId, variantId));
    expect(level.reserved).toBe(0);
  });

  it("o pedido antigo continua inteiro: snapshots não dependem da peça", async () => {
    const { productId, variantId } = await makeSellableProduct();
    const customerId = await createTestCustomer(db);
    const order = await createManualOrder(sdb, {
      customerId,
      items: [{ variantId, quantity: 1 }],
      userId: FIXED_USER_ID,
    });

    await deleteProduct(db, storage, { productId, userId: FIXED_USER_ID });

    const items = await db
      .select()
      .from(schema.orderItems)
      .where(eq(schema.orderItems.orderId, order.orderId));
    expect(items).toHaveLength(1);
    expect(items[0].skuSnapshot).toBe("VES-DUNAS-M");
    expect(items[0].nameSnapshot).toBe("Vestido Dunas");
  });

  it("o banco fica certo mesmo quando o storage recusa apagar (melhor esforço)", async () => {
    class FlakyStorage extends FakeFileStorage {
      override async remove(path: string): Promise<void> {
        throw new Error(`storage indisponível (${path})`);
      }
    }
    const { productId } = await makeSellableProduct();
    await addPhoto(productId);
    const flaky = new FlakyStorage();

    const result = await deleteProduct(db, flaky, { productId, userId: FIXED_USER_ID });

    expect(result.deleted).toBe(true);
    expect(result.filesFailed).toHaveLength(3);
    // A peça saiu do ar mesmo assim: o que falhou foi só o arquivo.
    expect(await listProducts(db, {})).toHaveLength(0);
    expect(
      await db
        .select()
        .from(schema.productImages)
        .where(eq(schema.productImages.productId, productId)),
    ).toHaveLength(0);
  });

  it("excluir de novo não quebra nada", async () => {
    const { productId } = await makeSellableProduct();
    await deleteProduct(db, storage, { productId, userId: FIXED_USER_ID });

    const second = await deleteProduct(db, storage, { productId, userId: FIXED_USER_ID });
    expect(second.deleted).toBe(false);
    expect(await listProducts(db, { deleted: true })).toHaveLength(1);
  });

  it("registra na auditoria o que foi excluído", async () => {
    const { productId } = await makeSellableProduct();
    const storagePath = await addPhoto(productId);

    await deleteProduct(db, storage, { productId, userId: FIXED_USER_ID });

    const [entry] = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "product.delete"));
    expect(entry.entityId).toBe(productId);
    const before = entry.before as Record<string, unknown>;
    expect(before.name).toBe("Vestido Dunas");
    expect(before.skus).toEqual(["VES-DUNAS-M"]);
    expect(before.photoPaths).toEqual([storagePath]);
    const after = entry.after as Record<string, unknown>;
    expect(after.photosRemoved).toBe(1);
  });

  it("devolve o endereço e o código quando a peça nunca foi vendida", async () => {
    const { productId } = await makeSellableProduct({
      name: "Blusa Sol",
      sku: "BLU-SOL",
    });
    await deleteProduct(db, storage, { productId, userId: FIXED_USER_ID });

    // É o caso que motivou tudo: cadastrei errado, excluí e recadastrei igual.
    const again = await createProduct(db, {
      name: "Blusa Sol",
      variants: [{ sku: "BLU-SOL", attributes: {}, costCents: 4000 }],
      userId: FIXED_USER_ID,
    });
    expect(again.product.slug).toBe("blusa-sol");
    expect(again.variants[0].sku).toBe("BLU-SOL");
  });
});

describe("describeProductDeletion", () => {
  it("conta fotos, vendas, estoque, reservas e avisos para o aviso da tela", async () => {
    const { productId, variantId } = await makeSellableProduct({ onHand: 4 });
    await addPhoto(productId);
    await addPhoto(productId);
    const customerId = await createTestCustomer(db);
    await createManualOrder(sdb, {
      customerId,
      items: [{ variantId, quantity: 2 }],
      userId: FIXED_USER_ID,
    });
    await db.insert(schema.stockAlerts).values({
      productVariantId: variantId,
      phoneE164: "+5591999990000",
      source: "lia",
    });
    const [drop] = await db
      .insert(schema.drops)
      .values({ name: "Primavera", publishAt: new Date() })
      .returning({ id: schema.drops.id });
    await db.insert(schema.dropProducts).values({ dropId: drop.id, productId });

    const summary = await describeProductDeletion(db, productId);

    expect(summary.name).toBe("Vestido Dunas");
    expect(summary.skus).toEqual(["VES-DUNAS-M"]);
    expect(summary.photoCount).toBe(2);
    expect(summary.soldCount).toBe(2);
    // Rascunho é pedido em andamento: o dono precisa saber.
    expect(summary.openOrderCount).toBe(1);
    expect(summary.onHand).toBe(4);
    expect(summary.waitingAlerts).toBe(1);
    expect(summary.linkedTo).toContain("o lançamento «Primavera»");
  });

  it("peça nova e limpa não assusta com número nenhum", async () => {
    const { productId } = await makeSellableProduct({ onHand: 0 });

    const summary = await describeProductDeletion(db, productId);

    expect(summary.photoCount).toBe(0);
    expect(summary.soldCount).toBe(0);
    expect(summary.openOrderCount).toBe(0);
    expect(summary.onHand).toBe(0);
    expect(summary.activeHolds).toBe(0);
    expect(summary.waitingAlerts).toBe(0);
    expect(summary.linkedTo).toEqual([]);
  });

  it("recusa peça que não existe (ou já excluída)", async () => {
    const { productId } = await makeSellableProduct();
    await deleteProduct(db, storage, { productId, userId: FIXED_USER_ID });
    await expect(describeProductDeletion(db, productId)).rejects.toThrow(ServiceError);
  });
});

describe("restoreProduct", () => {
  it("traz a peça de volta como rascunho, sem as fotos", async () => {
    const { productId } = await makeSellableProduct();
    await addPhoto(productId);
    await deleteProduct(db, storage, { productId, userId: FIXED_USER_ID });

    const result = await restoreProduct(db, { productId, userId: FIXED_USER_ID });

    expect(result.restored).toBe(true);
    const detail = await getProductDetail(db, productId);
    expect(detail.status).toBe("draft");
    expect(detail.images).toHaveLength(0);
    expect(detail.variants).toHaveLength(1);
    // Fora da vitrine: rascunho não é peça pública.
    expect(await listPublicProducts(db, {})).toHaveLength(0);
    expect(await listProducts(db, {})).toHaveLength(1);
    expect(await listProducts(db, { deleted: true })).toHaveLength(0);

    const [entry] = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "product.restore"));
    expect(entry.entityId).toBe(productId);
  });

  it("explica quando o código já está com outra peça", async () => {
    const { productId } = await makeSellableProduct({ name: "Blusa Sol", sku: "BLU-SOL" });
    await deleteProduct(db, storage, { productId, userId: FIXED_USER_ID });
    await createProduct(db, {
      name: "Blusa Sol nova",
      variants: [{ sku: "BLU-SOL", attributes: {}, costCents: 4000 }],
      userId: FIXED_USER_ID,
    });

    await expect(
      restoreProduct(db, { productId, userId: FIXED_USER_ID }),
    ).rejects.toThrow(/BLU-SOL/);
    // Nada mudou: a peça continua excluída.
    expect(await listProducts(db, { deleted: true })).toHaveLength(1);
  });

  it("explica quando o endereço da loja já está com outra peça", async () => {
    const { productId } = await makeSellableProduct({ name: "Saia Maré", sku: "SAI-MARE" });
    await deleteProduct(db, storage, { productId, userId: FIXED_USER_ID });
    await createProduct(db, {
      name: "Saia Maré",
      variants: [{ sku: "SAI-MARE-2", attributes: {}, costCents: 4000 }],
      userId: FIXED_USER_ID,
    });

    await expect(
      restoreProduct(db, { productId, userId: FIXED_USER_ID }),
    ).rejects.toThrow(ServiceError);
  });

  it("restaurar peça que nunca foi excluída não faz nada", async () => {
    const { productId } = await makeSellableProduct();
    const result = await restoreProduct(db, { productId, userId: FIXED_USER_ID });
    expect(result.restored).toBe(false);
  });
});

describe("estoque e preço da peça excluída", () => {
  it("some do painel de estoque sem apagar o livro razão", async () => {
    const { productId, variantId } = await makeSellableProduct({ onHand: 5 });
    const movimentosAntes = await db
      .select()
      .from(schema.stockMovements)
      .where(eq(schema.stockMovements.productVariantId, variantId));

    await deleteProduct(db, storage, { productId, userId: FIXED_USER_ID });

    const movimentosDepois = await db
      .select()
      .from(schema.stockMovements)
      .where(eq(schema.stockMovements.productVariantId, variantId));
    expect(movimentosDepois).toHaveLength(movimentosAntes.length);
    // O preço também continua: é dele que vivem os relatórios antigos.
    expect(
      await db
        .select()
        .from(schema.priceVersions)
        .where(inArray(schema.priceVersions.productVariantId, [variantId])),
    ).toHaveLength(1);
  });
});
