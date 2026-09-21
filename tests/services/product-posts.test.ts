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
  /** Duas cores (Areia, Terracota), cada uma com foto própria e preço; Terracota mais cara. */
  async function comCores(productId: string, opts: { terracotaCents?: number } = {}) {
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
      priceCents: opts.terracotaCents ?? 28900,
      origin: "initial",
      breakdown: {},
      costSnapshotCents: 12000,
      computedMarginRate: "0.3000",
      activatedAt: new Date(),
    });
    // Uma foto por cor, cada uma com a sua cor de fundo (os cartões diferem).
    for (const [cor, arquivo, fundo] of [
      ["Areia", "areia", "#d9c7a7"],
      ["Terracota", "terra", "#b5532b"],
    ] as const) {
      await fotoDaCor(productId, cor, arquivo, fundo);
    }
  }

  async function fotoDaCor(productId: string, cor: string, arquivo: string, fundo: string) {
    const path = `products/dunas/${arquivo}-full.webp`;
    await db.insert(schema.productImages).values({ productId, storagePath: path, color: cor, sortOrder: 1 });
    await storage.upload({
      path,
      data: await sharp({ create: { width: 900, height: 1200, channels: 3, background: fundo } })
        .webp()
        .toBuffer(),
      contentType: "image/webp",
    });
    return path;
  }

  async function postCardPathOf(productId: string) {
    const [row] = await db
      .select({ postCardPath: schema.products.postCardPath })
      .from(schema.products)
      .where(eq(schema.products.id, productId));
    return row.postCardPath;
  }

  it("a foto no corpo (origin 'ai') vira a capa do post e do story; o carrossel fica só com as fotos reais", async () => {
    const productId = await setupProduct();
    await comCores(productId);
    // A foto no corpo da cor Areia entra DEPOIS das reais (sort_order maior) e mesmo assim é a capa.
    const aiPath = "products/dunas/areia-ai-full.webp";
    await db.insert(schema.productImages).values({ productId, storagePath: aiPath, color: "Areia", sortOrder: 5, origin: "ai" });
    await storage.upload({
      path: aiPath,
      data: await sharp({ create: { width: 900, height: 1200, channels: 3, background: "#4a6b3a" } }).webp().toBuffer(),
      contentType: "image/webp",
    });

    const result = await publishProductPost(sdb, storage, render, { productId, userId: FIXED_USER_ID });
    expect(result.carousel.map((entry) => entry.color)).toEqual(["Areia", "Terracota"]);
    const calls = render.mock.calls.map((call) => call[0]);
    const post = calls[0];
    const story = calls[1];
    const areia = calls[2];
    if (post.kind !== "post" || story.kind !== "story" || areia.kind !== "post") throw new Error("cartões inesperados");
    // Capa (post e story) = a foto no corpo (verde escuro); a lâmina da cor
    // Areia = a foto real, esticada (areia). A moldura muda por formato, então
    // a comparação é pela cor dominante, não pelo arquivo.
    const fundo = async (dataUrl: string) => {
      const { data } = await sharp(Buffer.from(dataUrl.split(",")[1] ?? "", "base64")).resize(1, 1).raw().toBuffer({ resolveWithObject: true });
      return [data[0]!, data[1]!, data[2]!] as const;
    };
    for (const capa of [post, story]) {
      const [r, g] = await fundo(capa.hero.imageDataUrl);
      expect(g).toBeGreaterThan(r);
    }
    const [laminaR, laminaG] = await fundo(areia.hero.imageDataUrl);
    expect(laminaR).toBeGreaterThan(laminaG);
  });

  it("desenha um cartão por cor com o preço daquela cor, grava o caminho do post e serve cada cor pelo índice", async () => {
    const productId = await setupProduct();
    await comCores(productId, { terracotaCents: 34900 });
    await db.insert(schema.settings).values({ key: "edition_name", value: "Edição Círio" });

    const result = await publishProductPost(sdb, storage, render, { productId, userId: FIXED_USER_ID });
    expect(result.slug).toBe("longo-dunas");
    expect(result.carousel.map((entry) => [entry.color, entry.problem])).toEqual([
      ["Areia", null],
      ["Terracota", null],
    ]);
    expect(result.carousel.every((entry) => entry.card !== null)).toBe(true);
    expect(result.omittedColors).toEqual([]);
    // post + story + duas cores, cada um com a sua faixa e o seu preço
    expect(render).toHaveBeenCalledTimes(4);
    const calls = render.mock.calls.map((call) => {
      const data = call[0];
      if (data.kind !== "post" && data.kind !== "story") throw new Error(`cartão inesperado: ${data.kind}`);
      return data;
    });
    expect(calls.map((data) => data.eyebrow)).toEqual([
      "EDIÇÃO CÍRIO",
      "EDIÇÃO CÍRIO",
      "EDIÇÃO CÍRIO · AREIA",
      "EDIÇÃO CÍRIO · TERRACOTA",
    ]);
    expect(calls.map((data) => data.hero.priceLabel)).toEqual([
      `a partir de ${formatCentsBRL(28900)}`,
      `a partir de ${formatCentsBRL(28900)}`,
      formatCentsBRL(28900),
      formatCentsBRL(34900),
    ]);
    // A foto de cada slide é a da cor, não a capa repetida.
    expect(calls[2].hero.imageDataUrl).not.toBe(calls[3].hero.imageDataUrl);
    expect(calls[2].hero.imageDataUrl).not.toBe(calls[0].hero.imageDataUrl);

    expect(await postCardPathOf(productId)).toBe(result.post?.path);

    const terracota = await getProductPostFile(sdb, storage, { productId, format: "carousel-1" });
    const cache = await storage.download(result.carousel[1].card!.path);
    expect(terracota?.data.equals(cache.data)).toBe(true);
    expect(await getProductPostFile(sdb, storage, { productId, format: "carousel-9" })).toBeNull();
  });

  it("a prévia devolve cor ↔ cartão por posição: nulos antes de desenhar, os mesmos caminhos depois", async () => {
    const productId = await setupProduct();
    await comCores(productId);

    const before = await getProductPostPreview(sdb, storage, productId);
    expect(before.carousel).toEqual([
      { color: "Areia", card: null, problem: null },
      { color: "Terracota", card: null, problem: null },
    ]);

    const drawn = await publishProductPost(sdb, storage, render, { productId, userId: FIXED_USER_ID });
    const after = await getProductPostPreview(sdb, storage, productId);
    expect(after.carousel.map((entry) => [entry.color, entry.card?.path])).toEqual(
      drawn.carousel.map((entry) => [entry.color, entry.card?.path]),
    );
    expect(new Set(after.carousel.map((entry) => entry.card?.path)).size).toBe(2);
  });

  it("cor sem preço ativo fica fora do carrossel mesmo com foto própria; uma cor só não é carrossel", async () => {
    const productId = await setupProduct();
    await comCores(productId);
    // Verde: variação ativa, foto própria, nenhum preço.
    await db
      .insert(schema.productVariants)
      .values({ productId, sku: "DUNAS-VERDE-M", attributes: { cor: "Verde" }, costCents: 12000 });
    await fotoDaCor(productId, "Verde", "verde", "#3f6b4a");

    const result = await publishProductPost(sdb, storage, render, { productId, userId: FIXED_USER_ID });
    expect(result.carousel.map((entry) => entry.color)).toEqual(["Areia", "Terracota"]);
    expect(render).toHaveBeenCalledTimes(4);

    // Peça de uma cor só: post e story, e nada de carrossel.
    render.mockClear();
    const umaCor = await setupProduct2("DUNAS-UNI-M", "Curto Dunas", "curto-dunas");
    await db.update(schema.products).set({ attributesSchema: ["cor"] }).where(eq(schema.products.id, umaCor));
    await db
      .update(schema.productVariants)
      .set({ attributes: { cor: "Areia" } })
      .where(eq(schema.productVariants.productId, umaCor));
    await fotoDaCor(umaCor, "Areia", "curto-areia", "#d9c7a7");
    const single = await publishProductPost(sdb, storage, render, { productId: umaCor, userId: FIXED_USER_ID });
    expect(single.carousel).toEqual([]);
    expect(render).toHaveBeenCalledTimes(2);
  });

  async function setupProduct2(sku: string, name: string, slug: string, opts: { price?: boolean } = {}) {
    const { productId, variantId } = await createTestVariant(db, { sku, name, onHand: 1 });
    await db.update(schema.products).set({ slug }).where(eq(schema.products.id, productId));
    if (opts.price !== false) {
      await db.insert(schema.priceVersions).values({
        productVariantId: variantId,
        versionNumber: 1,
        status: "active",
        priceCents: 19900,
        origin: "initial",
        breakdown: {},
        costSnapshotCents: 9000,
        computedMarginRate: "0.3000",
        activatedAt: new Date(),
      });
    }
    const path = `products/${slug}/1-full.webp`;
    await db.insert(schema.productImages).values({ productId, storagePath: path, sortOrder: 0 });
    await storage.upload({
      path,
      data: await sharp({ create: { width: 900, height: 1200, channels: 3, background: "#777" } }).webp().toBuffer(),
      contentType: "image/webp",
    });
    return productId;
  }

  it("uma cor com foto que não abre não derruba o post: o caminho é gravado e a cor fica marcada", async () => {
    const productId = await setupProduct();
    await comCores(productId);
    await storage.remove("products/dunas/terra-full.webp");

    const result = await publishProductPost(sdb, storage, render, { productId, userId: FIXED_USER_ID });
    expect(result.post).not.toBeNull();
    expect(result.carousel[0].card).not.toBeNull();
    expect(result.carousel[1].card).toBeNull();
    expect(result.carousel[1].problem).toContain("cor Terracota");
    expect(result.carousel[1].problem).toContain("Longo Dunas");
    expect(await postCardPathOf(productId)).toBe(result.post?.path);

    // O pré-desenho também não falha por causa dela: registra e segue.
    render.mockClear();
    const pre = await prerenderProductPosts(sdb, storage, render, { productId });
    expect(pre).toMatchObject({ skipped: null, slug: "longo-dunas", colors: 2, colorProblems: ["Terracota"] });
  });

  it("foto principal que não abre vira 'foto_indisponivel' com o nome da peça, no gerar e no pré-desenho", async () => {
    const productId = await setupProduct();
    await storage.upload({
      path: "products/dunas/1-full.webp",
      data: Buffer.from("isto não é uma imagem"),
      contentType: "image/webp",
    });

    await expect(
      publishProductPost(sdb, storage, render, { productId, userId: FIXED_USER_ID }),
    ).rejects.toMatchObject({ code: "foto_indisponivel", message: expect.stringContaining("Longo Dunas") });
    await expect(prerenderProductPosts(sdb, storage, render, { productId })).rejects.toMatchObject({
      code: "foto_indisponivel",
    });
    expect(await postCardPathOf(productId)).toBeNull();
  });

  it("o pré-desenho da publicação é idempotente: a segunda vez não desenha nada", async () => {
    const productId = await setupProduct();
    await comCores(productId);

    const first = await prerenderProductPosts(sdb, storage, render, { productId });
    expect(first).toEqual({
      skipped: null,
      slug: "longo-dunas",
      post: true,
      story: true,
      colors: 2,
      colorProblems: [],
    });
    expect(render).toHaveBeenCalledTimes(4);
    expect(await postCardPathOf(productId)).not.toBeNull();

    render.mockClear();
    const second = await prerenderProductPosts(sdb, storage, render, { productId });
    expect(second).toMatchObject({ skipped: null, post: false, story: false, colors: 2 });
    expect(render).not.toHaveBeenCalled();
  });

  it("sem foto, sem preço, rascunho ou peça sumida: o pré-desenho pula (não falha) e apaga a prévia velha", async () => {
    const semFoto = await setupProduct({ photo: false });
    await db.update(schema.products).set({ postCardPath: "cards/ve/velho.jpg" }).where(eq(schema.products.id, semFoto));
    expect(await prerenderProductPosts(sdb, storage, render, { productId: semFoto })).toEqual({
      skipped: "sem_foto",
      visibleFrom: null,
    });
    expect(await postCardPathOf(semFoto)).toBeNull();

    const semPreco = await setupProduct2("DUNAS-SP-M", "Sem Preço", "sem-preco", { price: false });
    await db.update(schema.products).set({ postCardPath: "cards/ve/velho.jpg" }).where(eq(schema.products.id, semPreco));
    expect(await prerenderProductPosts(sdb, storage, render, { productId: semPreco })).toMatchObject({
      skipped: "sem_preco",
    });
    expect(await postCardPathOf(semPreco)).toBeNull();

    const rascunho = await setupProduct2("DUNAS-RA-M", "Rascunho", "rascunho");
    await db
      .update(schema.products)
      .set({ status: "draft", postCardPath: "cards/ve/velho.jpg" })
      .where(eq(schema.products.id, rascunho));
    expect(await prerenderProductPosts(sdb, storage, render, { productId: rascunho })).toMatchObject({
      skipped: "peca_nao_publicada",
    });
    expect(await postCardPathOf(rascunho)).toBeNull();

    expect(
      await prerenderProductPosts(sdb, storage, render, { productId: "00000000-0000-4000-8000-0000000000ff" }),
    ).toEqual({ skipped: "nao_encontrado", visibleFrom: null });
    expect(render).not.toHaveBeenCalled();
  });

  it("peça com estreia marcada: pula agora, devolve a data para o handler agendar e mantém a prévia que já tinha", async () => {
    const productId = await setupProduct();
    const estreia = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
    await db
      .update(schema.products)
      .set({ visibleFrom: estreia, postCardPath: "cards/ve/velho.jpg" })
      .where(eq(schema.products.id, productId));
    const result = await prerenderProductPosts(sdb, storage, render, { productId });
    if (result.skipped !== "peca_agendada") throw new Error(`esperava pular como agendada: ${JSON.stringify(result)}`);
    expect(result.visibleFrom?.getTime()).toBe(estreia.getTime());
    expect(render).not.toHaveBeenCalled();
    expect(await postCardPathOf(productId)).toBe("cards/ve/velho.jpg");
  });

  it("falha do próprio desenho não é 'foto indisponível': propaga para o retry da fila", async () => {
    const productId = await setupProduct();
    await comCores(productId);
    render.mockImplementationOnce(async () => {
      throw new Error("Satori: image decode failed");
    });
    await expect(publishProductPost(sdb, storage, render, { productId, userId: FIXED_USER_ID })).rejects.toThrow(
      /Satori/,
    );
    // No carrossel, idem: a cor não é marcada como "foto que não abre".
    render.mockImplementation(async (data: CardData) => {
      if (data.kind === "post" && data.eyebrow.includes("TERRACOTA")) throw new Error("Satori: font missing");
      const { width, height } = data.kind === "story" ? { width: 108, height: 192 } : { width: 108, height: 135 };
      return sharp({ create: { width, height, channels: 3, background: "#faf7f0" } }).png().toBuffer();
    });
    await expect(prerenderProductPosts(sdb, storage, render, { productId })).rejects.toThrow(/font missing/);
  });

  it("peça desenhada antes de existir a prévia do link: abrir a tela cura o caminho", async () => {
    const productId = await setupProduct();
    const drawn = await publishProductPost(sdb, storage, render, { productId, userId: FIXED_USER_ID });
    await db.update(schema.products).set({ postCardPath: null }).where(eq(schema.products.id, productId));

    const preview = await getProductPostPreview(sdb, storage, productId);
    expect(preview.post?.cached).toBe(true);
    expect(await postCardPathOf(productId)).toBe(drawn.post?.path);
  });
});
