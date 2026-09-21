// "Quem já vestiu" ponta a ponta com PGlite + fakes: a Lia registra a foto
// do turno (linha + evento na mesma transação), a fila baixa/normaliza/
// desenha/manda o cartão e a pergunta (dedupe por foto), o toque de
// consentimento volta pelo webhook, a dona aprova/recusa/retira, a vitrine
// só lista o que é público e "esquecer a cartela" retira tudo.
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeFileStorage } from "@/adapters/storage/fake";
import { FakeMessagingProvider } from "@/adapters/zapi/fake";
import type { CardData } from "@/core/cards/types";
import { lookRowId } from "@/core/looks/consent";
import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import {
  approveCustomerLook,
  countPendingLooks,
  countPublicLooksForProduct,
  listLooksMemoryLines,
  listPendingLooks,
  listPublicLooksForProduct,
  lookCardStoragePath,
  lookPhotoStoragePath,
  recordLookConsent,
  rejectCustomerLook,
  renderAndSendCustomerLookCard,
  revokeCustomerLook,
} from "@/services/customer-looks";
import { forgetStyleProfile, saveStyleProfile } from "@/services/style-profiles";
import { buildToolExecutor } from "@/services/wa-bot";
import { processZapiInbound } from "@/services/wa-inbound";
import { createTestDb, type TestDb } from "../helpers/db";

const SECRET = "segredo-webhook-zapi";
const PHONE = "+5511999990000";
const PHONE_ZAPI = "5511999990000";
const NOW = new Date("2026-09-14T14:00:00Z");
const PHOTO_URL = "https://zapi.example/media/foto-ana.jpg";

let db: TestDb;
let sdb: DbOrTx;
let close: () => Promise<void>;
let provider: FakeMessagingProvider;
let storage: FakeFileStorage;
const originalSecret = process.env.ZAPI_WEBHOOK_SECRET;

const render = vi.fn(async (_data: CardData) => sharp({ create: { width: 108, height: 135, channels: 3, background: "#faf7f0" } }).png().toBuffer());

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  sdb = db as unknown as DbOrTx;
  provider = new FakeMessagingProvider();
  storage = new FakeFileStorage();
  render.mockClear();
  vi.stubEnv("ADAPTER_MODE", "fake");
  process.env.ZAPI_WEBHOOK_SECRET = SECRET;
  await db.insert(schema.settings).values([
    { key: "wa_enabled", value: true },
    { key: "bot_enabled", value: true },
  ]);
});

afterEach(async () => {
  await close();
  vi.unstubAllEnvs();
  if (originalSecret === undefined) delete process.env.ZAPI_WEBHOOK_SECRET;
  else process.env.ZAPI_WEBHOOK_SECRET = originalSecret;
});

async function seedProduct(name = "Longo Dunas", slug = "longo-dunas"): Promise<{ productId: string; variantId: string }> {
  const [product] = await db.insert(schema.products).values({ name, slug, status: "active", attributesSchema: ["cor", "tamanho"] }).returning({ id: schema.products.id });
  const [variant] = await db.insert(schema.productVariants).values({ productId: product.id, sku: `${slug.toUpperCase()}-M`, attributes: { cor: "Areia", tamanho: "M" }, costCents: 100 }).returning({ id: schema.productVariants.id });
  await db.insert(schema.stockLevels).values({ productVariantId: variant.id, onHand: 5, reserved: 0 });
  // Preço ativo: sem ele a peça não é pública (resolveProductDetail não a acha).
  await db.insert(schema.priceVersions).values({ productVariantId: variant.id, versionNumber: 1, status: "active", priceCents: 28900, origin: "initial", breakdown: {}, costSnapshotCents: 100, computedMarginRate: "0.3000", activatedAt: NOW });
  return { productId: product.id, variantId: variant.id };
}

/** A cliente Ana, a conversa e uma mensagem inbound com a foto (como o webhook grava). */
async function seedConversationWithPhoto(input: { productId?: string; variantId?: string; delivered?: boolean } = {}): Promise<{ customerId: string; conversationId: string; photoWaMessageId: string }> {
  const [customer] = await db.insert(schema.customers).values({ fullName: "Ana Cliente Souza", phoneE164: PHONE, marketingOptIn: true }).returning({ id: schema.customers.id });
  const [conversation] = await db.insert(schema.waConversations).values({ phoneE164: PHONE, customerId: customer.id }).returning({ id: schema.waConversations.id });
  if (input.delivered && input.variantId) {
    const [order] = await db
      .insert(schema.orders)
      .values({ customerId: customer.id, status: "delivered", channel: "whatsapp", subtotalCents: 28900, shippingCents: 0, totalCents: 28900, deliveredAt: NOW })
      .returning({ id: schema.orders.id });
    await db.insert(schema.orderItems).values({ orderId: order.id, productVariantId: input.variantId, skuSnapshot: "LD-M", nameSnapshot: "Longo Dunas", quantity: 1, unitPriceCents: 28900, unitCostCents: 100, totalCents: 28900 });
  }
  const [message] = await db
    .insert(schema.waMessages)
    .values({ conversationId: conversation.id, direction: "inbound", kind: "image", body: "", mediaUrl: PHOTO_URL, status: "delivered", zapiMessageId: `IMG-${Math.random().toString(36).slice(2, 8)}` })
    .returning({ id: schema.waMessages.id });
  return { customerId: customer.id, conversationId: conversation.id, photoWaMessageId: message.id };
}

async function photoJpeg(): Promise<Buffer> {
  return sharp({ create: { width: 2400, height: 3200, channels: 3, background: "#b08968" } }).jpeg().toBuffer();
}

describe("registrar_foto_com_a_peca (executor)", () => {
  it("guarda a foto do turno com a peça, o pedido entregue e o primeiro nome; enfileira o cartão; sem foto no turno recusa; desligado recusa", async () => {
    const { productId, variantId } = await seedProduct();
    const { customerId, conversationId, photoWaMessageId } = await seedConversationWithPhoto({ productId, variantId, delivered: true });
    const executor = buildToolExecutor(sdb, {
      conversationId,
      phoneE164: PHONE,
      customerId,
      lastInboundId: photoWaMessageId,
      recentImages: [{ waMessageId: photoWaMessageId, mediaUrl: PHOTO_URL }],
      now: NOW,
    });
    const result = await executor("registrar_foto_com_a_peca", { produto: "longo-dunas" });
    expect(result.ok).toBe(true);
    expect(result.text).toContain('cartão "Ana veste Longo Dunas"');
    expect(result.text).not.toContain("Não achei pedido");
    const [look] = await db.select().from(schema.customerLooks);
    expect(look).toMatchObject({ customerId, phoneE164: PHONE, productId, productVariantId: variantId, displayName: "Ana", photoWaMessageId, consentAnswer: null, photoPath: null });
    expect(look.orderId).not.toBeNull();
    const events = await db.select().from(schema.outboxEvents);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventType: "wa.customer_look_card", dedupeKey: `wa.look_card:${look.id}` });
    expect(await listLooksMemoryLines(sdb, PHONE)).toEqual(["Foto dela com o Longo Dunas: aguardando a resposta dela."]);

    const noPhoto = buildToolExecutor(sdb, { conversationId, phoneE164: PHONE, customerId, lastInboundId: photoWaMessageId, recentImages: [] });
    expect((await noPhoto("registrar_foto_com_a_peca", { produto: "longo-dunas" })).ok).toBe(false);
    expect((await executor("registrar_foto_com_a_peca", { produto: "peca-que-nao-existe" })).ok).toBe(false);

    await db.insert(schema.settings).values({ key: "customer_looks_enabled", value: false });
    const off = await executor("registrar_foto_com_a_peca", { produto: "longo-dunas" });
    expect(off.ok).toBe(false);
    expect(off.text).toContain("desligado");
    expect(await db.select().from(schema.customerLooks)).toHaveLength(1);
  });

  it("no ensaio (dryRun) não grava nada; sem pedido com a peça avisa a Lia", async () => {
    const { productId } = await seedProduct();
    const { customerId, conversationId, photoWaMessageId } = await seedConversationWithPhoto({ productId });
    const dry = buildToolExecutor(sdb, { conversationId, phoneE164: PHONE, customerId, lastInboundId: photoWaMessageId, recentImages: [{ waMessageId: photoWaMessageId, mediaUrl: PHOTO_URL }], dryRun: true });
    expect((await dry("registrar_foto_com_a_peca", { produto: "longo-dunas" })).ok).toBe(true);
    expect(await db.select().from(schema.customerLooks)).toHaveLength(0);

    const real = buildToolExecutor(sdb, { conversationId, phoneE164: PHONE, customerId, lastInboundId: photoWaMessageId, recentImages: [{ waMessageId: photoWaMessageId, mediaUrl: PHOTO_URL }] });
    const result = await real("registrar_foto_com_a_peca", { produto: "Longo Dunas" });
    expect(result.ok).toBe(true);
    expect(result.text).toContain("Não achei pedido dela com essa peça");
    const [look] = await db.select().from(schema.customerLooks);
    expect(look.orderId).toBeNull();
  });
});

describe("mimo pela foto (cupom no registro)", () => {
  async function enableLookCoupon() {
    await db.insert(schema.settings).values([
      { key: "look_coupon_enabled", value: true },
      { key: "look_coupon_percent", value: 10 },
      { key: "look_coupon_days", value: 60 },
    ]);
  }
  function executorFor(input: { conversationId: string; customerId: string | null; photoWaMessageId: string; phash?: string }) {
    return buildToolExecutor(sdb, {
      conversationId: input.conversationId,
      phoneE164: PHONE,
      customerId: input.customerId,
      lastInboundId: input.photoWaMessageId,
      recentImages: [{ waMessageId: input.photoWaMessageId, mediaUrl: PHOTO_URL, ...(input.phash ? { phash: input.phash } : {}) }],
      now: NOW,
    });
  }

  it("pedido entregue + foto longe do catálogo → cupom pessoal, coupon_id na foto, código na dica e na legenda do cartão; 2ª foto da peça → 'já ganhou'", async () => {
    await enableLookCoupon();
    const { productId, variantId } = await seedProduct();
    // Uma foto do catálogo com hash: a foto dela está longe (distância > 8).
    await db.insert(schema.productImages).values({ productId, storagePath: "products/x/1.jpg", sortOrder: 0, phash: "0000000000000000" });
    const { customerId, conversationId, photoWaMessageId } = await seedConversationWithPhoto({ productId, variantId, delivered: true });
    const result = await executorFor({ conversationId, customerId, photoWaMessageId, phash: "ffffffffffffffff" })("registrar_foto_com_a_peca", { produto: "longo-dunas" });
    expect(result.ok).toBe(true);
    expect(result.text).toMatch(/Ela ganhou o cupom ANA-[A-Z2-9]{5} \(10% até 13\/11\)/);

    const [look] = await db.select().from(schema.customerLooks);
    expect(look.couponId).not.toBeNull();
    const [coupon] = await db.select().from(schema.coupons).where(eq(schema.coupons.id, look.couponId as string));
    expect(coupon).toMatchObject({ origin: "look_photo", customerId, value: 10, maxUses: 1, perCustomerLimit: 1, dedupeKey: `look_photo:${customerId}:${productId}`, note: "Foto dela com Longo Dunas" });

    // O cartão repete o código na legenda.
    provider.setMediaFixture(PHOTO_URL, await photoJpeg(), "image/jpeg");
    await renderAndSendCustomerLookCard(sdb, provider, storage, render, { lookId: look.id }, { now: () => NOW });
    expect(provider.sentImages[0].caption).toContain(`Seu mimo: cupom ${coupon.code} (10% até 13/11) 🤎`);

    // Outra foto da MESMA peça: a linha nasce, o cupom não.
    const [second] = await db
      .insert(schema.waMessages)
      .values({ conversationId, direction: "inbound", kind: "image", body: "", mediaUrl: PHOTO_URL, status: "delivered", zapiMessageId: "IMG-2" })
      .returning({ id: schema.waMessages.id });
    const again = await executorFor({ conversationId, customerId, photoWaMessageId: second.id, phash: "ffffffffffffffff" })("registrar_foto_com_a_peca", { produto: "longo-dunas" });
    expect(again.text).toContain(`Ela já tinha ganhado o cupom ${coupon.code} por essa peça: não prometa outro.`);
    expect(await db.select().from(schema.coupons)).toHaveLength(1);
  });

  it("só pago (não entregue) → sem cupom em silêncio; print do catálogo → sem cupom com aviso; desligado → foto registrada, sem cupom", async () => {
    await enableLookCoupon();
    const { productId, variantId } = await seedProduct();
    await db.insert(schema.productImages).values({ productId, storagePath: "products/x/1.jpg", sortOrder: 0, phash: "0000000000000000" });
    const paid = await seedConversationWithPhoto({ productId, variantId, delivered: true });
    await db.update(schema.orders).set({ status: "paid", deliveredAt: null });
    const soPago = await executorFor({ ...paid })("registrar_foto_com_a_peca", { produto: "longo-dunas" });
    expect(soPago.ok).toBe(true);
    expect(soPago.text).not.toContain("cupom");
    expect(await db.select().from(schema.coupons)).toHaveLength(0);

    await db.update(schema.orders).set({ status: "delivered", deliveredAt: NOW });
    const [print] = await db
      .insert(schema.waMessages)
      .values({ conversationId: paid.conversationId, direction: "inbound", kind: "image", body: "", mediaUrl: PHOTO_URL, status: "delivered", zapiMessageId: "IMG-P" })
      .returning({ id: schema.waMessages.id });
    // Print do catálogo (hash a 1 bit da foto da peça): nem registra, nem cartão, nem mimo.
    const doCatalogo = await executorFor({ conversationId: paid.conversationId, customerId: paid.customerId, photoWaMessageId: print.id, phash: "0000000000000001" })("registrar_foto_com_a_peca", { produto: "longo-dunas" });
    expect(doCatalogo.ok).toBe(false);
    expect(doCatalogo.text).toContain("parece ser do catálogo");
    expect(await db.select().from(schema.coupons)).toHaveLength(0);
    expect(await db.select().from(schema.customerLooks)).toHaveLength(1);

    await db.update(schema.settings).set({ value: false }).where(eq(schema.settings.key, "look_coupon_enabled"));
    const [third] = await db
      .insert(schema.waMessages)
      .values({ conversationId: paid.conversationId, direction: "inbound", kind: "image", body: "", mediaUrl: PHOTO_URL, status: "delivered", zapiMessageId: "IMG-3" })
      .returning({ id: schema.waMessages.id });
    const off = await executorFor({ conversationId: paid.conversationId, customerId: paid.customerId, photoWaMessageId: third.id, phash: "ffffffffffffffff" })("registrar_foto_com_a_peca", { produto: "longo-dunas" });
    expect(off.ok).toBe(true);
    expect(off.text).not.toContain("cupom");
    expect(await db.select().from(schema.customerLooks)).toHaveLength(2);
    expect(await db.select().from(schema.coupons)).toHaveLength(0);
  });

  it("validade até o fim do dia anunciado; foto usada de novo com o cupom já gasto não repete o mimo na legenda", async () => {
    await enableLookCoupon();
    const { productId, variantId } = await seedProduct();
    const { customerId, conversationId, photoWaMessageId } = await seedConversationWithPhoto({ productId, variantId, delivered: true });
    await executorFor({ conversationId, customerId, photoWaMessageId, phash: "ffffffffffffffff" })("registrar_foto_com_a_peca", { produto: "longo-dunas" });
    const [coupon] = await db.select().from(schema.coupons);
    // NOW = 14/09 11h SP; +60 dias = 13/11, até 23:59:59 SP (02:59:59Z de 14/11).
    expect(coupon.expiresAt).toEqual(new Date("2026-11-14T02:59:59.000Z"));

    await db.update(schema.coupons).set({ usedCount: 1 }).where(eq(schema.coupons.id, coupon.id));
    const [look] = await db.select().from(schema.customerLooks);
    provider.setMediaFixture(PHOTO_URL, await photoJpeg(), "image/jpeg");
    await renderAndSendCustomerLookCard(sdb, provider, storage, render, { lookId: look.id }, { now: () => NOW });
    expect(provider.sentImages[0].caption).not.toContain("Seu mimo");
  });
});

describe("wa.customer_look_card (fila)", () => {
  async function registered(): Promise<{ lookId: string; productId: string; customerId: string; conversationId: string }> {
    const { productId, variantId } = await seedProduct();
    const { customerId, conversationId, photoWaMessageId } = await seedConversationWithPhoto({ productId, variantId, delivered: true });
    const executor = buildToolExecutor(sdb, { conversationId, phoneE164: PHONE, customerId, lastInboundId: photoWaMessageId, recentImages: [{ waMessageId: photoWaMessageId, mediaUrl: PHOTO_URL }], now: NOW });
    await executor("registrar_foto_com_a_peca", { produto: "longo-dunas" });
    const [look] = await db.select({ id: schema.customerLooks.id }).from(schema.customerLooks);
    return { lookId: look.id, productId, customerId, conversationId };
  }

  it("baixa e normaliza a foto (≤ 1600 px, JPEG), desenha o cartão, manda a imagem e a lista 'Posso mostrar na página?' — uma vez, mesmo com retry", async () => {
    const { lookId } = await registered();
    provider.setMediaFixture(PHOTO_URL, await photoJpeg(), "image/jpeg");
    const result = await renderAndSendCustomerLookCard(sdb, provider, storage, render, { lookId }, { now: () => NOW });
    expect(result).toMatchObject({ sent: true, cardUrl: `memory://${lookCardStoragePath(lookId)}` });
    expect(render).toHaveBeenCalledTimes(1);
    expect(render.mock.calls[0][0]).toMatchObject({ kind: "customer_look", title: "Ana veste Longo Dunas", productName: "Longo Dunas", eyebrow: "QUEM JÁ VESTIU" });

    const photo = storage.get(lookPhotoStoragePath(lookId));
    expect(photo?.contentType).toBe("image/jpeg");
    const meta = await sharp(Buffer.from(photo!.data)).metadata();
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(1600);
    expect(meta.exif).toBeUndefined();

    expect(provider.sentImages).toHaveLength(1);
    expect(provider.sentImages[0].toE164).toBe(PHONE);
    expect(provider.sentImages[0].caption).toContain("Ana, ficou lindo em você");
    expect(provider.sentOptionLists).toHaveLength(1);
    const list = provider.sentOptionLists[0];
    expect(list.message).toContain("Posso mostrá-la na página do Longo Dunas");
    expect(list.message).toContain("Guardei a sua foto");
    expect(list.options.map((option) => option.id)).toEqual([lookRowId("sim", lookId), lookRowId("nao", lookId)]);

    const [look] = await db.select().from(schema.customerLooks).where(eq(schema.customerLooks.id, lookId));
    expect(look.photoPath).toBe(lookPhotoStoragePath(lookId));
    expect(look.cardPath).toBe(lookCardStoragePath(lookId));

    // Retry da fila: nada baixa, desenha ou manda de novo.
    const again = await renderAndSendCustomerLookCard(sdb, provider, storage, render, { lookId }, { now: () => NOW });
    expect(again).toMatchObject({ sent: true });
    expect(render).toHaveBeenCalledTimes(1);
    expect(provider.sentImages).toHaveLength(1);
    expect(provider.sentOptionLists).toHaveLength(1);
  });

  it("download que falha RELANÇA (a fila tenta de novo); sem URL nenhuma é skip; nunca vira pública", async () => {
    const { lookId, productId } = await registered();
    await expect(renderAndSendCustomerLookCard(sdb, provider, storage, render, { lookId })).rejects.toThrow();
    expect(provider.sentImages).toHaveLength(0);
    // Na 2ª tentativa a Z-API respondeu: o cartão sai uma vez.
    provider.setMediaFixture(PHOTO_URL, await photoJpeg(), "image/jpeg");
    expect(await renderAndSendCustomerLookCard(sdb, provider, storage, render, { lookId })).toMatchObject({ sent: true });
    expect(provider.sentImages).toHaveLength(1);

    // Sem URL nenhuma (mensagem apagada): skip, sem retry.
    const [message] = await db.select({ id: schema.waMessages.id }).from(schema.waMessages).where(eq(schema.waMessages.kind, "image"));
    const [second] = await db
      .insert(schema.customerLooks)
      .values({ phoneE164: "+5511777770001", productId, displayName: "Bia", photoWaMessageId: null, createdAt: NOW, updatedAt: NOW })
      .returning({ id: schema.customerLooks.id });
    expect(message).toBeDefined();
    expect(await renderAndSendCustomerLookCard(sdb, provider, storage, render, { lookId: second.id })).toEqual({ skipped: "foto_indisponivel" });
    expect(await listPublicLooksForProduct(sdb, productId)).toEqual([]);
    expect(await listPendingLooks(sdb)).toEqual([]);
  });

  it("a mesma foto registrada duas vezes vira UMA linha e UM evento; a Lia escolhe a foto por índice", async () => {
    const { productId, variantId } = await seedProduct();
    const { customerId, conversationId, photoWaMessageId } = await seedConversationWithPhoto({ productId, variantId, delivered: true });
    const [older] = await db
      .insert(schema.waMessages)
      .values({ conversationId, direction: "inbound", kind: "image", body: "", mediaUrl: "https://zapi.example/media/print.jpg", status: "delivered", zapiMessageId: "IMG-PRINT" })
      .returning({ id: schema.waMessages.id });
    const recentImages = [
      { waMessageId: older.id, mediaUrl: "https://zapi.example/media/print.jpg" },
      { waMessageId: photoWaMessageId, mediaUrl: PHOTO_URL },
    ];
    const executor = buildToolExecutor(sdb, { conversationId, phoneE164: PHONE, customerId, lastInboundId: photoWaMessageId, recentImages, now: NOW });
    const first = await executor("registrar_foto_com_a_peca", { produto: "longo-dunas", foto: 2 });
    expect(first.ok).toBe(true);
    expect(first.text).toContain("registrei a 2ª das 2 fotos");
    const again = await executor("registrar_foto_com_a_peca", { produto: "longo-dunas" });
    expect(again.ok).toBe(true);
    expect(again.text).toContain("já estava guardada");
    const looks = await db.select().from(schema.customerLooks);
    expect(looks).toHaveLength(1);
    expect(looks[0].photoWaMessageId).toBe(photoWaMessageId);
    expect(await db.select().from(schema.outboxEvents)).toHaveLength(1);
    const outOfRange = await executor("registrar_foto_com_a_peca", { produto: "longo-dunas", foto: 3 });
    expect(outOfRange.ok).toBe(false);
    expect(outOfRange.text).toContain("entre 1 e 2");
  });
});

describe("consentimento pelo webhook, aprovação e vitrine", () => {
  async function askedLook(): Promise<{ lookId: string; productId: string; conversationId: string }> {
    const { productId, variantId } = await seedProduct();
    const { customerId, conversationId, photoWaMessageId } = await seedConversationWithPhoto({ productId, variantId, delivered: true });
    const executor = buildToolExecutor(sdb, { conversationId, phoneE164: PHONE, customerId, lastInboundId: photoWaMessageId, recentImages: [{ waMessageId: photoWaMessageId, mediaUrl: PHOTO_URL }], now: NOW });
    await executor("registrar_foto_com_a_peca", { produto: "longo-dunas" });
    const [look] = await db.select({ id: schema.customerLooks.id }).from(schema.customerLooks);
    provider.setMediaFixture(PHOTO_URL, await photoJpeg(), "image/jpeg");
    await renderAndSendCustomerLookCard(sdb, provider, storage, render, { lookId: look.id }, { now: () => NOW });
    return { lookId: look.id, productId, conversationId };
  }

  const tap = (messageId: string, rowId: string, title: string, phone = PHONE_ZAPI) =>
    processZapiInbound(sdb, {
      providedSecret: SECRET,
      body: {
        type: "ReceivedCallback",
        instanceId: "instancia-x",
        messageId,
        phone,
        fromMe: false,
        isGroup: false,
        senderName: "Ana",
        momment: Date.now(),
        status: "RECEIVED",
        listResponseMessage: { message: title, title, selectedRowId: rowId },
      },
    });

  it("'Sim, pode' grava o consentimento, reescreve a mensagem com contexto, enfileira a confirmação e NÃO roda turno da Lia; a dona aprova e a foto entra na vitrine; retirar tira", async () => {
    const { lookId, productId } = await askedLook();
    const result = await tap("MSG-LOOK-1", lookRowId("sim", lookId), "Sim, pode");
    expect(result.action).toBe("look_consent");
    const [look] = await db.select().from(schema.customerLooks).where(eq(schema.customerLooks.id, lookId));
    expect(look.consentAnswer).toBe("sim");
    expect(look.consentAt).not.toBeNull();
    const [inbound] = await db.select().from(schema.waMessages).where(eq(schema.waMessages.zapiMessageId, "MSG-LOOK-1"));
    expect(inbound.body).toBe('[resposta a "Posso mostrar na página?" da foto com Longo Dunas]: Sim, pode');
    expect(look.consentWaMessageId).toBe(inbound.id);
    const events = await db.select().from(schema.outboxEvents);
    expect(events.some((event) => event.eventType === "wa.bot_turn")).toBe(false);
    const ack = events.find((event) => event.dedupeKey === `wa.look_consent_ack:${lookId}:sim`);
    expect(ack?.eventType).toBe("wa.send");
    expect((ack?.payload as { body: string }).body).toContain("assim que a equipe conferir");

    // Ainda não pública: falta a dona.
    expect(await listPublicLooksForProduct(sdb, productId)).toEqual([]);
    expect(await countPendingLooks(sdb)).toBe(1);
    expect((await listPendingLooks(sdb))[0]).toMatchObject({ id: lookId, displayName: "Ana", productName: "Longo Dunas", isPublic: false });
    expect(await listLooksMemoryLines(sdb, PHONE)).toEqual(["Foto dela com o Longo Dunas: ela autorizou; aguardando a equipe."]);

    const [user] = await db.insert(schema.users).values({ id: "00000000-0000-4000-8000-00000000d0a0", email: "dona@trive.test", role: "owner", fullName: "Dona" }).returning({ id: schema.users.id });
    expect(await approveCustomerLook(sdb, { lookId, userId: user.id, now: NOW })).toEqual({ approved: true });
    expect(await approveCustomerLook(sdb, { lookId, userId: user.id, now: NOW })).toEqual({ approved: false });
    const publicLooks = await listPublicLooksForProduct(sdb, productId);
    expect(publicLooks).toHaveLength(1);
    expect(publicLooks[0]).toMatchObject({ id: lookId, displayName: "Ana", photoPath: lookPhotoStoragePath(lookId) });
    expect(await countPublicLooksForProduct(sdb, productId)).toBe(1);
    expect(await countPendingLooks(sdb)).toBe(0);
    expect(await listLooksMemoryLines(sdb, PHONE)).toEqual(["Foto dela com o Longo Dunas: na página da peça."]);

    expect(await revokeCustomerLook(sdb, { lookId, userId: user.id, source: "owner", now: NOW }, storage)).toEqual({ revoked: true });
    expect(await listPublicLooksForProduct(sdb, productId)).toEqual([]);
    // Retirar apaga os arquivos do bucket e pede a revalidação da página da peça.
    expect(storage.has(lookPhotoStoragePath(lookId))).toBe(false);
    expect(storage.has(lookCardStoragePath(lookId))).toBe(false);
    const [gone] = await db.select().from(schema.customerLooks).where(eq(schema.customerLooks.id, lookId));
    expect(gone.photoPath).toBeNull();
    const revalidate = (await db.select().from(schema.outboxEvents)).filter((event) => event.eventType === "store.revalidate");
    expect(revalidate).toHaveLength(1);
    expect(revalidate[0].payload).toEqual({ paths: ["/produto/longo-dunas"] });
    const audits = await db.select().from(schema.auditLog);
    expect(audits.map((row) => row.action)).toEqual(expect.arrayContaining(["look.approve", "look.revoke"]));
  });

  it("'Prefiro que não' fica só entre nós; outro telefone não responde pela cliente; mudar de ideia vale (a última resposta) e tira da vitrine; o mesmo toque repetido não muda nada", async () => {
    const { lookId } = await askedLook();
    const other = await tap("MSG-LOOK-2", lookRowId("sim", lookId), "Sim, pode", "5511888880000");
    expect(other.action).not.toBe("look_consent");
    let [look] = await db.select().from(schema.customerLooks).where(eq(schema.customerLooks.id, lookId));
    expect(look.consentAnswer).toBeNull();

    expect((await tap("MSG-LOOK-3", lookRowId("nao", lookId), "Prefiro que não")).action).toBe("look_consent");
    [look] = await db.select().from(schema.customerLooks).where(eq(schema.customerLooks.id, lookId));
    expect(look.consentAnswer).toBe("nao");
    expect(await listPendingLooks(sdb)).toEqual([]);
    const ack = (await db.select().from(schema.outboxEvents)).find((event) => event.dedupeKey === `wa.look_consent_ack:${lookId}:nao`);
    expect((ack?.payload as { body: string }).body).toContain("fica só entre nós");

    // O mesmo toque de novo: nada muda.
    expect(await recordLookConsent(sdb, { lookId, phoneE164: PHONE, answer: "nao", waMessageId: look.consentWaMessageId as string, now: NOW })).toBeNull();

    // Ela muda de ideia: "Sim, pode" vale; a dona aprova; depois "Prefiro que não" tira da vitrine na hora.
    expect((await tap("MSG-LOOK-4", lookRowId("sim", lookId), "Sim, pode")).action).toBe("look_consent");
    [look] = await db.select().from(schema.customerLooks).where(eq(schema.customerLooks.id, lookId));
    expect(look.consentAnswer).toBe("sim");
    const [user] = await db.insert(schema.users).values({ id: "00000000-0000-4000-8000-00000000d0a1", email: "dona2@trive.test", role: "owner", fullName: "Dona" }).returning({ id: schema.users.id });
    expect(await approveCustomerLook(sdb, { lookId, userId: user.id, now: NOW })).toEqual({ approved: true });
    const [product] = await db.select({ id: schema.products.id }).from(schema.products);
    expect(await countPublicLooksForProduct(sdb, product.id)).toBe(1);
    expect((await tap("MSG-LOOK-4b", lookRowId("nao", lookId), "Prefiro que não")).action).toBe("look_consent");
    expect(await countPublicLooksForProduct(sdb, product.id)).toBe(0);
    const changed = (await db.select().from(schema.waMessages).where(eq(schema.waMessages.zapiMessageId, "MSG-LOOK-4b")))[0];
    expect(changed.body).toContain("Prefiro que não");
    const events = await db.select().from(schema.outboxEvents);
    expect(events.some((event) => event.eventType === "store.revalidate")).toBe(true);
    const ack2 = events.find((event) => event.dedupeKey === `wa.look_consent_ack:${lookId}:nao`);
    expect((ack2?.payload as { body: string }).body).toContain("fica só entre nós");
  });

  it("recusada pela dona não entra; 'esquecer minha cartela' e retirar_minha_foto retiram tudo do telefone", async () => {
    const { lookId, productId, conversationId } = await askedLook();
    await tap("MSG-LOOK-5", lookRowId("sim", lookId), "Sim, pode");
    const [user] = await db.insert(schema.users).values({ id: "00000000-0000-4000-8000-00000000d0a0", email: "dona@trive.test", role: "owner", fullName: "Dona" }).returning({ id: schema.users.id });
    expect(await rejectCustomerLook(sdb, { lookId, userId: user.id, now: NOW })).toEqual({ rejected: true });
    expect(await approveCustomerLook(sdb, { lookId, userId: user.id, now: NOW })).toEqual({ approved: false });
    expect(await listPublicLooksForProduct(sdb, productId)).toEqual([]);

    // Segunda foto, aprovada e pública; a cliente pede para tirar pela Lia.
    const second = await askedLookAgain(productId, conversationId);
    await tap("MSG-LOOK-6", lookRowId("sim", second), "Sim, pode");
    await approveCustomerLook(sdb, { lookId: second, userId: user.id, now: NOW });
    expect(await countPublicLooksForProduct(sdb, productId)).toBe(1);
    // Ela trocou de número: a conversa nova tem outro telefone, mas o cadastro é o mesmo.
    const [customer] = await db.select({ id: schema.customers.id }).from(schema.customers).where(eq(schema.customers.phoneE164, PHONE));
    const executor = buildToolExecutor(sdb, { conversationId, phoneE164: "+5511777770000", customerId: customer.id, lastInboundId: lookId });
    const removed = await executor("retirar_minha_foto", {});
    expect(removed.ok).toBe(true);
    expect(removed.text).toContain("saiu da página");
    expect(await countPublicLooksForProduct(sdb, productId)).toBe(0);
    expect(await listLooksMemoryLines(sdb, PHONE)).toEqual(expect.arrayContaining(["Foto dela com o Longo Dunas: retirada."]));
    expect((await executor("retirar_minha_foto", {})).text).toContain("Não havia foto");

    // Terceira foto pública; "esquecer a cartela" também retira.
    const third = await askedLookAgain(productId, conversationId);
    await tap("MSG-LOOK-7", lookRowId("sim", third), "Sim, pode");
    await approveCustomerLook(sdb, { lookId: third, userId: user.id, now: NOW });
    expect(await countPublicLooksForProduct(sdb, productId)).toBe(1);
    const profile = await saveStyleProfile(sdb, { phoneE164: PHONE, patch: { sizes: { vestido: "M" } }, source: "lia", consent: true });
    // Pelo site (token da cartela, sem prova de posse) as fotos ficam; pelo painel, saem.
    await forgetStyleProfile(sdb, { siteToken: profile.siteToken });
    expect(await countPublicLooksForProduct(sdb, productId)).toBe(1);
    const again = await saveStyleProfile(sdb, { phoneE164: PHONE, patch: { sizes: { vestido: "M" } }, source: "lia", consent: true });
    await forgetStyleProfile(sdb, { profileId: again.id, userId: user.id });
    expect(await countPublicLooksForProduct(sdb, productId)).toBe(0);
    const [revoked] = await db.select().from(schema.customerLooks).where(eq(schema.customerLooks.id, third));
    expect(revoked.revokedBy).toBe("forget");
    expect(revoked.photoPath).toBeNull();
  });

  async function askedLookAgain(productId: string, conversationId: string): Promise<string> {
    const [message] = await db
      .insert(schema.waMessages)
      .values({ conversationId, direction: "inbound", kind: "image", body: "", mediaUrl: PHOTO_URL, status: "delivered", zapiMessageId: `IMG-${Math.random().toString(36).slice(2, 8)}` })
      .returning({ id: schema.waMessages.id });
    const executor = buildToolExecutor(sdb, { conversationId, phoneE164: PHONE, customerId: null, lastInboundId: message.id, recentImages: [{ waMessageId: message.id, mediaUrl: PHOTO_URL }], now: NOW });
    await executor("registrar_foto_com_a_peca", { produto: "longo-dunas" });
    // A recém-registrada é a única ainda sem resposta.
    const looks = await db.select({ id: schema.customerLooks.id, consentAnswer: schema.customerLooks.consentAnswer }).from(schema.customerLooks).where(eq(schema.customerLooks.productId, productId));
    const newest = looks.find((look) => look.consentAnswer === null)!;
    provider.setMediaFixture(PHOTO_URL, await photoJpeg(), "image/jpeg");
    await renderAndSendCustomerLookCard(sdb, provider, storage, render, { lookId: newest.id }, { now: () => NOW });
    return newest.id;
  }
});
