// Os cartões da edição de um pedido: um por peça (dois tamanhos da mesma
// peça = um cartão), na ordem do recibo, com a ficha da peça ou o padrão da
// família, publicados por id da peça e carimbados no pedido; gerar de novo
// sobrescreve; cartão velho, página fora do ar, presente e não-roupa são
// ditos à tela; falha no meio não deixa metade publicada.
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeFileStorage } from "@/adapters/storage/fake";
import { DEFAULT_CARE, DEFAULT_WEAR } from "@/core/edition/text";
import type { EditionCardData } from "@/core/edition/types";
import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import {
  buildEditionCardsBasis,
  editionCardStoragePath,
  getEditionCards,
  publishEditionCards,
  ServiceError,
} from "@/services/edition-cards";
import { updateProduct } from "@/services/catalog";
import { listOrdersAwaitingPacking } from "@/services/packing";
import { updateSetting } from "@/services/settings";
import { createStoreOrder } from "@/services/store-orders";
import { createTestDb, createTestVariant, FIXED_USER_ID, type TestDb } from "../helpers/db";

const VALID_CPF = "529.982.247-25";

let db: TestDb;
let sdb: DbOrTx;
let close: () => Promise<void>;
let storage: FakeFileStorage;
const render = vi.fn(async (_data: EditionCardData) =>
  sharp({ create: { width: 108, height: 144, channels: 3, background: "#fdfbf6" } }).png().toBuffer(),
);

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  sdb = db as unknown as DbOrTx;
  storage = new FakeFileStorage();
  render.mockClear();
  vi.stubEnv("ADAPTER_MODE", "fake");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://trivemaison.com.br");
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(async () => {
  await close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function priced(variantId: string, priceCents: number) {
  await db.insert(schema.priceVersions).values({
    productVariantId: variantId,
    versionNumber: 1,
    status: "active",
    priceCents,
    origin: "initial",
    breakdown: {},
    costSnapshotCents: 9000,
    computedMarginRate: "0.3000",
    activatedAt: new Date(),
  });
}

/**
 * Um pedido com duas peças: o Longo Dunas em dois tamanhos e uma bolsa. A
 * bolsa é criada e posta no pedido ANTES do vestido: a ordem do recibo (pelo
 * código, DUNAS-G < DUNAS-M < TOTE) é a única coisa que põe o vestido na frente.
 */
async function createOrder(opts: { gift?: boolean; extra?: { name: string; sku: string } } = {}) {
  const bolsa = await createTestVariant(db, { sku: "TOTE", costCents: 4000, onHand: 5, name: "Bolsa Tote de Algodão" });
  const dunasM = await createTestVariant(db, { sku: "DUNAS-M", costCents: 9000, onHand: 5, name: "Longo Dunas" });
  const [dunasG] = await db
    .insert(schema.productVariants)
    .values({ productId: dunasM.productId, sku: "DUNAS-G", attributes: { tamanho: "G" }, costCents: 9000 })
    .returning({ id: schema.productVariants.id });
  await db.insert(schema.stockLevels).values({ productVariantId: dunasG.id, onHand: 5, reserved: 0 });
  const [vestidos] = await db
    .insert(schema.categories)
    .values({ name: "Vestidos", slug: "vestidos" })
    .returning({ id: schema.categories.id });
  await db
    .update(schema.products)
    .set({
      slug: "longo-dunas",
      categoryId: vestidos.id,
      curatorNote: "Escolhi pelo caimento no calor 🌞",
      careNotes: "hand_wash\ndry_shade",
    })
    .where(eq(schema.products.id, dunasM.productId));
  await db.update(schema.products).set({ slug: "bolsa-tote" }).where(eq(schema.products.id, bolsa.productId));
  await priced(dunasM.variantId, 28900);
  await priced(dunasG.id, 28900);
  await priced(bolsa.variantId, 12900);
  const items = [
    { variantId: bolsa.variantId, quantity: 1, expectedUnitPriceCents: 12900 },
    { variantId: dunasM.variantId, quantity: 1, expectedUnitPriceCents: 28900 },
    { variantId: dunasG.id, quantity: 2, expectedUnitPriceCents: 28900 },
  ];
  let extraId: string | null = null;
  if (opts.extra) {
    const extra = await createTestVariant(db, { sku: opts.extra.sku, costCents: 1000, onHand: 5, name: opts.extra.name });
    await priced(extra.variantId, 3900);
    items.push({ variantId: extra.variantId, quantity: 1, expectedUnitPriceCents: 3900 });
    extraId = extra.productId;
  }
  const [rate] = await db
    .insert(schema.shippingRates)
    .values({ name: "PAC", priceCents: 1990 })
    .returning({ id: schema.shippingRates.id });
  const created = await createStoreOrder(sdb, {
    customer: { fullName: "Juliana Ramos", document: VALID_CPF, phone: "(11) 99999-8888", marketingOptIn: true },
    address: { postalCode: "01310-100", street: "Avenida Paulista", number: "1000", district: "Bela Vista", city: "São Paulo", state: "SP" },
    items,
    shippingRateId: rate.id,
    expectedShippingCents: 1990,
    ...(opts.gift ? { gift: { recipientName: "Mãe", message: "Com amor" } } : {}),
  });
  return { orderId: created.orderId, dunasId: dunasM.productId, bolsaId: bolsa.productId, extraId };
}

describe("buildEditionCardsBasis", () => {
  it("uma peça por produto, na ordem do recibo (código), com a ficha ou o padrão da família", async () => {
    const { orderId, dunasId, bolsaId } = await createOrder();
    await db.insert(schema.settings).values({ key: "edition_name", value: "Edição Círio" });
    const basis = await buildEditionCardsBasis(sdb, orderId);
    expect(basis.editionCardsAt).toBeNull();
    expect(basis.isGift).toBe(false);
    expect(basis.skipped).toEqual([]);
    // DUNAS-G, DUNAS-M, TOTE: o Longo Dunas vem antes da bolsa por código, sempre.
    expect(basis.cards.map((card) => card.productId)).toEqual([dunasId, bolsaId]);
    expect(basis.cards[0].data).toEqual({
      editionName: "Edição Círio",
      productName: "Longo Dunas",
      // A nota sem ponto final ganha um: no cartão ela sai como frase.
      curatorNote: "Escolhi pelo caimento no calor.",
      wearNote: DEFAULT_WEAR.vestido,
      wearSource: "padrao",
      careNote: "Lavar à mão · Secar à sombra",
      qrUrl: "https://trivemaison.com.br/produto/longo-dunas",
      qrTarget: "peca",
      printedAddress: "trivemaison.com.br",
      // Texto curto: corpos máximos, uma linha de título e de frase, QR pequeno.
      layout: { titleSize: 84, titleLines: 1, quoteSize: 44, quoteLines: 1, bodySize: 30, wearLines: 3, careLines: 1, qrSize: 220 },
    });
    expect(basis.cards[0]).toMatchObject({
      publicPage: "ok",
      visibleFrom: null,
      titleTruncated: false,
      curatorTruncated: false,
      wearTruncated: false,
      careTruncated: false,
      careSymbolsDropped: 0,
    });
    // A bolsa não tem ficha nem categoria: família pelo nome, padrão inteiro.
    expect(basis.cards[1].data).toMatchObject({
      curatorNote: null,
      wearNote: DEFAULT_WEAR.acessorio,
      careNote: DEFAULT_CARE.acessorio,
      qrUrl: "https://trivemaison.com.br/produto/bolsa-tote",
    });
  });

  it("presente: o QR leva à home, não à peça com preço, e o convite muda", async () => {
    const { orderId } = await createOrder({ gift: true });
    const basis = await buildEditionCardsBasis(sdb, orderId);
    expect(basis.isGift).toBe(true);
    expect(basis.cards).toHaveLength(2);
    expect(basis.cards.map((card) => [card.data.qrUrl, card.data.qrTarget])).toEqual([
      ["https://trivemaison.com.br", "home"],
      ["https://trivemaison.com.br", "home"],
    ]);
  });

  it("o que não é roupa fica sem cartão e é listado; peça arquivada tem a página fora do ar; agendada diz quando entra", async () => {
    const { orderId, dunasId, bolsaId, extraId } = await createOrder({ extra: { name: "Caneca de Cerâmica", sku: "ZZ-CANECA" } });
    await db.update(schema.products).set({ status: "archived" }).where(eq(schema.products.id, dunasId));
    const amanha = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await db.update(schema.products).set({ visibleFrom: amanha }).where(eq(schema.products.id, bolsaId));
    const basis = await buildEditionCardsBasis(sdb, orderId);
    expect(basis.skipped).toEqual([{ productId: extraId, name: "Caneca de Cerâmica", reason: "nao_roupa" }]);
    expect(basis.cards.map((card) => [card.name, card.publicPage, card.visibleFrom?.getTime() ?? null])).toEqual([
      ["Longo Dunas", "fora_do_ar", null],
      ["Bolsa Tote de Algodão", "agendada", amanha.getTime()],
    ]);
  });

  it("pedido inexistente é recusado", async () => {
    await expect(buildEditionCardsBasis(sdb, "00000000-0000-4000-8000-0000000000aa")).rejects.toBeInstanceOf(
      ServiceError,
    );
  });
});

describe("publishEditionCards / getEditionCards", () => {
  it("desenha um cartão por peça, publica por id da peça, carimba o pedido; gerar de novo sobrescreve com carimbo novo", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = new Date("2026-09-12T15:00:00Z");
    vi.setSystemTime(t0);
    const { orderId, dunasId, bolsaId } = await createOrder();
    const before = await getEditionCards(sdb, storage, orderId);
    expect(before.at).toBeNull();
    expect(before.stale).toBe(false);
    expect(before.cards.map((card) => [card.name, card.hasCuratorNote, card.url])).toEqual([
      ["Longo Dunas", true, null],
      ["Bolsa Tote de Algodão", false, null],
    ]);

    vi.setSystemTime(new Date(t0.getTime() + 1000));
    const result = await publishEditionCards(sdb, storage, render, { orderId });
    expect(result.at.getTime()).toBe(t0.getTime() + 1000);
    expect(render).toHaveBeenCalledTimes(2);
    expect(render.mock.calls.map((call) => call[0].productName)).toEqual(["Longo Dunas", "Bolsa Tote de Algodão"]);
    expect(result.cards.map((card) => card.path)).toEqual([
      editionCardStoragePath(orderId, dunasId),
      editionCardStoragePath(orderId, bolsaId),
    ]);
    expect(storage.list().sort()).toEqual(result.cards.map((card) => card.path).sort());
    expect(storage.get(result.cards[0].path)?.contentType).toBe("image/jpeg");
    const [row] = await db.select({ at: schema.orders.editionCardsAt }).from(schema.orders).where(eq(schema.orders.id, orderId));
    expect(row.at?.getTime()).toBe(result.at.getTime());

    const after = await getEditionCards(sdb, storage, orderId);
    expect(after.at?.getTime()).toBe(result.at.getTime());
    expect(after.stale).toBe(false);
    expect(after.cards.every((card) => card.url?.includes(`?v=${result.at.getTime()}`))).toBe(true);

    // A ficha editada pela tela da peça (o "como veste") depois: o cartão da
    // bolsa fica velho (só ele), e a mesa sabe.
    vi.setSystemTime(new Date(t0.getTime() + 5000));
    await updateProduct(db, { productId: bolsaId, fitNotes: "Alça longa, cabe um livro.", userId: FIXED_USER_ID });
    const stale = await getEditionCards(sdb, storage, orderId);
    expect(stale.stale).toBe(true);
    expect(stale.cards.map((card) => [card.name, card.stale])).toEqual([
      ["Longo Dunas", false],
      ["Bolsa Tote de Algodão", true],
    ]);
    await db.update(schema.orders).set({ status: "paid", paidAt: new Date() }).where(eq(schema.orders.id, orderId));
    expect((await listOrdersAwaitingPacking(sdb))[0]).toMatchObject({ editionCardsStale: true });

    // Gerar de novo: mesmos paths, carimbo novo, nada mais velho.
    vi.setSystemTime(new Date(t0.getTime() + 9000));
    render.mockClear();
    const again = await publishEditionCards(sdb, storage, render, { orderId });
    expect(render.mock.calls[1][0]).toMatchObject({ wearNote: "Alça longa, cabe um livro.", wearSource: "ficha" });
    expect(again.cards.map((card) => card.path)).toEqual(result.cards.map((card) => card.path));
    expect(storage.list()).toHaveLength(2);
    expect(again.at.getTime()).toBe(t0.getTime() + 9000);
    const fresh = await getEditionCards(sdb, storage, orderId);
    expect(fresh.stale).toBe(false);
    expect(fresh.cards.every((card) => card.url?.includes(`?v=${t0.getTime() + 9000}`))).toBe(true);
    expect((await listOrdersAwaitingPacking(sdb))[0]).toMatchObject({ editionCardsStale: false });

    // O nome da edição está em todo cartão: trocá-lo envelhece todos.
    vi.setSystemTime(new Date(t0.getTime() + 12000));
    await updateSetting(db, { key: "edition_name", value: "Edição Círio", userId: FIXED_USER_ID });
    const renamed = await getEditionCards(sdb, storage, orderId);
    expect(renamed.cards.map((card) => card.stale)).toEqual([true, true]);
    expect((await listOrdersAwaitingPacking(sdb))[0]).toMatchObject({ editionCardsStale: true });
  });

  it("mexer no que não é roupa (sem cartão), no cartão do post ou na descrição não envelhece os cartões; virar presente, sim", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = new Date("2026-09-12T15:00:00Z");
    vi.setSystemTime(t0);
    const { orderId, dunasId, extraId } = await createOrder({ extra: { name: "Caneca de Cerâmica", sku: "ZZ-CANECA" } });
    await publishEditionCards(sdb, storage, render, { orderId });
    await db.update(schema.orders).set({ status: "paid", paidAt: new Date() }).where(eq(schema.orders.id, orderId));

    vi.setSystemTime(new Date(t0.getTime() + 5000));
    await updateProduct(db, { productId: extraId!, fitNotes: "Cabe 300 ml.", userId: FIXED_USER_ID });
    // O cartão do post redesenhado (foto nova) não é mudança na ficha.
    await db.update(schema.products).set({ postCardPath: "cards/x.png" }).where(eq(schema.products.id, dunasId));
    // Uma mudança na peça que não entra no cartão (a descrição) também não.
    await updateProduct(db, { productId: dunasId, description: "Linho puro, forro de algodão.", userId: FIXED_USER_ID });
    expect((await getEditionCards(sdb, storage, orderId)).stale).toBe(false);
    expect((await listOrdersAwaitingPacking(sdb))[0]).toMatchObject({ editionCardsStale: false });

    // Virou presente depois: o QR muda de destino, os cartões ficam velhos.
    await db.update(schema.orders).set({ isGift: true }).where(eq(schema.orders.id, orderId));
    expect((await getEditionCards(sdb, storage, orderId)).cards.map((card) => card.stale)).toEqual([true, true]);
    expect((await listOrdersAwaitingPacking(sdb))[0]).toMatchObject({ editionCardsStale: true });
  });

  it("falha no meio: nada sobe e o carimbo não muda; a mensagem diz qual peça", async () => {
    const { orderId } = await createOrder();
    render.mockImplementationOnce(async () => sharp({ create: { width: 10, height: 10, channels: 3, background: "#fff" } }).png().toBuffer());
    render.mockImplementationOnce(async () => {
      throw new Error("Satori caiu");
    });
    await expect(publishEditionCards(sdb, storage, render, { orderId })).rejects.toMatchObject({
      name: "ServiceError",
      code: "cartao_falhou",
      message: expect.stringContaining("Bolsa Tote de Algodão"),
    });
    expect(storage.list()).toEqual([]);
    const [row] = await db.select({ at: schema.orders.editionCardsAt }).from(schema.orders).where(eq(schema.orders.id, orderId));
    expect(row.at).toBeNull();
  });

  it("o id do pedido em maiúsculas publica e lê nos mesmos paths (o id do banco manda)", async () => {
    const { orderId } = await createOrder();
    const result = await publishEditionCards(sdb, storage, render, { orderId: orderId.toUpperCase() });
    const view = await getEditionCards(sdb, storage, orderId.toUpperCase());
    for (const card of view.cards) {
      expect(storage.list()).toContain(card.url!.split("?")[0].replace("memory://", ""));
    }
    expect(result.cards.every((card) => card.path.includes(orderId))).toBe(true);
  });

  it("pedido só com não-roupa é recusado com a explicação certa", async () => {
    const extra = await createTestVariant(db, { sku: "ZZ-CANECA", costCents: 1000, onHand: 5, name: "Caneca de Cerâmica" });
    await priced(extra.variantId, 3900);
    const [rate] = await db.insert(schema.shippingRates).values({ name: "PAC", priceCents: 1990 }).returning({ id: schema.shippingRates.id });
    const created = await createStoreOrder(sdb, {
      customer: { fullName: "Juliana Ramos", document: VALID_CPF, phone: "(11) 99999-8888", marketingOptIn: true },
      address: { postalCode: "01310-100", street: "Avenida Paulista", number: "1000", district: "Bela Vista", city: "São Paulo", state: "SP" },
      items: [{ variantId: extra.variantId, quantity: 1, expectedUnitPriceCents: 3900 }],
      shippingRateId: rate.id,
      expectedShippingCents: 1990,
    });
    await expect(publishEditionCards(sdb, storage, render, { orderId: created.orderId })).rejects.toMatchObject({
      code: "pedido_sem_pecas",
      message: expect.stringContaining("não são roupa"),
    });
  });

  it("a lista de embalagem sabe quais pedidos já têm cartões", async () => {
    const { orderId } = await createOrder();
    await db.update(schema.orders).set({ status: "paid", paidAt: new Date() }).where(eq(schema.orders.id, orderId));
    expect((await listOrdersAwaitingPacking(sdb))[0]).toMatchObject({ editionCardsAt: null, editionCardsStale: false, editionCards: 2 });
    await publishEditionCards(sdb, storage, render, { orderId });
    expect((await listOrdersAwaitingPacking(sdb))[0]?.editionCardsAt).toBeInstanceOf(Date);
  });

  it("pedido só com não-roupa: a mesa sabe que não há cartão (sem link); peça que virou roupa depois da geração fica sem imagem, velha", async () => {
    const extra = await createTestVariant(db, { sku: "ZZ-CANECA", costCents: 1000, onHand: 5, name: "Caneca de Cerâmica" });
    await priced(extra.variantId, 3900);
    const [rate] = await db.insert(schema.shippingRates).values({ name: "PAC", priceCents: 1990 }).returning({ id: schema.shippingRates.id });
    const created = await createStoreOrder(sdb, {
      customer: { fullName: "Juliana Ramos", document: VALID_CPF, phone: "(11) 99999-8888", marketingOptIn: true },
      address: { postalCode: "01310-100", street: "Avenida Paulista", number: "1000", district: "Bela Vista", city: "São Paulo", state: "SP" },
      items: [{ variantId: extra.variantId, quantity: 1, expectedUnitPriceCents: 3900 }],
      shippingRateId: rate.id,
      expectedShippingCents: 1990,
    });
    await db.update(schema.orders).set({ status: "paid", paidAt: new Date() }).where(eq(schema.orders.id, created.orderId));
    expect((await listOrdersAwaitingPacking(sdb))[0]).toMatchObject({ editionCards: 0, editionCardsStale: false });

    // Um pedido normal gerado; depois a categoria de uma peça muda de "Casa" para "Vestidos"… aqui,
    // simulamos a peça entrando no plano: o mapa guardado não a conhece → sem url, velha.
    const { orderId, bolsaId } = await createOrder();
    await publishEditionCards(sdb, storage, render, { orderId });
    await db
      .update(schema.orders)
      .set({ editionCardsFingerprint: {} })
      .where(eq(schema.orders.id, orderId));
    const view = await getEditionCards(sdb, storage, orderId);
    expect(view.cards.find((card) => card.productId === bolsaId)).toMatchObject({ url: null, stale: true });
    expect(view.stale).toBe(true);
  });
});
