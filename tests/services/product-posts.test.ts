// O post da peça: desenha post e story uma vez (cache na segunda), monta a
// legenda com o que a peça tem e recusa peça sem foto ou sem preço.
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

import { FakeFileStorage } from "@/adapters/storage/fake";
import type { CardData } from "@/core/cards/types";
import * as schema from "@/db/schema";
import { formatCentsBRL } from "@/lib/money";
import type { DbOrTx } from "@/queue/enqueue";
import {
  getProductPostFile,
  getProductPostPreview,
  prerenderProductPosts,
  publishProductPost,
} from "@/services/product-posts";
import { ServiceError } from "@/services/settings";
import { createTestDb, createTestVariant, FIXED_USER_ID, type TestDb } from "../helpers/db";

let db: TestDb;
let sdb: DbOrTx;
let close: () => Promise<void>;
let storage: FakeFileStorage;

const render = vi.fn(async (data: CardData) => {
  const { width, height } =
    data.kind === "story" ? { width: 108, height: 192 } : { width: 108, height: 135 };
  return sharp({ create: { width, height, channels: 3, background: "#faf7f0" } }).png().toBuffer();
});

async function setupProduct(opts: { photo?: boolean; price?: boolean } = {}) {
  const { productId, variantId } = await createTestVariant(db, {
    sku: "DUNAS-AREIA-M",
    name: "Longo Dunas",
    onHand: 3,
  });
  await db.update(schema.products).set({ slug: "longo-dunas" }).where(eq(schema.products.id, productId));
  if (opts.price !== false) {
    await db.insert(schema.priceVersions).values({
      productVariantId: variantId,
      versionNumber: 1,
      status: "active",
      priceCents: 28900,
      origin: "initial",
      breakdown: {},
      costSnapshotCents: 12000,
      computedMarginRate: "0.3000",
      activatedAt: new Date(),
    });
  }
  if (opts.photo !== false) {
    const path = "products/dunas/1-full.webp";
    await db.insert(schema.productImages).values({ productId, storagePath: path, sortOrder: 0 });
    await storage.upload({
      path,
      data: await sharp({ create: { width: 900, height: 1200, channels: 3, background: "#b08968" } })
        .webp()
        .toBuffer(),
      contentType: "image/webp",
    });
  }
  return productId;
}

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  sdb = db as unknown as DbOrTx;
  storage = new FakeFileStorage();
  render.mockClear();
  vi.stubEnv("ADAPTER_MODE", "fake");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://trivemaison.com.br");
});

afterEach(async () => {
  await close();
  vi.unstubAllEnvs();
});

describe("publishProductPost", () => {
  it("desenha post e story, guarda os dois e monta a legenda; a segunda vez vem do cache", async () => {
    const productId = await setupProduct();
    await db.insert(schema.settings).values([
      { key: "store_name", value: "TRIVÉ" },
      { key: "edition_name", value: "Edição Círio" },
    ]);

    const first = await publishProductPost(sdb, storage, render, {
      productId,
      userId: FIXED_USER_ID,
    });
    expect(render).toHaveBeenCalledTimes(2);
    expect(first.post?.cached).toBe(false);
    expect(first.story?.cached).toBe(false);
    expect(first.caption).toContain("Longo Dunas — Edição Círio.");
    expect(first.caption).toContain("#Belém");
    expect(first.caption.endsWith("https://trivemaison.com.br/produto/longo-dunas")).toBe(true);

    // Os dois formatos chegaram ao renderizador, cada um com a sua tela.
    const kinds = render.mock.calls.map((call) => call[0].kind);
    expect(kinds).toEqual(["post", "story"]);
    expect(await db.select().from(schema.botCards)).toHaveLength(2);

    render.mockClear();
    const second = await publishProductPost(sdb, storage, render, {
      productId,
      userId: FIXED_USER_ID,
    });
    expect(render).not.toHaveBeenCalled();
    expect(second.post?.cached).toBe(true);
    expect(second.story?.cached).toBe(true);
  });

  it("preço igual em todas as variações vira o valor; variações com preços diferentes viram 'a partir de'", async () => {
    const productId = await setupProduct();
    const [variant] = await db
      .insert(schema.productVariants)
      .values({ productId, sku: "DUNAS-AREIA-G", attributes: { tamanho: "G" }, costCents: 12000 })
      .returning({ id: schema.productVariants.id });
    await db.insert(schema.priceVersions).values({
      productVariantId: variant.id,
      versionNumber: 1,
      status: "active",
      priceCents: 31900,
      origin: "initial",
      breakdown: {},
      costSnapshotCents: 12000,
      computedMarginRate: "0.3000",
      activatedAt: new Date(),
    });
    const result = await publishProductPost(sdb, storage, render, {
      productId,
      userId: FIXED_USER_ID,
    });
    expect(result.caption).toContain("a partir de");
  });

  it("peça em rascunho ou agendada não vira post (o link da legenda daria 404)", async () => {
    const productId = await setupProduct();
    await db.update(schema.products).set({ status: "draft" }).where(eq(schema.products.id, productId));
    await expect(
      publishProductPost(sdb, storage, render, { productId, userId: FIXED_USER_ID }),
    ).rejects.toThrow(/ainda não está na vitrine/);

    await db
      .update(schema.products)
      .set({ status: "active", visibleFrom: new Date(Date.now() + 86_400_000) })
      .where(eq(schema.products.id, productId));
    await expect(
      publishProductPost(sdb, storage, render, { productId, userId: FIXED_USER_ID }),
    ).rejects.toThrow(/ainda não apareceu na loja/);
    expect(render).not.toHaveBeenCalled();
  });

  it("variação desativada não entra no preço do post", async () => {
    const productId = await setupProduct();
    const [barata] = await db
      .insert(schema.productVariants)
      .values({ productId, sku: "DUNAS-AREIA-P", attributes: { tamanho: "P" }, costCents: 9000, isActive: false })
      .returning({ id: schema.productVariants.id });
    await db.insert(schema.priceVersions).values({
      productVariantId: barata.id,
      versionNumber: 1,
      status: "active",
      priceCents: 9900,
      origin: "initial",
      breakdown: {},
      costSnapshotCents: 9000,
      computedMarginRate: "0.3000",
      activatedAt: new Date(),
    });
    const result = await publishProductPost(sdb, storage, render, {
      productId,
      userId: FIXED_USER_ID,
    });
    // Só a variação vendável conta: nada de "a partir de" com o preço da inativa.
    expect(result.caption).toContain(formatCentsBRL(28900));
    expect(result.caption).not.toContain("a partir de");
  });

  it("peça sem foto ou sem preço não vira post — e diz o que falta", async () => {
    const semFoto = await setupProduct({ photo: false });
    await expect(
      publishProductPost(sdb, storage, render, { productId: semFoto, userId: FIXED_USER_ID }),
    ).rejects.toThrow(/o post é a foto/);

    await close();
    ({ db, close } = await createTestDb());
    sdb = db as unknown as DbOrTx;
    storage = new FakeFileStorage();
    const semPreco = await setupProduct({ price: false });
    await expect(
      publishProductPost(sdb, storage, render, { productId: semPreco, userId: FIXED_USER_ID }),
    ).rejects.toBeInstanceOf(ServiceError);
    expect(render).not.toHaveBeenCalled();
  });
});

describe("getProductPostPreview / getProductPostFile", () => {
  it("antes de desenhar, a prévia vem vazia com a legenda pronta; depois, o arquivo é servido", async () => {
    const productId = await setupProduct();
    const before = await getProductPostPreview(sdb, storage, productId);
    expect(before.post).toBeNull();
    expect(before.story).toBeNull();
    expect(before.caption).toContain("Longo Dunas");
    expect(await getProductPostFile(sdb, storage, { productId, format: "post" })).toBeNull();

    await publishProductPost(sdb, storage, render, { productId, userId: FIXED_USER_ID });
    const after = await getProductPostPreview(sdb, storage, productId);
    expect(after.post?.cached).toBe(true);
    const file = await getProductPostFile(sdb, storage, { productId, format: "story" });
    expect(file?.contentType).toBe("image/jpeg");
    expect((file?.data.length ?? 0) > 0).toBe(true);
  });
});

describe("carrossel das cores e pré-desenho", () => {
  async function comCores(productId: string) {
    await db
      .update(schema.products)
      .set({ attributesSchema: ["cor"] })
      .where(eq(schema.products.id, productId));
    const [variant] = await db
      .select({ id: schema.productVariants.id })
      .from(schema.productVariants)
      .where(eq(schema.productVariants.productId, productId));
    await db
      .update(schema.productVariants)
      .set({ attributes: { cor: "Areia" } })
      .where(eq(schema.productVariants.id, variant.id));
    const [terra] = await db
      .insert(schema.productVariants)
      .values({ productId, sku: "DUNAS-TERRA-M", attributes: { cor: "Terracota" }, costCents: 12000 })
      .returning({ id: schema.productVariants.id });
    await db.insert(schema.priceVersions).values({
      productVariantId: terra.id,
      versionNumber: 1,
      status: "active",
      priceCents: 28900,
      origin: "initial",
      breakdown: {},
      costSnapshotCents: 12000,
      computedMarginRate: "0.3000",
      activatedAt: new Date(),
    });
    // Uma foto por cor.
    for (const [cor, arquivo] of [["Areia", "areia"], ["Terracota", "terra"]] as const) {
      const path = `products/dunas/${arquivo}-full.webp`;
      await db.insert(schema.productImages).values({ productId, storagePath: path, color: cor, sortOrder: 1 });
      await storage.upload({
        path,
        data: await sharp({ create: { width: 900, height: 1200, channels: 3, background: "#8a7f6d" } })
          .webp()
          .toBuffer(),
        contentType: "image/webp",
      });
    }
  }

  it("desenha um cartão por cor, grava o caminho do post e serve cada cor pelo índice", async () => {
    const productId = await setupProduct();
    await comCores(productId);

    const result = await publishProductPost(sdb, storage, render, { productId, userId: FIXED_USER_ID });
    expect(result.carousel.map((entry) => entry.color)).toEqual(["Areia", "Terracota"]);
    expect(result.carousel.every((entry) => entry.card !== null)).toBe(true);
    // post + story + duas cores
    expect(render).toHaveBeenCalledTimes(4);

    const [row] = await db
      .select({ postCardPath: schema.products.postCardPath })
      .from(schema.products)
      .where(eq(schema.products.id, productId));
    expect(row.postCardPath).toBe(result.post?.path);

    const cor = await getProductPostFile(sdb, storage, { productId, format: "carousel-1" });
    expect((cor?.data.length ?? 0) > 0).toBe(true);
    expect(await getProductPostFile(sdb, storage, { productId, format: "carousel-9" })).toBeNull();
  });

  it("o pré-desenho da publicação é idempotente: a segunda vez não desenha nada", async () => {
    const productId = await setupProduct();
    await comCores(productId);

    const first = await prerenderProductPosts(sdb, storage, render, { productId });
    expect(first).toEqual({ post: true, story: true, colors: 2 });
    expect(render).toHaveBeenCalledTimes(4);

    render.mockClear();
    const second = await prerenderProductPosts(sdb, storage, render, { productId });
    expect(second).toEqual({ post: false, story: false, colors: 2 });
    expect(render).not.toHaveBeenCalled();
  });
});
