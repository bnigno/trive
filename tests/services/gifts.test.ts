// Presente com bilhete: a imagem é publicada SEMPRE que o pedido é presente
// (o admin imprime dela); a prévia pelo WhatsApp depende de WhatsApp ligado,
// telefone, opt-in e template, com dedupe por pedido.
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeFileStorage } from "@/adapters/storage/fake";
import { FakeMessagingProvider } from "@/adapters/zapi/fake";
import type { GiftNoteData } from "@/core/gifts/types";
import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import {
  buildGiftNoteData,
  giftNoteDedupeKey,
  giftNoteStoragePath,
  publishGiftNote,
  sendGiftNoteWa,
  type GiftNoteRenderer,
} from "@/services/gifts";
import { createStoreOrder, type CreateStoreOrderInput } from "@/services/store-orders";
import { createTestDb, createTestVariant, type TestDb } from "../helpers/db";

let db: TestDb;
let sdb: DbOrTx;
let close: () => Promise<void>;
let storage: FakeFileStorage;
let provider: FakeMessagingProvider;
let rendered: GiftNoteData[] = [];

const VALID_CPF = "529.982.247-25";

const render: GiftNoteRenderer = async (data) => {
  rendered.push(data);
  return sharp({ create: { width: 1080, height: 720, channels: 3, background: "#fdfbf6" } })
    .png()
    .toBuffer();
};

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  sdb = db as unknown as DbOrTx;
  storage = new FakeFileStorage();
  provider = new FakeMessagingProvider();
  rendered = [];
});

afterEach(async () => {
  await close();
});

async function seedTemplate(): Promise<void> {
  await db.insert(schema.waTemplates).values({
    key: "gift_note_preview",
    label: "Bilhete",
    bodyTemplate: "{{nome}}, o bilhete para {{para}} ficou assim 🎁 {{presente}}",
    variables: ["nome", "para", "presente"],
    isActive: true,
  });
}

async function createOrder(over: { gift?: CreateStoreOrderInput["gift"]; marketingOptIn?: boolean } = {}) {
  const sku = `VE-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
  const { variantId } = await createTestVariant(db, { sku, costCents: 9000, onHand: 5, name: "Vestido Ébano" });
  await db.insert(schema.priceVersions).values({
    productVariantId: variantId,
    versionNumber: 1,
    status: "active",
    priceCents: 28900,
    origin: "initial",
    breakdown: {},
    costSnapshotCents: 9000,
    computedMarginRate: "0.3000",
    activatedAt: new Date(),
  });
  const [rate] = await db
    .insert(schema.shippingRates)
    .values({ name: "PAC", priceCents: 1990 })
    .returning({ id: schema.shippingRates.id });
  return createStoreOrder(sdb, {
    customer: {
      fullName: "Juliana Ramos",
      document: VALID_CPF,
      phone: "(11) 99999-8888",
      marketingOptIn: over.marketingOptIn ?? true,
    },
    address: {
      postalCode: "01310-100",
      street: "Avenida Paulista",
      number: "1000",
      district: "Bela Vista",
      city: "São Paulo",
      state: "SP",
    },
    items: [{ variantId, quantity: 1, expectedUnitPriceCents: 28900 }],
    shippingRateId: rate.id,
    expectedShippingCents: 1990,
    ...("gift" in over ? { gift: over.gift } : { gift: { recipientName: "Mãe", message: "Para os seus dias bonitos 🤎" } }),
  });
}

describe("buildGiftNoteData / publishGiftNote", () => {
  it("monta o bilhete com o texto limpo e a assinatura pelo primeiro nome; publica e grava o path", async () => {
    const created = await createOrder();
    const data = await buildGiftNoteData(sdb, created.orderId);
    expect(data).toEqual({
      recipientName: "Mãe",
      message: "Para os seus dias bonitos",
      signature: "Com carinho, Juliana",
      storeName: "TRIVÉ",
    });

    const published = await publishGiftNote(sdb, storage, render, { orderId: created.orderId });
    expect("skipped" in published).toBe(false);
    const path = giftNoteStoragePath(created.orderId);
    expect(storage.has(path)).toBe(true);
    expect((await storage.download(path)).contentType).toBe("image/jpeg");
    const [order] = await db.select().from(schema.orders).where(eq(schema.orders.id, created.orderId));
    expect(order.giftNotePath).toBe(path);
    expect(order.isGift).toBe(true);
  });

  it("pedido que não é presente: nao_presente, sem render", async () => {
    const created = await createOrder({ gift: undefined });
    expect(await buildGiftNoteData(sdb, created.orderId)).toBeNull();
    expect(await publishGiftNote(sdb, storage, render, { orderId: created.orderId })).toEqual({ skipped: "nao_presente" });
    expect(rendered).toHaveLength(0);
  });
});

describe("sendGiftNoteWa", () => {
  it("publica sempre; sem WhatsApp ligado só publica (desabilitado)", async () => {
    const created = await createOrder();
    const result = await sendGiftNoteWa(sdb, provider, storage, render, { orderId: created.orderId });
    expect(result).toEqual({ skipped: "desabilitado" });
    expect(storage.has(giftNoteStoragePath(created.orderId))).toBe(true);
    expect(provider.sentImages).toHaveLength(0);
  });

  it("com opt-in e template manda a imagem com a legenda; reenvio → ja_enviado", async () => {
    await db.insert(schema.settings).values({ key: "wa_enabled", value: true });
    await seedTemplate();
    const created = await createOrder();

    const first = await sendGiftNoteWa(sdb, provider, storage, render, { orderId: created.orderId });
    expect("skipped" in first).toBe(false);
    expect(provider.sentImages).toHaveLength(1);
    expect(provider.sentImages[0]?.caption).toBe(
      "Juliana, o bilhete para Mãe ficou assim 🎁 \n🎁 Presente — sem preço na embalagem",
    );
    expect(provider.sentImages[0]?.imageUrl).toContain(giftNoteStoragePath(created.orderId));

    const [message] = await db.select().from(schema.waMessages);
    expect(message.dedupeKey).toBe(giftNoteDedupeKey(created.orderId));
    expect(message.orderId).toBe(created.orderId);

    const again = await sendGiftNoteWa(sdb, provider, storage, render, { orderId: created.orderId });
    expect(again).toEqual({ skipped: "ja_enviado" });
    expect(provider.sentImages).toHaveLength(1);
    // Publicou de novo (upsert no mesmo path) — o bilhete impresso segue atualizado.
    expect(rendered).toHaveLength(2);
  });

  it("sem opt-in MANDA (é o pedido dela); sem template: sem_template", async () => {
    await db.insert(schema.settings).values({ key: "wa_enabled", value: true });
    await seedTemplate();
    const noOptIn = await createOrder({ marketingOptIn: false });
    // A prévia do cartão é do pedido dela, não é novidade nem oferta.
    expect(await sendGiftNoteWa(sdb, provider, storage, render, { orderId: noOptIn.orderId })).toMatchObject({
      sent: true,
    });
    expect(storage.has(giftNoteStoragePath(noOptIn.orderId))).toBe(true);

    await db.delete(schema.waTemplates);
    const created = await createOrder();
    expect(await sendGiftNoteWa(sdb, provider, storage, render, { orderId: created.orderId })).toEqual({
      skipped: "sem_template",
    });
  });
});
