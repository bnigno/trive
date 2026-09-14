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
  confirmDeliveryByToken,
  confirmDeliveryForCustomer,
  countOrdersAwaitingDelivery,
  deliverOrderWithPhoto,
  deliveryPhotoStoragePath,
  lastShipmentMemoryLine,
  listOrdersAwaitingDelivery,
  listStaleShipments,
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

  it("recusa: em separação sem motoboy, pago pelos Correios na prateleira, pagamento pendente, arquivo que não é imagem — sem tocar no storage", async () => {
    const preparing = await createOrder({ status: "preparing" });
    await expect(deliverOrderWithPhoto(sdb, storage, { orderId: preparing.orderId, photo: { data: await cameraPhoto(), contentType: "image/jpeg" }, userId })).rejects.toThrow(
      "ainda não saiu",
    );
    const paidCorreios = await createOrder({ status: "paid" });
    await expect(deliverOrderWithPhoto(sdb, storage, { orderId: paidCorreios.orderId, photo: { data: await cameraPhoto(), contentType: "image/jpeg" }, userId })).rejects.toThrow(
      "ainda não saiu",
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

  it("refazer a foto de um pedido entregue: troca o arquivo e o nome, sem segundo evento; o ?v= muda", async () => {
    const { orderId, publicToken } = await createOrder();
    await deliverOrderWithPhoto(sdb, storage, { orderId, photo: { data: await cameraPhoto(), contentType: "image/jpeg" }, receivedBy: "Maria", userId });
    const before = (await getPublicOrder(sdb, publicToken))?.deliveredPhotoAt?.getTime();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const again = await deliverOrderWithPhoto(sdb, storage, { orderId, photo: { data: await cameraPhoto(), contentType: "image/jpeg" }, receivedBy: "Portaria", userId });
    expect(again).toMatchObject({ rephoto: true, alreadyDelivered: true, receivedBy: "Portaria", status: "delivered" });
    const events = await db.select().from(schema.outboxEvents).where(eq(schema.outboxEvents.eventType, "order.delivered"));
    expect(events).toHaveLength(1);
    const after = (await getPublicOrder(sdb, publicToken))?.deliveredPhotoAt?.getTime();
    expect(after).toBeGreaterThan(before as number);
  });

  it("primeira foto depois do 'marcar entregue' simples: não é 'refazer', mas o pedido já estava entregue", async () => {
    const { orderId } = await createOrder();
    await db.update(schema.orders).set({ status: "delivered", deliveredAt: new Date() }).where(eq(schema.orders.id, orderId));
    const result = await deliverOrderWithPhoto(sdb, storage, { orderId, photo: { data: await cameraPhoto(), contentType: "image/jpeg" }, receivedBy: "Maria", userId });
    expect(result).toMatchObject({ rephoto: false, alreadyDelivered: true, status: "delivered" });
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

  it("sem foto: 'marcar entregue' pelo rastreio não manda nada; confirmado pela cliente manda o texto sem hora; não entregue, sem opt-in ou sem template: pula", async () => {
    const { orderId } = await createOrder();
    await db.update(schema.orders).set({ status: "delivered", deliveredAt: new Date() }).where(eq(schema.orders.id, orderId));
    expect(await sendDeliveredWa(sdb, provider, storage, { orderId })).toEqual({ skipped: "sem_foto" });
    // Confirmado pela Lia: a resposta dela já é o aviso — nada sai pela fila.
    await db.update(schema.orders).set({ deliveryConfirmedBy: "lia" }).where(eq(schema.orders.id, orderId));
    expect(await sendDeliveredWa(sdb, provider, storage, { orderId })).toEqual({ skipped: "confirmado_pela_lia" });
    await db.update(schema.orders).set({ deliveryConfirmedBy: "customer" }).where(eq(schema.orders.id, orderId));
    const text = await sendDeliveredWa(sdb, provider, storage, { orderId });
    expect(text).toMatchObject({ sent: true, withPhoto: false });
    expect(provider.sentMessages).toHaveLength(1);
    expect(provider.sentMessages[0].body).toContain("foi entregue 🤎");
    expect(provider.sentMessages[0].body).not.toMatch(/às \d{2}:\d{2}/);

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
  it("enviados, pagos em dinheiro, motoboy que saiu (inclusive dinheiro a receber) — os mais antigos primeiro; motoboy pago que não saiu e Correios na prateleira ficam de fora", async () => {
    const shipped = await createOrder();
    const cash = await createOrder({ status: "paid", paymentMethod: "cash" });
    const moto = await createOrder({ status: "preparing", dispatched: true });
    const cashOut = await createOrder({ status: "pending_payment", paymentMethod: "cash", dispatched: true });
    await createOrder({ status: "preparing" });
    await createOrder({ status: "paid" });
    const motoNotOut = await createOrder({ status: "paid" });
    await db
      .update(schema.orders)
      .set({ deliveryWindow: { dayKey: "2026-09-20", start: "19:00", end: "21:00", cutoff: "13:00", rateName: "Motoboy", label: "sábado, 19h–21h" } })
      .where(eq(schema.orders.id, motoNotOut.orderId));
    const rows = await listOrdersAwaitingDelivery(sdb);
    expect(rows.map((row) => row.id).sort()).toEqual([shipped.orderId, cash.orderId, moto.orderId, cashOut.orderId].sort());
    expect(rows.find((row) => row.id === moto.orderId)).toMatchObject({ isMotoboy: true, status: "preparing", awaitingPayment: false });
    expect(rows.find((row) => row.id === cashOut.orderId)).toMatchObject({ awaitingPayment: true });
    expect(await countOrdersAwaitingDelivery(sdb)).toBe(4);
    await deliverOrderWithPhoto(sdb, storage, { orderId: shipped.orderId, photo: { data: await cameraPhoto(), contentType: "image/jpeg" }, userId });
    expect(await countOrdersAwaitingDelivery(sdb)).toBe(3);
  });
});

describe("confirmDeliveryByToken / confirmDeliveryForCustomer / listStaleShipments", () => {
  it("pela página: enviado vira entregue assinado pela cliente, uma vez; pago não vira; token inválido não acha", async () => {
    const { orderId, publicToken } = await createOrder();
    const first = await confirmDeliveryByToken(sdb, { publicToken });
    expect(first).toEqual({ ok: true, orderId, orderNumber: expect.any(Number), already: false });
    const [order] = await db.select().from(schema.orders).where(eq(schema.orders.id, orderId));
    expect(order.status).toBe("delivered");
    expect(order.deliveryConfirmedBy).toBe("customer");
    expect(order.deliveredPhotoPath).toBeNull();
    expect(await confirmDeliveryByToken(sdb, { publicToken })).toMatchObject({ ok: true, already: true });
    expect(await db.select().from(schema.outboxEvents).where(eq(schema.outboxEvents.eventType, "order.delivered"))).toHaveLength(1);
    const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "order.delivery_confirmed"));
    expect(audits).toHaveLength(1);
    expect(audits[0].after).toMatchObject({ source: "customer" });

    const paid = await createOrder({ status: "paid" });
    expect(await confirmDeliveryByToken(sdb, { publicToken: paid.publicToken })).toMatchObject({ ok: false, reason: "nao_enviado", status: "paid" });
    expect(await confirmDeliveryByToken(sdb, { publicToken: "00000000-0000-4000-8000-000000000001" })).toEqual({ ok: false, reason: "nao_encontrado" });
  });

  it("pela Lia: só pedidos da cliente; dois enviados sem número é ambíguo; com número, aquele; um só, ele; assina 'lia'; nenhum enviado → o entregue mais recente", async () => {
    const a = await createOrder();
    const b = await createOrder();
    const [orderA] = await db.select().from(schema.orders).where(eq(schema.orders.id, a.orderId));
    const [orderB] = await db.select().from(schema.orders).where(eq(schema.orders.id, b.orderId));
    const customerId = orderA.customerId as string;
    // Dois enviados: a Lia pergunta qual.
    expect(await confirmDeliveryForCustomer(sdb, { customerId, source: "lia" })).toEqual({ ok: false, reason: "ambiguo", orderNumbers: expect.arrayContaining([orderA.orderNumber, orderB.orderNumber]) });
    const byNumber = await confirmDeliveryForCustomer(sdb, { customerId, orderNumber: orderA.orderNumber, source: "lia" });
    expect(byNumber).toMatchObject({ ok: true, orderId: a.orderId });
    const [afterA] = await db.select().from(schema.orders).where(eq(schema.orders.id, a.orderId));
    expect(afterA.deliveryConfirmedBy).toBe("lia");
    // Sobrou um enviado: sem número, é ele.
    const single = await confirmDeliveryForCustomer(sdb, { customerId, source: "lia" });
    expect(single).toMatchObject({ ok: true, orderId: b.orderId, already: false });
    // Nenhum enviado: o entregue mais recente responde "já estava entregue".
    expect(await confirmDeliveryForCustomer(sdb, { customerId, source: "lia" })).toMatchObject({ ok: true, already: true });
    expect(await confirmDeliveryForCustomer(sdb, { customerId, orderNumber: orderB.orderNumber + 100, source: "lia" })).toEqual({ ok: false, reason: "nao_encontrado" });
    // Outra cliente não enxerga estes pedidos.
    expect(await confirmDeliveryForCustomer(sdb, { customerId: "00000000-0000-4000-8000-000000000002", source: "lia" })).toEqual({ ok: false, reason: "nao_encontrado" });
  });

  it("enviados há 7+ dias sem confirmação, os mais antigos primeiro; entregue some", async () => {
    const old = await createOrder();
    const older = await createOrder();
    const fresh = await createOrder();
    await db.update(schema.orders).set({ shippedAt: new Date("2026-09-01T10:00:00Z") }).where(eq(schema.orders.id, old.orderId));
    await db.update(schema.orders).set({ shippedAt: new Date("2026-08-20T10:00:00Z") }).where(eq(schema.orders.id, older.orderId));
    await db.update(schema.orders).set({ shippedAt: new Date("2026-09-12T10:00:00Z") }).where(eq(schema.orders.id, fresh.orderId));
    const now = new Date("2026-09-13T10:00:00Z");
    const stale = await listStaleShipments(sdb, { now });
    expect(stale.map((row) => row.id)).toEqual([older.orderId, old.orderId]);
    expect(stale[0].days).toBe(24);
    await confirmDeliveryByToken(sdb, { publicToken: older.publicToken });
    expect((await listStaleShipments(sdb, { now })).map((row) => row.id)).toEqual([old.orderId]);
  });

  it("a linha do caderninho fala do último pedido enviado e some quando entregue", async () => {
    const { orderId, publicToken } = await createOrder();
    const [order] = await db.select().from(schema.orders).where(eq(schema.orders.id, orderId));
    const line = await lastShipmentMemoryLine(sdb, order.customerId as string);
    expect(line).toContain(`Último pedido: #${order.orderNumber} (enviado em 11/09)`);
    expect(line).toContain("chame confirmar_entrega.");
    // Dois enviados: a linha lista os dois e manda perguntar qual.
    const second = await createOrder();
    const two = await lastShipmentMemoryLine(sdb, order.customerId as string);
    expect(two).toContain("Pedidos enviados: #");
    expect(two).toContain("pergunte QUAL");
    await confirmDeliveryByToken(sdb, { publicToken });
    await confirmDeliveryByToken(sdb, { publicToken: second.publicToken });
    expect(await lastShipmentMemoryLine(sdb, order.customerId as string)).toBeNull();
  });
});
