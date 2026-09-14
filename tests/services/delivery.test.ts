// Entregue com foto: a foto vira o registro da entrega, o pedido vai a
// 'delivered' pela máquina de estados (preparing passa por shipped), a
// cliente recebe a foto com a legenda uma vez, e refazer só troca a foto.
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeFileStorage } from "@/adapters/storage/fake";
import { FakeMessagingProvider } from "@/adapters/zapi/fake";
import * as schema from "@/db/schema";
import { initialWaTemplates } from "@/db/seed-data";
import type { DbOrTx } from "@/queue/enqueue";
import {
  countOrdersAwaitingDelivery,
  deliverOrderWithPhoto,
  deliveryPhotoStoragePath,
  listOrdersAwaitingDelivery,
  sendDeliveredWa,
} from "@/services/delivery";
import { createStoreOrder, getPublicOrder, type CreateStoreOrderInput } from "@/services/store-orders";
import { createTestDb, createTestUser, createTestVariant, type TestDb } from "../helpers/db";

let db: TestDb;
let sdb: DbOrTx;
let close: () => Promise<void>;
let storage: FakeFileStorage;
let provider: FakeMessagingProvider;
let userId: string;

const VALID_CPF = "529.982.247-25";

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  sdb = db as unknown as DbOrTx;
  storage = new FakeFileStorage();
  provider = new FakeMessagingProvider();
  userId = (await createTestUser(db)).id;
  await db.insert(schema.settings).values({ key: "wa_enabled", value: true });
  const template = initialWaTemplates.find((row) => row.key === "order_delivered");
  if (!template) throw new Error("template order_delivered ausente no seed");
  await db.insert(schema.waTemplates).values({ key: template.key, label: template.label, bodyTemplate: template.bodyTemplate, variables: template.variables });
});

afterEach(async () => {
  await close();
});

async function cameraPhoto(): Promise<Uint8Array> {
  return sharp({ create: { width: 2400, height: 1600, channels: 3, background: "#c0a050" } })
    .jpeg({ quality: 90 })
    .withMetadata({ exif: { IFD0: { ImageDescription: "rua tal, 100" } } })
    .toBuffer();
}

async function createOrder(over: { marketingOptIn?: boolean; status?: string; paymentMethod?: "cash"; dispatched?: boolean } = {}): Promise<{ orderId: string; publicToken: string }> {
  const { variantId } = await createTestVariant(db, {
    sku: `VE-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
    costCents: 9000,
    onHand: 5,
    name: "Vestido Ébano",
  });
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
  const [rate] = await db.insert(schema.shippingRates).values({ name: "PAC", priceCents: 1990 }).returning({ id: schema.shippingRates.id });
  const input: CreateStoreOrderInput = {
    customer: { fullName: "Maria da Silva", document: VALID_CPF, phone: "(11) 99999-8888", email: "maria@example.com", marketingOptIn: over.marketingOptIn ?? true },
    address: { postalCode: "01310-100", street: "Avenida Paulista", number: "1000", district: "Bela Vista", city: "São Paulo", state: "SP" },
    items: [{ variantId, quantity: 1, expectedUnitPriceCents: 28900 }],
    shippingRateId: rate.id,
    expectedShippingCents: 1990,
    ...(over.paymentMethod ? { paymentMethod: over.paymentMethod } : {}),
  };
  const order = await createStoreOrder(sdb, input);
  await db
    .update(schema.orders)
    .set({
      status: over.status ?? "shipped",
      paidAt: new Date("2026-09-10T10:00:00-03:00"),
      shippedAt: over.status === "paid" || over.status === "preparing" ? null : new Date("2026-09-11T10:00:00-03:00"),
      ...(over.dispatched
        ? { deliveryWindow: { dayKey: "2026-09-13", start: "19:00", end: "21:00", cutoff: "13:00", rateName: "Motoboy", label: "hoje, 19h–21h", dispatchedAt: "2026-09-13T21:00:00.000Z" } }
        : {}),
    })
    .where(eq(schema.orders.id, order.orderId));
  return { orderId: order.orderId, publicToken: order.publicToken };
}

describe("deliverOrderWithPhoto", () => {
  it("enviado: processa a foto (sem EXIF), grava quem recebeu, vira 'delivered' e enfileira UM order.delivered", async () => {
    const { orderId, publicToken } = await createOrder();
    const result = await deliverOrderWithPhoto(sdb, storage, {
      orderId,
      photo: { data: await cameraPhoto(), contentType: "image/jpeg" },
      receivedBy: "maria aparecida",
      userId,
    });
    expect(result).toMatchObject({ status: "delivered", receivedBy: "Maria", rephoto: false, deliveredPhotoPath: deliveryPhotoStoragePath(orderId) });

    const [order] = await db.select().from(schema.orders).where(eq(schema.orders.id, orderId));
    expect(order.status).toBe("delivered");
    expect(order.deliveredAt).not.toBeNull();
    expect(order.deliveryConfirmedBy).toBe("owner");
    const file = storage.get(deliveryPhotoStoragePath(orderId));
    expect(file).toBeDefined();
    const meta = await sharp(Buffer.from(file!.data)).metadata();
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(1200);
    expect(meta.exif).toBeUndefined();

    const events = await db.select().from(schema.outboxEvents).where(eq(schema.outboxEvents.eventType, "order.delivered"));
    expect(events).toHaveLength(1);

    // A página pública já mostra a foto e quem recebeu.
    const pub = await getPublicOrder(sdb, publicToken);
    expect(pub).toMatchObject({ deliveredPhotoPath: deliveryPhotoStoragePath(orderId), receivedBy: "Maria" });
  });

  it("pago para entrega em mãos vai direto a entregue; em separação com motoboy que saiu passa por enviado", async () => {
    const cash = await createOrder({ status: "paid", paymentMethod: "cash" });
    await deliverOrderWithPhoto(sdb, storage, { orderId: cash.orderId, photo: { data: await cameraPhoto(), contentType: "image/jpeg" }, userId });
    const [cashOrder] = await db.select().from(schema.orders).where(eq(schema.orders.id, cash.orderId));
    expect(cashOrder.status).toBe("delivered");
    expect(cashOrder.receivedBy).toBeNull();

    const moto = await createOrder({ status: "preparing", dispatched: true });
    await deliverOrderWithPhoto(sdb, storage, { orderId: moto.orderId, photo: { data: await cameraPhoto(), contentType: "image/jpeg" }, userId });
    const history = await db.select().from(schema.orderStatusHistory).where(eq(schema.orderStatusHistory.orderId, moto.orderId));
    expect(history.map((row) => row.toStatus).slice(-2)).toEqual(["shipped", "delivered"]);
  });

  it("recusa: em separação sem motoboy, pagamento pendente, arquivo que não é imagem — sem tocar no storage", async () => {
    const preparing = await createOrder({ status: "preparing" });
    await expect(deliverOrderWithPhoto(sdb, storage, { orderId: preparing.orderId, photo: { data: await cameraPhoto(), contentType: "image/jpeg" }, userId })).rejects.toThrow(
      "Só dá para registrar a entrega",
    );
    const pending = await createOrder({ status: "pending_payment" });
    await expect(deliverOrderWithPhoto(sdb, storage, { orderId: pending.orderId, photo: { data: await cameraPhoto(), contentType: "image/jpeg" }, userId })).rejects.toThrow(
      "Registre o pagamento",
    );
    const shipped = await createOrder();
    await expect(deliverOrderWithPhoto(sdb, storage, { orderId: shipped.orderId, photo: { data: new Uint8Array([1, 2, 3]), contentType: "text/plain" }, userId })).rejects.toThrow(
      "não é uma imagem",
    );
    expect(storage.list()).toEqual([]);
  });

  it("refazer a foto de um pedido entregue: troca o arquivo e o nome, sem segundo evento", async () => {
    const { orderId } = await createOrder();
    await deliverOrderWithPhoto(sdb, storage, { orderId, photo: { data: await cameraPhoto(), contentType: "image/jpeg" }, receivedBy: "Maria", userId });
    const again = await deliverOrderWithPhoto(sdb, storage, { orderId, photo: { data: await cameraPhoto(), contentType: "image/jpeg" }, receivedBy: "Portaria", userId });
    expect(again).toMatchObject({ rephoto: true, receivedBy: "Portaria", status: "delivered" });
    const events = await db.select().from(schema.outboxEvents).where(eq(schema.outboxEvents.eventType, "order.delivered"));
    expect(events).toHaveLength(1);
  });
});

describe("sendDeliveredWa", () => {
  it("manda a foto com a legenda 'entregue hoje às …, recebido por …' uma vez; a segunda é 'ja_enviado'", async () => {
    const { orderId } = await createOrder();
    await deliverOrderWithPhoto(sdb, storage, { orderId, photo: { data: await cameraPhoto(), contentType: "image/jpeg" }, receivedBy: "Maria", userId });
    const [order] = await db.select().from(schema.orders).where(eq(schema.orders.id, orderId));
    const result = await sendDeliveredWa(sdb, provider, storage, { orderId, now: order.deliveredAt as Date });
    expect(result).toMatchObject({ sent: true, withPhoto: true });
    expect(provider.sentImages).toHaveLength(1);
    expect(provider.sentImages[0].imageUrl).toContain(`memory://${deliveryPhotoStoragePath(orderId)}?v=`);
    expect(provider.sentImages[0].caption).toMatch(/foi entregue hoje às \d{2}:\d{2}, recebido por Maria/);
    expect(provider.sentImages[0].caption).toContain("responda SAIR");
    expect(await sendDeliveredWa(sdb, provider, storage, { orderId })).toEqual({ skipped: "ja_enviado" });
    expect(provider.sentImages).toHaveLength(1);
  });

  it("entregue sem foto (botão simples): só o texto; não entregue, sem opt-in ou sem template: pula", async () => {
    const { orderId } = await createOrder();
    await db.update(schema.orders).set({ status: "delivered", deliveredAt: new Date() }).where(eq(schema.orders.id, orderId));
    const text = await sendDeliveredWa(sdb, provider, storage, { orderId });
    expect(text).toMatchObject({ sent: true, withPhoto: false });
    expect(provider.sentMessages).toHaveLength(1);
    expect(provider.sentMessages[0].body).toMatch(/foi entregue hoje às \d{2}:\d{2} 🤎/);

    const shipped = await createOrder();
    expect(await sendDeliveredWa(sdb, provider, storage, { orderId: shipped.orderId })).toEqual({ skipped: "nao_entregue" });

    const noOptIn = await createOrder({ marketingOptIn: false });
    await db.update(schema.customers).set({ marketingOptIn: false });
    await deliverOrderWithPhoto(sdb, storage, { orderId: noOptIn.orderId, photo: { data: await cameraPhoto(), contentType: "image/jpeg" }, userId });
    expect(await sendDeliveredWa(sdb, provider, storage, { orderId: noOptIn.orderId })).toEqual({ skipped: "sem_opt_in" });
    await db.update(schema.customers).set({ marketingOptIn: true });

    await db.update(schema.waTemplates).set({ isActive: false }).where(eq(schema.waTemplates.key, "order_delivered"));
    const { orderId: other } = await createOrder();
    await deliverOrderWithPhoto(sdb, storage, { orderId: other, photo: { data: await cameraPhoto(), contentType: "image/jpeg" }, userId });
    expect(await sendDeliveredWa(sdb, provider, storage, { orderId: other })).toEqual({ skipped: "sem_template" });
  });
});

describe("listOrdersAwaitingDelivery", () => {
  it("enviados, pagos em dinheiro/motoboy e motoboy que saiu — os mais antigos primeiro; entregues com foto somem", async () => {
    const shipped = await createOrder();
    const cash = await createOrder({ status: "paid", paymentMethod: "cash" });
    const moto = await createOrder({ status: "preparing", dispatched: true });
    await createOrder({ status: "preparing" });
    await createOrder({ status: "paid" });
    const rows = await listOrdersAwaitingDelivery(sdb);
    expect(rows.map((row) => row.id).sort()).toEqual([shipped.orderId, cash.orderId, moto.orderId].sort());
    expect(rows.find((row) => row.id === moto.orderId)).toMatchObject({ isMotoboy: true, status: "preparing" });
    expect(await countOrdersAwaitingDelivery(sdb)).toBe(3);
    await deliverOrderWithPhoto(sdb, storage, { orderId: shipped.orderId, photo: { data: await cameraPhoto(), contentType: "image/jpeg" }, userId });
    expect(await countOrdersAwaitingDelivery(sdb)).toBe(2);
  });
});
