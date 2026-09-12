// Os cartões da edição de um pedido: um por peça (dois tamanhos da mesma
// peça = um cartão), com a ficha da peça ou o padrão da família, publicados
// por id da peça e carimbados no pedido; gerar de novo sobrescreve.
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
import { listOrdersAwaitingPacking } from "@/services/packing";
import { createStoreOrder } from "@/services/store-orders";
import { createTestDb, createTestVariant, type TestDb } from "../helpers/db";

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
});

afterEach(async () => {
  await close();
  vi.unstubAllEnvs();
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

/** Um pedido com duas peças: o Longo Dunas em dois tamanhos e uma bolsa. */
async function createOrder() {
  const dunasM = await createTestVariant(db, { sku: "DUNAS-M", costCents: 9000, onHand: 5, name: "Longo Dunas" });
  const [dunasG] = await db
    .insert(schema.productVariants)
    .values({ productId: dunasM.productId, sku: "DUNAS-G", attributes: { tamanho: "G" }, costCents: 9000 })
    .returning({ id: schema.productVariants.id });
  await db.insert(schema.stockLevels).values({ productVariantId: dunasG.id, onHand: 5, reserved: 0 });
  const bolsa = await createTestVariant(db, { sku: "TOTE", costCents: 4000, onHand: 5, name: "Bolsa Tote de Algodão" });
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
  const [rate] = await db
    .insert(schema.shippingRates)
    .values({ name: "PAC", priceCents: 1990 })
    .returning({ id: schema.shippingRates.id });
  const created = await createStoreOrder(sdb, {
    customer: { fullName: "Juliana Ramos", document: VALID_CPF, phone: "(11) 99999-8888", marketingOptIn: true },
    address: { postalCode: "01310-100", street: "Avenida Paulista", number: "1000", district: "Bela Vista", city: "São Paulo", state: "SP" },
    items: [
      { variantId: dunasM.variantId, quantity: 1, expectedUnitPriceCents: 28900 },
      { variantId: dunasG.id, quantity: 2, expectedUnitPriceCents: 28900 },
      { variantId: bolsa.variantId, quantity: 1, expectedUnitPriceCents: 12900 },
    ],
    shippingRateId: rate.id,
    expectedShippingCents: 1990,
  });
  return { orderId: created.orderId, dunasId: dunasM.productId, bolsaId: bolsa.productId };
}

describe("buildEditionCardsBasis", () => {
  it("uma peça por produto, na ordem do pedido, com a ficha ou o padrão da família", async () => {
    const { orderId, dunasId, bolsaId } = await createOrder();
    await db.insert(schema.settings).values({ key: "edition_name", value: "Edição Círio" });
    const basis = await buildEditionCardsBasis(sdb, orderId);
    expect(basis.editionCardsAt).toBeNull();
    expect(basis.cards.map((card) => card.productId)).toEqual([dunasId, bolsaId]);
    expect(basis.cards[0].data).toEqual({
      storeName: "TRIVÉ",
      editionName: "Edição Círio",
      productName: "Longo Dunas",
      curatorNote: "Escolhi pelo caimento no calor",
      wearNote: DEFAULT_WEAR.vestido,
      careNote: "Lavar à mão · Secar à sombra",
      productUrl: "https://trivemaison.com.br/produto/longo-dunas",
    });
    // A bolsa não tem ficha nem categoria: família pelo nome, padrão inteiro.
    expect(basis.cards[1].data).toMatchObject({
      curatorNote: null,
      wearNote: DEFAULT_WEAR.acessorio,
      careNote: DEFAULT_CARE.acessorio,
      productUrl: "https://trivemaison.com.br/produto/bolsa-tote",
    });
  });

  it("pedido inexistente é recusado", async () => {
    await expect(buildEditionCardsBasis(sdb, "00000000-0000-4000-8000-0000000000aa")).rejects.toBeInstanceOf(
      ServiceError,
    );
  });
});

describe("publishEditionCards / getEditionCards", () => {
  it("desenha um cartão por peça, publica por id da peça, carimba o pedido; gerar de novo sobrescreve", async () => {
    const { orderId, dunasId, bolsaId } = await createOrder();
    const before = await getEditionCards(sdb, storage, orderId);
    expect(before.at).toBeNull();
    expect(before.cards.map((card) => [card.name, card.hasCuratorNote, card.url])).toEqual([
      ["Longo Dunas", true, null],
      ["Bolsa Tote de Algodão", false, null],
    ]);

    const result = await publishEditionCards(sdb, storage, render, { orderId });
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
    expect(after.cards.every((card) => card.url?.includes(`?v=${result.at.getTime()}`))).toBe(true);

    // Nota escrita depois: gerar de novo redesenha no mesmo path, com carimbo novo.
    await db.update(schema.products).set({ curatorNote: "Agora com nota." }).where(eq(schema.products.id, bolsaId));
    render.mockClear();
    const again = await publishEditionCards(sdb, storage, render, { orderId });
    expect(render.mock.calls[1][0].curatorNote).toBe("Agora com nota.");
    expect(again.cards.map((card) => card.path)).toEqual(result.cards.map((card) => card.path));
    expect(storage.list()).toHaveLength(2);
    expect(again.at.getTime()).toBeGreaterThanOrEqual(result.at.getTime());
  });

  it("a lista de embalagem sabe quais pedidos já têm cartões", async () => {
    const { orderId } = await createOrder();
    await db.update(schema.orders).set({ status: "paid", paidAt: new Date() }).where(eq(schema.orders.id, orderId));
    expect((await listOrdersAwaitingPacking(sdb))[0]?.editionCardsAt).toBeNull();
    await publishEditionCards(sdb, storage, render, { orderId });
    expect((await listOrdersAwaitingPacking(sdb))[0]?.editionCardsAt).toBeInstanceOf(Date);
  });
});
