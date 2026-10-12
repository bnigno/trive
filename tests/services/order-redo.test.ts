// "Refazer pedido" (service): o antigo vira "substituído", nasce um número
// novo com as mudanças e estoque/cupom passam direto — numa transação só.
// Réplicas dos casos reais (#1030 tirar o crédito de troca, #1020 passar
// para dinheiro), troca de tamanho de peça única, recusas que não mudam nada,
// a cadeia #A → #B → #C, os avisos e o pagamento que cai no link antigo.
import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import sharp from "sharp";

import { FakePaymentGateway } from "@/adapters/mercadopago/fake";
import { FakeFileStorage } from "@/adapters/storage/fake";
import { FakeMessagingProvider } from "@/adapters/zapi/fake";
import { SUPERSEDED_CANCEL_REASON } from "@/core/orders/reasons";
import * as schema from "@/db/schema";
import { formatCentsBRL } from "@/lib/money";
import { loadOrderWaContext } from "@/queue/handlers/wa-helpers";
import type { DbOrTx } from "@/queue/enqueue";
import { sendGiftNoteWa } from "@/services/gifts";
import { notifyOwnerPaidCanceledOrder, sendOrderCanceledWa } from "@/services/order-notices";
import { getRedoFormData, loadRedoAudit, quoteRedoDelivery, redoNoticeVars, redoPendingOrder } from "@/services/order-redo";
import { findLatestReplacement, getOrderReplacementLinks } from "@/services/order-replacements";
import { processPaymentEvent } from "@/services/payments";
import { createStoreOrder, getPublicOrder, type CreateStoreOrderInput } from "@/services/store-orders";
import { FIXED_USER_ID, createTestDb, type TestDb } from "../helpers/db";

let db: TestDb;
let close: () => Promise<void>;
let sdb: DbOrTx;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  sdb = db as unknown as DbOrTx;
  // A conversa da Sabrina com a Lia (o refazer da Lia só vale para o pedido dela).
  const [conversation] = await db.insert(schema.waConversations).values({ phoneE164: "+5591988887777" }).returning({ id: schema.waConversations.id });
  LIA = { type: "lia", conversationId: conversation.id };
});

afterEach(async () => {
  await close();
});

const MORNING = new Date("2026-10-12T13:00:00Z"); // 10:00 SP, segunda 12/10
const LATER = new Date("2026-10-12T14:30:00Z"); // 11:30 SP — antes da hora-limite (12:00)
const WINDOW = { dayKey: "2026-10-12", start: "14:00", end: "18:00", cutoff: "12:00" };
let LIA: { type: "lia"; conversationId: string };
const TEAM = { type: "user" as const, userId: FIXED_USER_ID };
const CREDIT = "SABRINA-HN5U7";

async function addVariant(productId: string, sku: string, size: string, onHand: number, priceCents = 5998): Promise<string> {
  const [variant] = await db
    .insert(schema.productVariants)
    .values({ productId, sku, costCents: 2000, attributes: { tamanho: size }, weightGrams: 300 })
    .returning({ id: schema.productVariants.id });
  await db.insert(schema.stockLevels).values({ productVariantId: variant.id, onHand, reserved: 0 });
  await db.insert(schema.priceVersions).values({
    productVariantId: variant.id,
    versionNumber: 1,
    status: "active",
    priceCents,
    origin: "initial",
    breakdown: {},
    costSnapshotCents: 2000,
    computedMarginRate: "0.3000",
    activatedAt: new Date("2026-10-01T00:00:00Z"),
  });
  return variant.id;
}

/** Vestido Amora (peça única em M e G, P esgotado), motoboy em Belém e o crédito de troca da Sabrina. */
async function setupStore() {
  const [product] = await db
    .insert(schema.products)
    .values({ name: "Vestido Amora", slug: "vestido-amora", status: "active", attributesSchema: ["tamanho"] })
    .returning({ id: schema.products.id });
  const m = await addVariant(product.id, "AMORA-M", "M", 1);
  const g = await addVariant(product.id, "AMORA-G", "G", 1);
  const p = await addVariant(product.id, "AMORA-P", "P", 0);
  const [rate] = await db
    .insert(schema.shippingRates)
    .values({
      name: "Motoboy Belém",
      priceCents: 1000,
      kind: "motoboy",
      cepStart: "66000000",
      cepEnd: "66999999",
      deliveryWindows: [{ start: "14:00", end: "18:00", cutoff: "12:00" }],
      deliveryDaysMin: 0,
      deliveryDaysMax: 0,
    })
    .returning({ id: schema.shippingRates.id });
  await db.insert(schema.coupons).values({
    code: CREDIT,
    type: "fixed",
    value: 4950,
    maxUses: 1,
    origin: "troca",
    expiresAt: new Date("2026-12-31T00:00:00Z"),
  });
  return { productId: product.id, m, g, p, rateId: rate.id };
}

function orderInput(store: { m: string; rateId: string }, over: Partial<CreateStoreOrderInput> = {}): CreateStoreOrderInput {
  return {
    channel: "whatsapp",
    paymentMethod: "online",
    customer: { fullName: "Sabrina Costa", document: "529.982.247-25", phone: "(91) 98888-7777", marketingOptIn: true },
    address: { postalCode: "66010-000", street: "Rua dos Mundurucus", number: "100", district: "Batista Campos", city: "Belém", state: "PA" },
    items: [{ variantId: store.m, quantity: 1, expectedUnitPriceCents: 5998 }],
    shippingRateId: store.rateId,
    expectedShippingCents: 1000,
    deliveryWindow: WINDOW,
    couponCode: CREDIT,
    ...over,
  };
}

async function orderRow(orderId: string) {
  const [row] = await db.select().from(schema.orders).where(eq(schema.orders.id, orderId));
  return row;
}

async function level(variantId: string) {
  const [row] = await db.select().from(schema.stockLevels).where(eq(schema.stockLevels.productVariantId, variantId));
  return { onHand: row.onHand, reserved: row.reserved };
}

async function coupon() {
  const [row] = await db.select().from(schema.coupons).where(eq(schema.coupons.code, CREDIT));
  return row;
}

describe("redoPendingOrder — os casos reais", () => {
  it("#1030: tirar o crédito de troca — o antigo vira 'substituído', o crédito volta a valer, o estoque passa para o novo e a entrega fica", async () => {
    const store = await setupStore();
    const a = await createStoreOrder(sdb, orderInput(store), { now: MORNING });
    expect((await orderRow(a.orderId)).totalCents).toBe(5998 + 1000 - 4950);
    expect((await coupon()).usedCount).toBe(1);

    const result = await redoPendingOrder(sdb, { orderId: a.orderId, changes: { coupon: { kind: "remove" } }, actor: LIA }, { now: LATER });

    const old = await orderRow(a.orderId);
    expect(old).toMatchObject({ status: "canceled", cancelReason: SUPERSEDED_CANCEL_REASON, replacedByOrderId: result.newOrderId });
    const fresh = await orderRow(result.newOrderId);
    expect(fresh).toMatchObject({
      status: "pending_payment",
      channel: "whatsapp",
      customerId: old.customerId,
      couponCode: null,
      discountCents: 0,
      shippingCents: 1000,
      totalCents: 5998 + 1000,
    });
    expect(fresh.orderNumber).toBeGreaterThan(old.orderNumber);
    expect(fresh.deliveryWindow).toMatchObject({ ...WINDOW, rateName: "Motoboy Belém" });
    expect(result.changes).toEqual([`cupom ${CREDIT} retirado`]);

    // O crédito voltou a valer (uso único liberado) e a peça única segue reservada — agora pelo novo.
    expect((await coupon()).usedCount).toBe(0);
    const redemptions = await db.select().from(schema.couponRedemptions).where(isNull(schema.couponRedemptions.releasedAt));
    expect(redemptions).toHaveLength(0);
    expect(await level(store.m)).toEqual({ onHand: 1, reserved: 1 });

    expect(await loadRedoAudit(sdb, a.orderId)).toEqual({ changes: [`cupom ${CREDIT} retirado`], actor: "lia" });
  });

  it("#1020: passar para dinheiro na entrega — o cupom mantido vale como na data do pedido antigo, mesmo vencido depois", async () => {
    const store = await setupStore();
    const a = await createStoreOrder(sdb, orderInput(store), { now: MORNING });
    await db.update(schema.orders).set({ createdAt: MORNING }).where(eq(schema.orders.id, a.orderId));
    // O crédito venceu às 11h — depois do pedido, antes do refazer.
    await db.update(schema.coupons).set({ expiresAt: new Date("2026-10-12T14:00:00Z") }).where(eq(schema.coupons.code, CREDIT));

    const result = await redoPendingOrder(sdb, { orderId: a.orderId, changes: { paymentMethod: "cash" }, actor: LIA }, { now: LATER });

    expect(await orderRow(result.newOrderId)).toMatchObject({ paymentMethod: "cash", couponCode: CREDIT, discountCents: 4950 });
    expect((await coupon()).usedCount).toBe(1);
    expect(result.changes).toEqual(["pagamento: dinheiro na entrega"]);
  });

  it("trocar M por G (peças únicas): a M volta para a prateleira e a G fica reservada; G esgotada não muda nada", async () => {
    const store = await setupStore();
    const a = await createStoreOrder(sdb, orderInput(store, { couponCode: undefined }), { now: MORNING });

    // P esgotado: recusa e o #A fica intacto (estoque, status, numeração).
    await expect(
      redoPendingOrder(sdb, { orderId: a.orderId, changes: { items: [{ variantId: store.p, quantity: 1 }] }, actor: LIA }, { now: LATER }),
    ).rejects.toThrow();
    expect(await orderRow(a.orderId)).toMatchObject({ status: "pending_payment", replacedByOrderId: null });
    expect(await level(store.m)).toEqual({ onHand: 1, reserved: 1 });
    expect(await db.select().from(schema.orders)).toHaveLength(1);

    const result = await redoPendingOrder(sdb, { orderId: a.orderId, changes: { items: [{ sku: "amora-g", quantity: 1 }] }, actor: LIA }, { now: LATER });
    expect(await level(store.m)).toEqual({ onHand: 1, reserved: 0 });
    expect(await level(store.g)).toEqual({ onHand: 1, reserved: 1 });
    expect(result.changes).toEqual([`peças: 1× Vestido Amora (G) por ${formatCentsBRL(5998)}`]);
  });
});

describe("redoPendingOrder — recusas que não mudam nada", () => {
  it("nada muda (inclusive repetir o que já é): REDO_NO_CHANGES — a nova tentativa da Lia não duplica o pedido", async () => {
    const store = await setupStore();
    const a = await createStoreOrder(sdb, orderInput(store), { now: MORNING });
    await expect(
      redoPendingOrder(sdb, { orderId: a.orderId, changes: { coupon: { kind: "code", code: CREDIT.toLowerCase() } }, actor: LIA }, { now: LATER }),
    ).rejects.toMatchObject({ code: "REDO_NO_CHANGES" });

    await redoPendingOrder(sdb, { orderId: a.orderId, changes: { coupon: { kind: "remove" } }, actor: LIA }, { now: LATER });
    await expect(
      redoPendingOrder(sdb, { orderId: a.orderId, changes: { coupon: { kind: "remove" } }, actor: LIA }, { now: LATER }),
    ).rejects.toMatchObject({ code: "REDO_NOT_ALLOWED", message: expect.stringContaining("já foi refeito") });
    expect(await db.select().from(schema.orders)).toHaveLength(2);
  });

  it("pago, embalado ou numa saída: recusa com o porquê", async () => {
    const store = await setupStore();
    const a = await createStoreOrder(sdb, orderInput(store, { couponCode: undefined }), { now: MORNING });
    await db.update(schema.orders).set({ packagePhotoPath: "pacotes/a.jpg" }).where(eq(schema.orders.id, a.orderId));
    await expect(
      redoPendingOrder(sdb, { orderId: a.orderId, changes: { paymentMethod: "cash" }, actor: TEAM }, { now: LATER }),
    ).rejects.toMatchObject({ code: "REDO_NOT_ALLOWED", message: expect.stringContaining("já foi embalado") });

    await db.update(schema.orders).set({ packagePhotoPath: null, status: "paid" }).where(eq(schema.orders.id, a.orderId));
    await expect(
      redoPendingOrder(sdb, { orderId: a.orderId, changes: { paymentMethod: "cash" }, actor: TEAM }, { now: LATER }),
    ).rejects.toMatchObject({ code: "REDO_NOT_ALLOWED", message: expect.stringContaining("não está aguardando pagamento") });
  });

  it("pagamento em andamento no Mercado Pago: a Lia nunca passa; a equipe passa depois de conferir", async () => {
    const store = await setupStore();
    const a = await createStoreOrder(sdb, orderInput(store, { couponCode: undefined }), { now: MORNING });
    await db.update(schema.orders).set({ mpPaymentId: "mp-123" }).where(eq(schema.orders.id, a.orderId));

    await expect(
      redoPendingOrder(sdb, { orderId: a.orderId, changes: { paymentMethod: "cash" }, actor: LIA, allowPaymentAttempt: true }, { now: LATER }),
    ).rejects.toMatchObject({ code: "REDO_NOT_ALLOWED", message: expect.stringContaining("Mercado Pago") });
    await expect(
      redoPendingOrder(sdb, { orderId: a.orderId, changes: { paymentMethod: "cash" }, actor: TEAM }, { now: LATER }),
    ).rejects.toMatchObject({ code: "REDO_NOT_ALLOWED" });

    const result = await redoPendingOrder(sdb, { orderId: a.orderId, changes: { paymentMethod: "cash" }, actor: TEAM, allowPaymentAttempt: true }, { now: LATER });
    expect(await orderRow(result.newOrderId)).toMatchObject({ paymentMethod: "cash", mpPaymentId: null });
  });

  it("preço subiu desde o pedido: recusa e o antigo continua valendo; com o preço de hoje, refaz", async () => {
    const store = await setupStore();
    const a = await createStoreOrder(sdb, orderInput(store, { couponCode: undefined }), { now: MORNING });
    await db.update(schema.priceVersions).set({ priceCents: 6998 }).where(eq(schema.priceVersions.productVariantId, store.m));

    await expect(
      redoPendingOrder(sdb, { orderId: a.orderId, changes: { paymentMethod: "cash" }, actor: LIA }, { now: LATER }),
    ).rejects.toMatchObject({ code: "REDO_PRICE_CHANGED", message: expect.stringContaining("continua valendo") });
    expect(await orderRow(a.orderId)).toMatchObject({ status: "pending_payment" });

    const result = await redoPendingOrder(
      sdb,
      { orderId: a.orderId, changes: { paymentMethod: "cash", items: [{ variantId: store.m, quantity: 1, expectedUnitPriceCents: 6998 }] }, actor: LIA },
      { now: LATER },
    );
    expect(await orderRow(result.newOrderId)).toMatchObject({ subtotalCents: 6998 });
  });

  it("a janela combinada é de um dia que já passou: pede escolher outra entrega", async () => {
    const store = await setupStore();
    const a = await createStoreOrder(sdb, orderInput(store, { couponCode: undefined }), { now: MORNING });
    // Prazo de pagamento ainda de pé (Pix manual estendido, por exemplo); a janela é que ficou para trás.
    await db.update(schema.orders).set({ paymentDueAt: new Date("2026-10-14T00:00:00Z") }).where(eq(schema.orders.id, a.orderId));
    await expect(
      redoPendingOrder(sdb, { orderId: a.orderId, changes: { paymentMethod: "cash" }, actor: LIA }, { now: new Date("2026-10-13T13:00:00Z") }),
    ).rejects.toMatchObject({ code: "REDO_WINDOW_PAST" });
  });
});

describe("redoPendingOrder — entrega escolhida de novo, cadeia e o painel", () => {
  it("a equipe cota e escolhe outra janela: o frete e a janela vêm da cotação de agora", async () => {
    const store = await setupStore();
    const a = await createStoreOrder(sdb, orderInput(store, { couponCode: undefined }), { now: MORNING });
    const afterCutoff = new Date("2026-10-12T16:00:00Z"); // 13h SP: a janela de hoje fechou, a próxima é amanhã
    const options = await quoteRedoDelivery(sdb, { orderId: a.orderId }, { now: afterCutoff });
    expect(options).toEqual([{ optionKey: `${store.rateId}:2026-10-13:14:00`, label: expect.stringContaining("Motoboy Belém"), priceCents: 1000 }]);

    const result = await redoPendingOrder(
      sdb,
      { orderId: a.orderId, changes: { delivery: { kind: "option", optionKey: options[0].optionKey } }, actor: TEAM },
      { now: afterCutoff },
    );
    expect((await orderRow(result.newOrderId)).deliveryWindow).toMatchObject({ dayKey: "2026-10-13", start: "14:00" });
    expect(result.changes[0]).toMatch(/^entrega: Motoboy Belém/);

    await expect(
      redoPendingOrder(sdb, { orderId: result.newOrderId, changes: { delivery: { kind: "option", optionKey: "sumiu" } }, actor: TEAM }, { now: afterCutoff }),
    ).rejects.toMatchObject({ code: "REDO_DELIVERY_GONE" });
  });

  it("#A → #B → #C: a página pública do #A leva ao #C; o painel liga os dois lados", async () => {
    const store = await setupStore();
    const a = await createStoreOrder(sdb, orderInput(store), { now: MORNING });
    const b = await redoPendingOrder(sdb, { orderId: a.orderId, changes: { coupon: { kind: "remove" } }, actor: LIA }, { now: LATER });
    const c = await redoPendingOrder(sdb, { orderId: b.newOrderId, changes: { paymentMethod: "cash" }, actor: TEAM }, { now: LATER });

    expect(await findLatestReplacement(sdb, a.orderId)).toMatchObject({ id: c.newOrderId, orderNumber: c.newOrderNumber, status: "pending_payment" });
    expect(await findLatestReplacement(sdb, c.newOrderId)).toBeNull();
    const pub = await getPublicOrder(sdb, a.publicToken);
    expect(pub?.replacedBy).toEqual({ orderNumber: c.newOrderNumber, publicToken: c.publicToken, status: "pending_payment" });

    const links = await getOrderReplacementLinks(sdb, await orderRow(b.newOrderId));
    expect(links).toEqual({ replacedBy: { id: c.newOrderId, orderNumber: c.newOrderNumber }, replaces: { id: a.orderId, orderNumber: a.orderNumber } });
  });

  it("o card do painel: tamanhos da mesma peça com o disponível contando o que o pedido segura; bloqueio explicado", async () => {
    const store = await setupStore();
    const a = await createStoreOrder(sdb, orderInput(store), { now: MORNING });
    const data = await getRedoFormData(sdb, a.orderId);
    expect(data).toMatchObject({ orderNumber: a.orderNumber, blockers: [], couponCode: CREDIT, paymentMethod: "online", gift: null });
    expect(data?.keptDeliveryLabel).toContain("Motoboy Belém");
    const siblings = Object.fromEntries((data?.lines[0].siblings ?? []).map((s) => [s.label, s.available]));
    expect(siblings).toEqual({ M: 1, G: 1, P: 0 });

    await db.update(schema.orders).set({ mpPaymentId: "mp-1" }).where(eq(schema.orders.id, a.orderId));
    expect((await getRedoFormData(sdb, a.orderId))?.blockers).toEqual([{ message: expect.stringContaining("Mercado Pago"), overridable: true }]);
  });
});

describe("os avisos do pedido refeito", () => {
  it("o antigo não manda 'cancelado'; o novo sabe que substitui o antigo (pedido_anterior)", async () => {
    const store = await setupStore();
    await db.insert(schema.settings).values([{ key: "wa_enabled", value: true }]);
    await db.insert(schema.waTemplates).values({
      key: "order_canceled",
      label: "Pedido cancelado",
      bodyTemplate: "{{nome}}, o pedido #{{pedido}} foi cancelado: {{motivo}}.",
      variables: ["nome", "pedido", "motivo"],
    });
    const a = await createStoreOrder(sdb, orderInput(store), { now: MORNING });
    const b = await redoPendingOrder(sdb, { orderId: a.orderId, changes: { coupon: { kind: "remove" } }, actor: LIA }, { now: LATER });

    const provider = new FakeMessagingProvider();
    expect(await sendOrderCanceledWa(sdb, provider, { orderId: a.orderId })).toEqual({ skipped: "substituido" });
    expect(provider.sentMessages).toHaveLength(0);

    const ctx = await loadOrderWaContext(sdb, b.newOrderId);
    expect(ctx?.replaces).toEqual({ id: a.orderId, orderNumber: a.orderNumber });
    expect(ctx?.vars.pedido_anterior).toBe(String(a.orderNumber));
    expect((await loadOrderWaContext(sdb, a.orderId))?.replaces).toBeNull();
  });

  it("pagaram o link antigo: a dona é avisada uma vez, com o caminho (estornar e mandar o link do novo)", async () => {
    const store = await setupStore();
    const gateway = new FakePaymentGateway();
    const a = await createStoreOrder(sdb, orderInput(store, { couponCode: undefined }), { now: MORNING });
    const pref = await gateway.createCheckoutPreference({
      orderId: a.orderId,
      orderNumber: a.orderNumber,
      externalReference: a.orderId,
      items: [{ title: "Pedido", quantity: 1, unitPriceCents: a.totalCents }],
      backUrl: "https://trivemaison.com.br/pedido/token",
    });
    const b = await redoPendingOrder(sdb, { orderId: a.orderId, changes: { paymentMethod: "cash" }, actor: LIA }, { now: LATER });

    const paymentId = gateway.paymentIdForPreference(pref.preferenceId);
    gateway.approvePayment(paymentId);
    expect(await processPaymentEvent(sdb, gateway, { mpPaymentId: paymentId })).toEqual({ orderId: a.orderId, action: "paid_canceled_flagged" });
    await processPaymentEvent(sdb, gateway, { mpPaymentId: paymentId });
    const events = await db
      .select()
      .from(schema.outboxEvents)
      .where(and(eq(schema.outboxEvents.eventType, "payment.approved_on_canceled"), eq(schema.outboxEvents.aggregateId, a.orderId)));
    expect(events).toHaveLength(1);
    expect(await db.select().from(schema.outboxEvents).where(eq(schema.outboxEvents.eventType, "mp.amount_divergent"))).toHaveLength(0);

    // A dona estorna no Mercado Pago: a taxa pendente desse pagamento cai junto.
    const feeOf = async () =>
      (await db.select().from(schema.financialEntries).where(and(eq(schema.financialEntries.orderId, a.orderId), eq(schema.financialEntries.category, "mp_fee"))))[0];
    expect((await feeOf())?.status).toBe("pending");
    await gateway.refundPayment(paymentId);
    await processPaymentEvent(sdb, gateway, { mpPaymentId: paymentId });
    expect((await feeOf())?.status).toBe("canceled");

    await db.insert(schema.settings).values([
      { key: "wa_enabled", value: true },
      { key: "owner_whatsapp_phone", value: "+5591999990000" },
    ]);
    await db.insert(schema.waTemplates).values({
      key: "owner_paid_canceled_order",
      label: "[interno] Pagamento num pedido cancelado",
      bodyTemplate: "#{{pedido}} — {{cliente}} pagou {{pago}}. {{orientacao}}",
      variables: ["pedido", "cliente", "pago", "orientacao"],
    });
    const provider = new FakeMessagingProvider();
    await notifyOwnerPaidCanceledOrder(sdb, provider, { orderId: a.orderId, paidCents: a.totalCents });
    expect(provider.sentMessages).toHaveLength(1);
    expect(provider.sentMessages[0].body).toContain(`agora é o #${b.newOrderNumber}, ainda aguardando pagamento`);
  });

  it("presente com o mesmo bilhete: a imagem do novo é publicada para imprimir, mas a prévia não vai de novo; bilhete novo vai", async () => {
    const store = await setupStore();
    await db.insert(schema.settings).values([{ key: "wa_enabled", value: true }]);
    await db.insert(schema.waTemplates).values({
      key: "gift_note_preview",
      label: "Bilhete",
      bodyTemplate: "{{nome}}, o bilhete para {{para}} ficou assim",
      variables: ["nome", "para"],
    });
    const storage = new FakeFileStorage();
    const provider = new FakeMessagingProvider();
    const render = async () => sharp({ create: { width: 10, height: 10, channels: 3, background: "#ffffff" } }).png().toBuffer();
    const a = await createStoreOrder(sdb, orderInput(store, { gift: { recipientName: "Ana", message: "Parabéns" } }), { now: MORNING });
    expect(await sendGiftNoteWa(sdb, provider, storage, render, { orderId: a.orderId })).toHaveProperty("sent");

    const b = await redoPendingOrder(sdb, { orderId: a.orderId, changes: { coupon: { kind: "remove" } }, actor: LIA }, { now: LATER });
    expect(await sendGiftNoteWa(sdb, provider, storage, render, { orderId: b.newOrderId })).toEqual({ skipped: "bilhete_igual" });
    expect((await orderRow(b.newOrderId)).giftNotePath).toBe(`gifts/${b.newOrderId}/bilhete.jpg`);

    const c = await redoPendingOrder(
      sdb,
      { orderId: b.newOrderId, changes: { gift: { kind: "set", recipientName: "Ana", message: "Feliz aniversário" } }, actor: LIA },
      { now: LATER },
    );
    expect(await sendGiftNoteWa(sdb, provider, storage, render, { orderId: c.newOrderId })).toHaveProperty("sent");
    expect(provider.sentImages).toHaveLength(2);
    // #C → #D com o mesmo bilhete do #C: a prévia do #C saiu, a do #D não vai; a do #C (agora cancelado) também não sai de novo.
    const d = await redoPendingOrder(sdb, { orderId: c.newOrderId, changes: { paymentMethod: "cash" }, actor: LIA }, { now: LATER });
    expect(await sendGiftNoteWa(sdb, provider, storage, render, { orderId: d.newOrderId })).toEqual({ skipped: "bilhete_igual" });
    expect(await sendGiftNoteWa(sdb, provider, storage, render, { orderId: b.newOrderId })).toEqual({ skipped: "pedido_cancelado" });
  });
});

describe("redoPendingOrder — depois da revisão", () => {
  it("a Lia não refaz pedido de outra cliente", async () => {
    const store = await setupStore();
    const a = await createStoreOrder(sdb, orderInput(store, { couponCode: undefined }), { now: MORNING });
    const [other] = await db.insert(schema.waConversations).values({ phoneE164: "+5591977776666" }).returning({ id: schema.waConversations.id });
    await expect(
      redoPendingOrder(sdb, { orderId: a.orderId, changes: { paymentMethod: "cash" }, actor: { type: "lia", conversationId: other.id } }, { now: LATER }),
    ).rejects.toMatchObject({ code: "REDO_NOT_YOURS" });
    expect(await orderRow(a.orderId)).toMatchObject({ status: "pending_payment" });
  });

  it("refeito duas vezes: o cupom mantido vale como no PRIMEIRO pedido, não no do meio", async () => {
    const store = await setupStore();
    const a = await createStoreOrder(sdb, orderInput(store), { now: MORNING });
    await db.update(schema.orders).set({ createdAt: MORNING }).where(eq(schema.orders.id, a.orderId));
    await db.update(schema.coupons).set({ expiresAt: new Date("2026-10-12T14:00:00Z") }).where(eq(schema.coupons.code, CREDIT));
    const b = await redoPendingOrder(sdb, { orderId: a.orderId, changes: { paymentMethod: "cash" }, actor: LIA }, { now: LATER });
    // O #B nasce DEPOIS do vencimento do cupom; o #C ainda vale pela data do #A.
    await db.update(schema.orders).set({ createdAt: LATER }).where(eq(schema.orders.id, b.newOrderId));
    const c = await redoPendingOrder(sdb, { orderId: b.newOrderId, changes: { paymentMethod: "online" }, actor: LIA }, { now: LATER });
    expect(await orderRow(c.newOrderId)).toMatchObject({ couponCode: CREDIT, discountCents: 4950 });
  });

  it("trocar de tamanho: a peça nova entra pelo preço de hoje, e o resumo que vai para ela diz o preço", async () => {
    const store = await setupStore();
    const a = await createStoreOrder(sdb, orderInput(store, { couponCode: undefined }), { now: MORNING });
    await db.update(schema.priceVersions).set({ priceCents: 6998 });
    // A MESMA peça com preço novo trava; o outro tamanho foi escolhido agora, pelo preço que aparece.
    await expect(
      redoPendingOrder(sdb, { orderId: a.orderId, changes: { paymentMethod: "cash" }, actor: TEAM }, { now: LATER }),
    ).rejects.toMatchObject({ code: "REDO_PRICE_CHANGED" });
    const result = await redoPendingOrder(sdb, { orderId: a.orderId, changes: { items: [{ variantId: store.g, quantity: 1 }] }, actor: TEAM }, { now: LATER });
    expect(await orderRow(result.newOrderId)).toMatchObject({ subtotalCents: 6998 });
    expect(result.changes).toEqual([`peças: 1× Vestido Amora (G) por ${formatCentsBRL(6998)}`]);
  });

  it("Pix manual sem prazo (era dinheiro na entrega antes da chave) continua sem prazo", async () => {
    const store = await setupStore();
    const a = await createStoreOrder(sdb, orderInput(store, { couponCode: undefined, paymentMethod: "cash" }), { now: MORNING });
    await db.update(schema.orders).set({ paymentMethod: "pix_manual" }).where(eq(schema.orders.id, a.orderId));
    const result = await redoPendingOrder(
      sdb,
      { orderId: a.orderId, changes: { coupon: { kind: "code", code: CREDIT } }, actor: TEAM, allowPaymentAttempt: true },
      { now: LATER },
    );
    expect(await orderRow(result.newOrderId)).toMatchObject({ paymentMethod: "pix_manual", paymentDueAt: null });
    // Sem prazo, sem a frase "sua reserva fica garantida até" (que sairia vazia).
    const ctx = await loadOrderWaContext(sdb, result.newOrderId);
    expect((await redoNoticeVars(sdb, { redoHops: ctx?.redoHops ?? [], prazo: ctx?.vars.prazo ?? "" })).reserva).toBe("");
    const [audit] = await db.select().from(schema.auditLog).where(and(eq(schema.auditLog.action, "order.redo"), eq(schema.auditLog.entityId, a.orderId)));
    expect(audit.after).toMatchObject({ overriddenBlockers: ["pix_manual"] });
  });

  it("refeito duas vezes em segundos: 'seu pedido #A foi atualizado' cita o número que ela recebeu, não o do meio", async () => {
    const store = await setupStore();
    const a = await createStoreOrder(sdb, orderInput(store), { now: MORNING });
    const [conversation] = await db.select({ id: schema.waConversations.id }).from(schema.waConversations).limit(1);
    await db.insert(schema.waMessages).values({ conversationId: conversation.id, direction: "outbound", body: "Recebemos seu pedido", status: "delivered", dedupeKey: `wa.order_confirmed:${a.orderId}` });
    const b = await redoPendingOrder(sdb, { orderId: a.orderId, changes: { coupon: { kind: "remove" } }, actor: LIA }, { now: LATER });
    const c = await redoPendingOrder(sdb, { orderId: b.newOrderId, changes: { paymentMethod: "cash" }, actor: LIA }, { now: LATER });
    const ctx = await loadOrderWaContext(sdb, c.newOrderId);
    expect(ctx?.replaces).toEqual({ id: b.newOrderId, orderNumber: b.newOrderNumber });
    expect(ctx?.vars.pedido_anterior).toBe(String(a.orderNumber));
    // "O que mudou" soma os dois passos (#A → #B → #C): ela nunca viu o #B.
    const vars = await redoNoticeVars(sdb, { redoHops: ctx?.redoHops ?? [], prazo: ctx?.vars.prazo ?? "" });
    expect(vars).toEqual({
      mudancas: `cupom ${CREDIT} retirado; pagamento: dinheiro na entrega`,
      quem: "a Lia, a pedido da cliente",
      reserva: "",
    });
  });

  it("Pix manual: a Lia não refaz; a equipe confere no banco e o novo continua no Pix com o prazo dela", async () => {
    const store = await setupStore();
    const a = await createStoreOrder(sdb, orderInput(store, { couponCode: undefined }), { now: MORNING });
    const pixDue = new Date(Date.now() + 24 * 3600_000);
    await db.update(schema.orders).set({ paymentMethod: "pix_manual", paymentDueAt: pixDue }).where(eq(schema.orders.id, a.orderId));
    await expect(
      redoPendingOrder(sdb, { orderId: a.orderId, changes: { gift: { kind: "set", recipientName: "Ana", message: null } }, actor: LIA }, { now: LATER }),
    ).rejects.toMatchObject({ code: "REDO_NOT_ALLOWED", message: expect.stringContaining("chave Pix") });
    const result = await redoPendingOrder(
      sdb,
      { orderId: a.orderId, changes: { gift: { kind: "set", recipientName: "Ana", message: null } }, actor: TEAM, allowPaymentAttempt: true },
      { now: LATER },
    );
    expect(await orderRow(result.newOrderId)).toMatchObject({ paymentMethod: "pix_manual", paymentDueAt: pixDue });
  });

  it("reserva vencida ou dinheiro já baixado no financeiro: não refaz", async () => {
    const store = await setupStore();
    const a = await createStoreOrder(sdb, orderInput(store, { couponCode: undefined }), { now: MORNING });
    await db.update(schema.orders).set({ paymentDueAt: new Date("2026-10-12T14:00:00Z") }).where(eq(schema.orders.id, a.orderId));
    await expect(
      redoPendingOrder(sdb, { orderId: a.orderId, changes: { paymentMethod: "cash" }, actor: TEAM }, { now: LATER }),
    ).rejects.toMatchObject({ message: expect.stringContaining("já venceu") });

    const cash = await createStoreOrder(sdb, orderInput(store, { couponCode: undefined, items: [{ variantId: store.g, quantity: 1, expectedUnitPriceCents: 5998 }], paymentMethod: "cash" }), { now: MORNING });
    await db.update(schema.financialEntries).set({ status: "settled", settledAt: LATER }).where(eq(schema.financialEntries.orderId, cash.orderId));
    await expect(
      redoPendingOrder(sdb, { orderId: cash.orderId, changes: { paymentMethod: "online" }, actor: TEAM }, { now: LATER }),
    ).rejects.toMatchObject({ message: expect.stringContaining("já foi baixado") });
  });

  it("pedido pago e depois cancelado: o reenvio do Mercado Pago não vira alerta de 'pagaram um cancelado'", async () => {
    const store = await setupStore();
    const gateway = new FakePaymentGateway();
    const a = await createStoreOrder(sdb, orderInput(store, { couponCode: undefined }), { now: MORNING });
    const pref = await gateway.createCheckoutPreference({
      orderId: a.orderId,
      orderNumber: a.orderNumber,
      externalReference: a.orderId,
      items: [{ title: "Pedido", quantity: 1, unitPriceCents: a.totalCents }],
      backUrl: "https://trivemaison.com.br/pedido/token",
    });
    const paymentId = gateway.paymentIdForPreference(pref.preferenceId);
    gateway.approvePayment(paymentId);
    expect(await processPaymentEvent(sdb, gateway, { mpPaymentId: paymentId })).toMatchObject({ action: "paid" });
    await db.update(schema.orders).set({ status: "canceled" }).where(eq(schema.orders.id, a.orderId));
    expect(await processPaymentEvent(sdb, gateway, { mpPaymentId: paymentId })).toMatchObject({ action: "noop" });
    expect(await db.select().from(schema.outboxEvents).where(eq(schema.outboxEvents.eventType, "payment.approved_on_canceled"))).toHaveLength(0);
  });
});
