// "Chegou bem?": a pergunta sai um dia depois da entrega, na janela, uma vez
// por pedido; o toque volta pelo webhook e vira resposta gravada, texto com
// contexto para a Lia (ou transferência para a equipe) e sinal de caimento.
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeMessagingProvider } from "@/adapters/zapi/fake";
import { FEEDBACK_DELAY_MS, feedbackRowId } from "@/core/orders/feedback";
import * as schema from "@/db/schema";
import { initialWaTemplates } from "@/db/seed-data";
import type { DbOrTx } from "@/queue/enqueue";
import {
  askDeliveryFeedback,
  getFeedbackForOrder,
  getFitSignalsForProduct,
  listFeedbackByPhone,
  recordDeliveryFeedback,
  scheduleDeliveryFeedback,
} from "@/services/delivery-feedback";
import { processZapiInbound } from "@/services/wa-inbound";
import { createTestDb, type TestDb } from "../helpers/db";

const SECRET = "segredo-webhook-zapi";
const PHONE = "+5511999990000";
const PHONE_ZAPI = "5511999990000";
// 14:00Z = 11:00 em SP (dentro da janela).
const NOW = new Date("2026-09-13T14:00:00Z");

let db: TestDb;
let sdb: DbOrTx;
let close: () => Promise<void>;
let provider: FakeMessagingProvider;
const originalSecret = process.env.ZAPI_WEBHOOK_SECRET;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  sdb = db as unknown as DbOrTx;
  provider = new FakeMessagingProvider();
  vi.stubEnv("ADAPTER_MODE", "fake");
  process.env.ZAPI_WEBHOOK_SECRET = SECRET;
  await db.insert(schema.settings).values([
    { key: "wa_enabled", value: true },
    { key: "bot_enabled", value: true },
  ]);
  const template = initialWaTemplates.find((row) => row.key === "delivery_feedback_ask");
  if (!template) throw new Error("template delivery_feedback_ask ausente no seed");
  await db.insert(schema.waTemplates).values({ key: template.key, label: template.label, bodyTemplate: template.bodyTemplate, variables: template.variables });
});

afterEach(async () => {
  await close();
  vi.unstubAllEnvs();
  if (originalSecret === undefined) delete process.env.ZAPI_WEBHOOK_SECRET;
  else process.env.ZAPI_WEBHOOK_SECRET = originalSecret;
});

/** Peça "Longo Dunas" com uma variação Areia × tamanho (reaproveita o produto quando pedido). */
async function seedVariant(input: { size: string; productId?: string }): Promise<{ variantId: string; productId: string }> {
  let productId = input.productId;
  if (!productId) {
    const [product] = await db
      .insert(schema.products)
      .values({ name: "Longo Dunas", slug: `longo-dunas-${Math.random().toString(36).slice(2, 7)}`, status: "active", attributesSchema: ["cor", "tamanho"] })
      .returning({ id: schema.products.id });
    productId = product.id;
  }
  const [variant] = await db
    .insert(schema.productVariants)
    .values({ productId, sku: `LD-${Math.random().toString(36).slice(2, 7).toUpperCase()}`, attributes: { cor: "Areia", tamanho: input.size }, costCents: 100 })
    .returning({ id: schema.productVariants.id });
  await db.insert(schema.stockLevels).values({ productVariantId: variant.id, onHand: 5, reserved: 0 });
  return { variantId: variant.id, productId };
}

async function seedDelivered(opts: { items?: number; size?: string; optIn?: boolean; productId?: string; variantId?: string } = {}): Promise<{ orderId: string; orderNumber: number; variantId: string; productId: string; customerId: string }> {
  const [customer] = await db
    .insert(schema.customers)
    .values({ fullName: "Ana Cliente", phoneE164: PHONE, marketingOptIn: opts.optIn ?? true })
    .onConflictDoNothing()
    .returning({ id: schema.customers.id });
  const customerId = customer?.id ?? (await db.select({ id: schema.customers.id }).from(schema.customers).where(eq(schema.customers.phoneE164, PHONE)))[0].id;
  const { variantId, productId } = opts.variantId && opts.productId ? { variantId: opts.variantId, productId: opts.productId } : await seedVariant({ size: opts.size ?? "M", productId: opts.productId });
  const [order] = await db
    .insert(schema.orders)
    .values({ customerId, status: "delivered", channel: "whatsapp", subtotalCents: 1000, shippingCents: 0, totalCents: 1000, deliveredAt: NOW })
    .returning({ id: schema.orders.id, orderNumber: schema.orders.orderNumber });
  for (let i = 0; i < (opts.items ?? 1); i += 1) {
    await db.insert(schema.orderItems).values({ orderId: order.id, productVariantId: variantId, skuSnapshot: `LD-${i}`, nameSnapshot: "Longo Dunas", quantity: 1, unitPriceCents: 1000, unitCostCents: 100, totalCents: 1000 });
  }
  return { orderId: order.id, orderNumber: order.orderNumber, variantId, productId, customerId };
}

describe("scheduleDeliveryFeedback / askDeliveryFeedback", () => {
  it("agenda para +24 h com dedupe por pedido; a pergunta sai uma vez como lista com as 5 opções", async () => {
    const { orderId, orderNumber } = await seedDelivered();
    await scheduleDeliveryFeedback(sdb, { orderId, now: NOW });
    await scheduleDeliveryFeedback(sdb, { orderId, now: NOW });
    const events = await db.select().from(schema.outboxEvents);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventType: "wa.feedback_ask", dedupeKey: `wa.feedback_ask:${orderId}` });
    expect(events[0].nextAttemptAt.getTime()).toBe(NOW.getTime() + FEEDBACK_DELAY_MS);

    const result = await askDeliveryFeedback(sdb, provider, { orderId, now: new Date(NOW.getTime() + FEEDBACK_DELAY_MS) });
    expect(result).toMatchObject({ sent: true });
    expect(provider.sentOptionLists).toHaveLength(1);
    const list = provider.sentOptionLists[0];
    expect(list.toE164).toBe(PHONE);
    expect(list.message).toContain(`Ana, chegou bem?`);
    expect(list.message).toContain(`Longo Dunas do pedido #${orderNumber}`);
    expect(list.options.map((option) => option.id)).toEqual(["amei", "grande", "pequeno", "defeito", "falar"].map((answer) => `feedback:${answer}:${orderId}`));
    const [row] = await db.select().from(schema.deliveryFeedback);
    expect(row).toMatchObject({ orderId, phoneE164: PHONE, answer: null });
    expect(row.productVariantId).not.toBeNull();
    expect(await getFeedbackForOrder(sdb, orderId)).toMatchObject({ answer: null });

    expect(await askDeliveryFeedback(sdb, provider, { orderId, now: NOW })).toEqual({ skipped: "ja_perguntado" });
    expect(provider.sentOptionLists).toHaveLength(1);
  });

  it("+24 h conta da ENTREGA, não do retry do handler", async () => {
    const { orderId } = await seedDelivered();
    await scheduleDeliveryFeedback(sdb, { orderId, now: new Date(NOW.getTime() + 6 * 3_600_000) });
    const [event] = await db.select().from(schema.outboxEvents);
    expect(event.nextAttemptAt.getTime()).toBe(NOW.getTime() + FEEDBACK_DELAY_MS);
  });

  it("provedor fora do ar na 1ª tentativa: nada fica 'perguntado'; o retry manda a lista uma vez", async () => {
    const { orderId } = await seedDelivered();
    provider.simulateDisconnect();
    await expect(askDeliveryFeedback(sdb, provider, { orderId, now: NOW })).rejects.toThrow();
    expect(await db.select().from(schema.deliveryFeedback)).toHaveLength(0);
    expect(await getFeedbackForOrder(sdb, orderId)).toBeNull();
    provider.simulateReconnect();
    expect(await askDeliveryFeedback(sdb, provider, { orderId, now: NOW })).toMatchObject({ sent: true });
    expect(provider.sentOptionLists).toHaveLength(1);
    expect(await db.select().from(schema.deliveryFeedback)).toHaveLength(1);
    // Retry depois de enviado: o dedupe de wa_messages responde e nada sai de novo.
    expect(await askDeliveryFeedback(sdb, provider, { orderId, now: NOW })).toEqual({ skipped: "ja_perguntado" });
    expect(provider.sentOptionLists).toHaveLength(1);
  });

  it("número sem WhatsApp: não sai e não fica 'perguntado'", async () => {
    const { orderId } = await seedDelivered();
    provider.setPhoneExists(PHONE, false);
    expect(await askDeliveryFeedback(sdb, provider, { orderId, now: NOW })).toEqual({ skipped: "numero_sem_whatsapp" });
    expect(await db.select().from(schema.deliveryFeedback)).toHaveLength(0);
  });

  it("fora da janela re-enfileira para as 9h com dedupe datado; desligado, sem opt-in, não entregue e pedido com várias peças", async () => {
    const { orderId } = await seedDelivered();
    const night = new Date("2026-09-14T02:00:00Z"); // 23:00 em SP
    expect(await askDeliveryFeedback(sdb, provider, { orderId, now: night })).toEqual({ skipped: "fora_da_janela" });
    const deferred = await db.select().from(schema.outboxEvents);
    expect(deferred).toHaveLength(1);
    expect(deferred[0].dedupeKey).toBe(`wa.feedback_ask:${orderId}:2026-09-13`);
    expect(await db.select().from(schema.deliveryFeedback)).toHaveLength(0);

    await db.insert(schema.settings).values({ key: "feedback_ask_enabled", value: false });
    expect(await askDeliveryFeedback(sdb, provider, { orderId, now: NOW })).toEqual({ skipped: "desligado" });
    await db.update(schema.settings).set({ value: true }).where(eq(schema.settings.key, "feedback_ask_enabled"));

    await db.update(schema.customers).set({ marketingOptIn: false });
    expect(await askDeliveryFeedback(sdb, provider, { orderId, now: NOW })).toEqual({ skipped: "sem_opt_in" });
    await db.update(schema.customers).set({ marketingOptIn: true });

    await db.update(schema.orders).set({ status: "refunded" }).where(eq(schema.orders.id, orderId));
    expect(await askDeliveryFeedback(sdb, provider, { orderId, now: NOW })).toEqual({ skipped: "nao_entregue" });

    const multi = await seedDelivered({ items: 2 });
    await askDeliveryFeedback(sdb, provider, { orderId: multi.orderId, now: NOW });
    const [row] = await db.select().from(schema.deliveryFeedback).where(eq(schema.deliveryFeedback.orderId, multi.orderId));
    expect(row.productVariantId).toBeNull();
    expect(provider.sentOptionLists.at(-1)?.message).toContain("suas peças");
  });
});

describe("o toque volta pelo webhook", () => {
  const send = (messageId: string, rowId: string, title: string) =>
    processZapiInbound(sdb, {
      providedSecret: SECRET,
      body: {
        type: "ReceivedCallback",
        instanceId: "instancia-x",
        messageId,
        phone: PHONE_ZAPI,
        fromMe: false,
        isGroup: false,
        senderName: "Ana Cliente",
        momment: Date.now(),
        status: "RECEIVED",
        listResponseMessage: { message: title, title, selectedRowId: rowId },
      },
    });

  it("'Ficou grande' grava a resposta, vira texto com contexto e cai na Lia; outra opção depois substitui (com o rastro); o mesmo toque repetido não muda nada", async () => {
    const { orderId, orderNumber } = await seedDelivered();
    await askDeliveryFeedback(sdb, provider, { orderId, now: NOW });
    const result = await send("MSG-FB-1", feedbackRowId("grande", orderId), "Ficou grande");
    expect(result.action).toBe("bot_queued");
    const [row] = await db.select().from(schema.deliveryFeedback).where(eq(schema.deliveryFeedback.orderId, orderId));
    expect(row.answer).toBe("grande");
    expect(row.answeredAt).not.toBeNull();
    const inbound = await db.select().from(schema.waMessages).where(eq(schema.waMessages.zapiMessageId, "MSG-FB-1"));
    expect(inbound[0].body).toBe(`[resposta ao "Chegou bem?" do pedido #${orderNumber} (Longo Dunas · Areia · M)]: Ficou grande`);
    expect(row.answerWaMessageId).toBe(inbound[0].id);

    expect(await listFeedbackByPhone(sdb, PHONE)).toEqual([expect.stringContaining(`Pedido #${orderNumber} (Longo Dunas · Areia · M): respondeu "Ficou grande"`)]);

    // Ela reabre a lista e toca "Amei": a última vale — ficha, caderninho e conversa iguais.
    await send("MSG-FB-2", feedbackRowId("amei", orderId), "Amei");
    const [after] = await db.select().from(schema.deliveryFeedback).where(eq(schema.deliveryFeedback.orderId, orderId));
    expect(after.answer).toBe("amei");
    const second = await db.select().from(schema.waMessages).where(eq(schema.waMessages.zapiMessageId, "MSG-FB-2"));
    expect(second[0].body).toContain('Amei (antes tinha respondido "Ficou grande")');
    // O mesmo toque de novo: nada muda e a mensagem segue como texto comum.
    await send("MSG-FB-2b", feedbackRowId("amei", orderId), "Amei");
    const third = await db.select().from(schema.waMessages).where(eq(schema.waMessages.zapiMessageId, "MSG-FB-2b"));
    expect(third[0].body).not.toContain("[resposta ao");
    const [same] = await db.select().from(schema.deliveryFeedback).where(eq(schema.deliveryFeedback.orderId, orderId));
    expect(same.answerWaMessageId).toBe(second[0].id);
  });

  it("'Veio com defeito' transfere para a equipe (conversa em 'human'), sem turno da Lia", async () => {
    const { orderId } = await seedDelivered();
    await askDeliveryFeedback(sdb, provider, { orderId, now: NOW });
    const result = await send("MSG-FB-3", feedbackRowId("defeito", orderId), "Veio com defeito");
    expect(result.action).toBe("feedback_handoff");
    const [conversation] = await db.select().from(schema.waConversations).where(eq(schema.waConversations.phoneE164, PHONE));
    expect(conversation.status).toBe("human");
    expect((conversation.botState as { handoff?: { motivo: string } }).handoff?.motivo).toContain("defeito");
    const events = await db.select().from(schema.outboxEvents);
    expect(events.some((event) => event.eventType === "wa.bot_turn")).toBe(false);
  });

  it("outro telefone não grava a resposta de um pedido alheio; toque sem pergunta vira texto normal", async () => {
    const { orderId } = await seedDelivered();
    await askDeliveryFeedback(sdb, provider, { orderId, now: NOW });
    const other = await processZapiInbound(sdb, {
      providedSecret: SECRET,
      body: {
        type: "ReceivedCallback",
        instanceId: "instancia-x",
        messageId: "MSG-FB-OTHER",
        phone: "5511888880000",
        fromMe: false,
        isGroup: false,
        momment: Date.now(),
        status: "RECEIVED",
        listResponseMessage: { title: "Amei", selectedRowId: feedbackRowId("amei", orderId) },
      },
    });
    expect(other.action).toBe("bot_queued");
    const [row] = await db.select().from(schema.deliveryFeedback).where(eq(schema.deliveryFeedback.orderId, orderId));
    expect(row.answer).toBeNull();
    const inbound = await db.select().from(schema.waMessages).where(eq(schema.waMessages.zapiMessageId, "MSG-FB-OTHER"));
    expect(inbound[0].body).toBe("Amei");

    const context = await recordDeliveryFeedback(sdb, { orderId: "00000000-0000-4000-8000-000000000009", answer: "amei", phoneE164: PHONE, waMessageId: inbound[0].id, now: NOW });
    expect(context).toEqual({ recorded: false, context: null });
  });
});

describe("getFitSignalsForProduct", () => {
  it("conta por tamanho e só afirma o sinal com base", async () => {
    const first = await seedDelivered({ size: "M" });
    const answers: ("amei" | "grande" | "pequeno")[] = ["grande", "grande", "amei"];
    const orderIds = [first.orderId];
    for (let i = 1; i < 3; i += 1) orderIds.push((await seedDelivered({ productId: first.productId, variantId: first.variantId })).orderId);
    // Três clientes diferentes (uma opinião por pessoa).
    for (const [index, orderId] of orderIds.entries()) {
      await db.insert(schema.deliveryFeedback).values({ orderId, phoneE164: `+551199999010${index}`, productVariantId: (await db.select({ v: schema.orderItems.productVariantId }).from(schema.orderItems).where(eq(schema.orderItems.orderId, orderId)))[0].v, answer: answers[index], askedAt: NOW, answeredAt: NOW });
    }
    const gSize = await seedDelivered({ size: "G", productId: first.productId });
    await db.insert(schema.deliveryFeedback).values({ orderId: gSize.orderId, phoneE164: PHONE, productVariantId: gSize.variantId, answer: "pequeno", askedAt: NOW, answeredAt: NOW });
    const signals = await getFitSignalsForProduct(sdb, first.productId);
    expect(signals).toEqual([
      { size: "M", amei: 1, grande: 2, pequeno: 0, signal: "veste_grande" },
      { size: "G", amei: 0, grande: 0, pequeno: 1, signal: null },
    ]);
  });

  it("uma opinião por cliente: três pedidos da mesma pessoa contam uma vez; sem eixo de tamanho vira 'único'", async () => {
    const first = await seedDelivered({ size: "M" });
    const orderIds = [first.orderId];
    for (let i = 1; i < 3; i += 1) orderIds.push((await seedDelivered({ productId: first.productId, variantId: first.variantId })).orderId);
    for (const orderId of orderIds) {
      await db.insert(schema.deliveryFeedback).values({ orderId, customerId: first.customerId, phoneE164: PHONE, productVariantId: first.variantId, answer: "grande", askedAt: NOW, answeredAt: NOW });
    }
    expect(await getFitSignalsForProduct(sdb, first.productId)).toEqual([{ size: "M", amei: 0, grande: 1, pequeno: 0, signal: null }]);

    const [scarf] = await db.insert(schema.products).values({ name: "Lenço Rio", slug: "lenco-rio", status: "active", attributesSchema: ["cor"] }).returning({ id: schema.products.id });
    const [green] = await db.insert(schema.productVariants).values({ productId: scarf.id, sku: "LR-VERDE", attributes: { cor: "Verde" }, costCents: 100 }).returning({ id: schema.productVariants.id });
    await db.insert(schema.stockLevels).values({ productVariantId: green.id, onHand: 5, reserved: 0 });
    const scarfOrder = await seedDelivered({ productId: scarf.id, variantId: green.id });
    await db.insert(schema.deliveryFeedback).values({ orderId: scarfOrder.orderId, phoneE164: "+5511999990099", productVariantId: green.id, answer: "grande", askedAt: NOW, answeredAt: NOW });
    expect(await getFitSignalsForProduct(sdb, scarf.id)).toEqual([{ size: "único", amei: 0, grande: 1, pequeno: 0, signal: null }]);
  });
});
