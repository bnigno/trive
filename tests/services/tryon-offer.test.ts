// "Me vê com ela" — a Lia oferece, a cliente toca, a foto vai para a fila.
// Ponta a ponta com PGlite + fakes: detalhar_produto avisa quando PODE
// oferecer; oferecer_previa manda a pergunta tocável e conta UMA vez; o
// toque volta pelo webhook (consentimento desta prévia, sem turno da Lia);
// vestir_em_mim só funciona depois do toque; "Agora não" e SAIR silenciam;
// o caderninho conta em que pé está; o funil soma no painel.
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { tryOnRowId } from "@/core/tryon/offer";
import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { TRYON_EVENT } from "@/services/tryon";
import { declinePendingTryOns, findTryOnForPhoto, recordTryOnAnswer, tryOnFunnel, tryOnMemoryLines } from "@/services/tryon-offer";
import { buildToolExecutor } from "@/services/wa-bot";
import { processZapiInbound } from "@/services/wa-inbound";
import { createTestDb, type TestDb } from "../helpers/db";

vi.mock("@/inngest/client", () => ({ inngest: { send: async () => ({ ids: [] }) } }));

const SECRET = "segredo-webhook-zapi";
const PHONE = "+5511999990000";
const PHONE_ZAPI = "5511999990000";
// O webhook usa o relógio real (o toque grava a hora de agora): o teste inteiro anda nele.
const NOW = new Date();
const PHOTO_URL = "https://zapi.example/media/foto-ana.jpg";

let db: TestDb;
let close: () => Promise<void>;
const sdb = () => db as unknown as DbOrTx;
const originalSecret = process.env.ZAPI_WEBHOOK_SECRET;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  vi.stubEnv("ADAPTER_MODE", "fake");
  process.env.ZAPI_WEBHOOK_SECRET = SECRET;
  await db.insert(schema.settings).values([
    { key: "wa_enabled", value: true },
    { key: "bot_enabled", value: true },
    { key: "tryon_enabled", value: true },
    { key: "tryon_per_customer_daily", value: 2 },
    { key: "tryon_daily_total", value: 20 },
  ]);
});

afterEach(async () => {
  await close();
  vi.unstubAllEnvs();
  if (originalSecret === undefined) delete process.env.ZAPI_WEBHOOK_SECRET;
  else process.env.ZAPI_WEBHOOK_SECRET = originalSecret;
});

/** Peça pública com preço e estoque (a Lia só acha o que a vitrine mostra). */
async function seedProduct(input: { name: string; slug: string; pieceType: string; onHand?: number }) {
  const [product] = await db
    .insert(schema.products)
    .values({ name: input.name, slug: input.slug, status: "active", pieceType: input.pieceType, attributesSchema: ["cor", "tamanho"] })
    .returning({ id: schema.products.id });
  const [variant] = await db
    .insert(schema.productVariants)
    .values({ productId: product!.id, sku: `${input.slug.toUpperCase()}-M`, attributes: { cor: "Vinho", tamanho: "M" }, costCents: 100 })
    .returning({ id: schema.productVariants.id });
  await db.insert(schema.stockLevels).values({ productVariantId: variant!.id, onHand: input.onHand ?? 5, reserved: 0 });
  await db.insert(schema.priceVersions).values({
    productVariantId: variant!.id,
    versionNumber: 1,
    status: "active",
    priceCents: 18990,
    origin: "initial",
    breakdown: {},
    costSnapshotCents: 100,
    computedMarginRate: "0.3000",
    activatedAt: NOW,
  });
  return product!.id;
}

async function seedConversation() {
  const [conversation] = await db.insert(schema.waConversations).values({ phoneE164: PHONE }).returning({ id: schema.waConversations.id });
  const [photo] = await db
    .insert(schema.waMessages)
    .values({ conversationId: conversation!.id, direction: "inbound", kind: "image", body: "", mediaUrl: PHOTO_URL, status: "delivered", zapiMessageId: "IMG-1" })
    .returning({ id: schema.waMessages.id });
  return { conversationId: conversation!.id, photoId: photo!.id };
}

function executor(conversationId: string, input: { photoId?: string; attachments?: unknown[] } = {}) {
  return buildToolExecutor(sdb(), {
    conversationId,
    phoneE164: PHONE,
    customerId: null,
    lastInboundId: input.photoId ?? "00000000-0000-4000-8000-000000000999",
    recentImages: input.photoId ? [{ waMessageId: input.photoId, mediaUrl: PHOTO_URL }] : [],
    onAttachment: (attachment) => input.attachments?.push(attachment),
    now: NOW,
  });
}

const tap = (messageId: string, rowId: string, title: string) =>
  processZapiInbound(sdb(), {
    providedSecret: SECRET,
    body: {
      type: "ReceivedCallback",
      instanceId: "instancia-x",
      messageId,
      phone: PHONE_ZAPI,
      fromMe: false,
      isGroup: false,
      senderName: "Ana",
      momment: Date.now(),
      status: "RECEIVED",
      listResponseMessage: { message: title, title, selectedRowId: rowId },
    },
  });

async function requests() {
  return db.select().from(schema.tryonRequests);
}

describe("detalhar_produto avisa quando a Lia PODE oferecer", () => {
  it("roupa com estoque e prévia ligada: a linha aparece; acessório, esgotada ou desligada: não", async () => {
    await seedProduct({ name: "VESTIDO AMORA", slug: "vestido-amora", pieceType: "vestido" });
    await seedProduct({ name: "BOLSA LUA", slug: "bolsa-lua", pieceType: "bolsa" });
    await seedProduct({ name: "BLUSA SEM ESTOQUE", slug: "blusa-sem", pieceType: "blusa", onHand: 0 });
    const { conversationId } = await seedConversation();
    const run = executor(conversationId);
    expect((await run("detalhar_produto", { produto: "vestido-amora" })).text).toContain("PRÉVIA NA FOTO DELA");
    expect((await run("detalhar_produto", { produto: "bolsa-lua" })).text).not.toContain("PRÉVIA NA FOTO DELA");
    expect((await run("detalhar_produto", { produto: "blusa-sem" })).text).not.toContain("PRÉVIA NA FOTO DELA");
    await db.update(schema.settings).set({ value: false }).where(eq(schema.settings.key, "tryon_enabled"));
    expect((await run("detalhar_produto", { produto: "vestido-amora" })).text).not.toContain("PRÉVIA NA FOTO DELA");
  });
});

describe("oferecer_previa → toque → vestir_em_mim", () => {
  it("o caminho completo: a pergunta tocável, 'Quero me ver' (sem turno da Lia), a foto dela vai para a fila", async () => {
    await seedProduct({ name: "VESTIDO AMORA", slug: "vestido-amora", pieceType: "vestido" });
    const { conversationId } = await seedConversation();
    const attachments: unknown[] = [];
    const offered = await executor(conversationId, { attachments })("oferecer_previa", { produto: "vestido-amora", cor: "Vinho" });
    expect(offered.ok).toBe(true);
    expect(offered.text).toContain("NÃO repita a oferta");
    const [offer] = await requests();
    expect(offer).toMatchObject({ status: "offered", color: "Vinho", acceptedAt: null, photoWaMessageId: null });
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({ kind: "option_list", title: "Quer se ver com ela?" });
    expect(JSON.stringify(attachments[0])).toContain(tryOnRowId("quero", offer!.id));
    // Nesta conversa, a Lia não oferece de novo; e detalhar_produto para de avisar.
    expect((await executor(conversationId)("oferecer_previa", { produto: "vestido-amora" })).ok).toBe(false);
    expect((await executor(conversationId)("detalhar_produto", { produto: "vestido-amora" })).text).not.toContain("PRÉVIA NA FOTO DELA");

    // Antes do toque, a foto dela não vai para a IA.
    const before = await executor(conversationId, { photoId: (await seedPhoto(conversationId, "IMG-0")) })("vestir_em_mim", {});
    expect(before.ok).toBe(false);
    expect(before.text).toContain("Quero me ver");

    const result = await tap("TAP-1", tryOnRowId("quero", offer!.id), "Quero me ver");
    expect(result.action).toBe("tryon_answer");
    const [accepted] = await requests();
    expect(accepted).toMatchObject({ status: "awaiting_photo", consentVersion: "previa-v1-2026-10" });
    expect(accepted!.acceptedAt).not.toBeNull();
    const events = await db.select().from(schema.outboxEvents);
    expect(events.some((event) => event.eventType === "wa.bot_turn")).toBe(false);
    const ack = events.find((event) => event.dedupeKey === `wa.bot_tryon:${offer!.id}:resposta:quero`);
    expect((ack?.payload as { body: string }).body).toContain("corpo inteiro");
    const [tapMessage] = await db.select().from(schema.waMessages).where(eq(schema.waMessages.zapiMessageId, "TAP-1"));
    expect(tapMessage!.body).toBe('[resposta à pergunta "Quer se ver com ela?" (VESTIDO AMORA)]: Quero me ver');
    expect(await tryOnMemoryLines(sdb(), { conversationId, now: NOW })).toEqual([
      'Ela tocou "Quero me ver" (VESTIDO AMORA (Vinho)): quando a foto DELA chegar, chame vestir_em_mim — não pergunte de novo.',
    ]);

    // A foto chega: vestir_em_mim põe na fila (sem kick: o turno dá depois do commit).
    const photoId = await seedPhoto(conversationId, "IMG-2");
    const queued = await executor(conversationId, { photoId })("vestir_em_mim", {});
    expect(queued.ok).toBe(true);
    expect(queued.text).toContain("Não comente o corpo dela");
    const [row] = await requests();
    expect(row).toMatchObject({ status: "queued", photoWaMessageId: photoId });
    expect((await db.select().from(schema.outboxEvents)).some((event) => event.eventType === TRYON_EVENT)).toBe(true);
    expect((await executor(conversationId, { photoId })("vestir_em_mim", {})).ok).toBe(false);
  });

  it("oferta COM a foto dela: o 'Quero me ver' já põe na fila e responde que está vestindo", async () => {
    await seedProduct({ name: "VESTIDO AMORA", slug: "vestido-amora", pieceType: "vestido" });
    const { conversationId, photoId } = await seedConversation();
    const attachments: unknown[] = [];
    await executor(conversationId, { photoId, attachments })("oferecer_previa", { produto: "vestido-amora", com_a_foto_dela: true });
    expect(JSON.stringify(attachments[0])).toContain("nessa sua foto");
    const [offer] = await requests();
    expect(offer!.photoWaMessageId).toBe(photoId);
    const result = await tap("TAP-2", tryOnRowId("quero", offer!.id), "Quero me ver");
    expect(result).toMatchObject({ action: "tryon_answer", tryOnEventId: expect.any(String) });
    expect((await requests())[0]).toMatchObject({ status: "queued" });
    const ack = (await db.select().from(schema.outboxEvents)).find((event) => event.dedupeKey === `wa.bot_tryon:${offer!.id}:resposta:quero`);
    expect((ack?.payload as { body: string }).body).toContain("Tô te vestindo");
  });

  it("'Agora não': silencia por 30 dias (a não ser que ela peça); toque repetido não repete nada; toque de outra conversa ou velho vira texto para a Lia", async () => {
    await seedProduct({ name: "VESTIDO AMORA", slug: "vestido-amora", pieceType: "vestido" });
    const { conversationId } = await seedConversation();
    await executor(conversationId)("oferecer_previa", { produto: "vestido-amora" });
    const [offer] = await requests();
    expect((await tap("TAP-3", tryOnRowId("agora_nao", offer!.id), "Agora não")).action).toBe("tryon_answer");
    expect((await requests())[0]).toMatchObject({ status: "declined" });
    expect(await tryOnMemoryLines(sdb(), { conversationId, now: NOW })).toEqual(['Ela respondeu "Agora não" à prévia (VESTIDO AMORA): não ofereça de novo; ela pode pedir.']);
    const later = new Date(NOW.getTime() + 2 * 86_400_000);
    const run = buildToolExecutor(sdb(), { conversationId, phoneE164: PHONE, customerId: null, lastInboundId: "00000000-0000-4000-8000-000000000998", now: later });
    expect((await run("oferecer_previa", { produto: "vestido-amora" })).text).toContain("Agora não");
    expect((await run("oferecer_previa", { produto: "vestido-amora", ela_pediu: true })).ok).toBe(true);

    // Repetido: nada muda, nenhuma resposta nova.
    const acks = async () => (await db.select().from(schema.outboxEvents)).filter((event) => event.dedupeKey?.includes(":resposta:"));
    const before = (await acks()).length;
    expect(await recordTryOnAnswer(sdb(), { requestId: offer!.id, answer: "agora_nao", conversationId, now: NOW })).toMatchObject({ ackEventId: null });
    expect((await acks()).length).toBe(before);
    // De outra conversa, ou depois de 24 h: não é com esta oferta.
    expect(await recordTryOnAnswer(sdb(), { requestId: offer!.id, answer: "quero", conversationId: "00000000-0000-4000-8000-0000000000aa", now: NOW })).toBeNull();
    expect(await recordTryOnAnswer(sdb(), { requestId: offer!.id, answer: "quero", conversationId, now: later })).toBeNull();
  });

  it("acessório e prévia desligada: oferecer_previa recusa sem criar nada", async () => {
    await seedProduct({ name: "BOLSA LUA", slug: "bolsa-lua", pieceType: "bolsa" });
    await seedProduct({ name: "VESTIDO AMORA", slug: "vestido-amora", pieceType: "vestido" });
    const { conversationId } = await seedConversation();
    expect((await executor(conversationId)("oferecer_previa", { produto: "bolsa-lua" })).text).toContain("só roupa");
    await db.update(schema.settings).set({ value: false }).where(eq(schema.settings.key, "tryon_enabled"));
    expect((await executor(conversationId)("oferecer_previa", { produto: "vestido-amora" })).text).toContain("desligada");
    expect(await requests()).toHaveLength(0);
  });
});

async function seedPhoto(conversationId: string, zapiMessageId: string): Promise<string> {
  const [photo] = await db
    .insert(schema.waMessages)
    .values({ conversationId, direction: "inbound", kind: "image", body: "", mediaUrl: `${PHOTO_URL}?${zapiMessageId}`, status: "delivered", zapiMessageId })
    .returning({ id: schema.waMessages.id });
  return photo!.id;
}

describe("outra foto depois da recusa, SAIR e o funil", () => {
  it("foto recusada na checagem: a próxima foto dela vira pedido novo com o MESMO consentimento", async () => {
    const productId = await seedProduct({ name: "VESTIDO AMORA", slug: "vestido-amora", pieceType: "vestido" });
    const { conversationId } = await seedConversation();
    await db.insert(schema.tryonRequests).values({ conversationId, phoneE164: PHONE, productId, status: "photo_rejected", acceptedAt: NOW, consentVersion: "previa-v1-2026-10", queuedAt: NOW });
    const found = await findTryOnForPhoto(sdb(), { conversationId, now: new Date(NOW.getTime() + 60_000) });
    expect(found.kind).toBe("ready");
    if (found.kind === "ready") expect(found.request).toMatchObject({ status: "awaiting_photo", consentVersion: "previa-v1-2026-10", productId });
    expect(await requests()).toHaveLength(2);
    // Passadas 2 h do toque, precisa de toque novo.
    expect((await findTryOnForPhoto(sdb(), { conversationId, now: new Date(NOW.getTime() + 3 * 3_600_000) })).kind).toBe("none");
  });

  it("SAIR: oferta e aceite sem foto param; o que está com a FASHN segue", async () => {
    const productId = await seedProduct({ name: "VESTIDO AMORA", slug: "vestido-amora", pieceType: "vestido" });
    const { conversationId } = await seedConversation();
    await db.insert(schema.tryonRequests).values([
      { conversationId, phoneE164: PHONE, productId, status: "offered" },
      { conversationId, phoneE164: PHONE, productId, status: "awaiting_photo", acceptedAt: NOW },
      { conversationId, phoneE164: PHONE, productId, status: "processing", acceptedAt: NOW, vendorJobId: "job-1" },
    ]);
    expect(await declinePendingTryOns(sdb(), { conversationId, now: NOW })).toBe(2);
    expect((await requests()).map((row) => row.status).sort()).toEqual(["declined", "declined", "processing"]);
  });

  it("o funil do mês: ofertas → toques → prévias → compraram em até 7 dias → gasto", async () => {
    const productId = await seedProduct({ name: "VESTIDO AMORA", slug: "vestido-amora", pieceType: "vestido" });
    const { conversationId } = await seedConversation();
    const [customer] = await db.insert(schema.customers).values({ fullName: "Ana", phoneE164: PHONE }).returning({ id: schema.customers.id });
    await db.insert(schema.tryonRequests).values([
      { conversationId, phoneE164: PHONE, productId, status: "declined", offeredAt: NOW },
      { conversationId, phoneE164: PHONE, productId, status: "sent", offeredAt: NOW, acceptedAt: NOW, sentAt: NOW, usdCents: 28, createdAt: NOW },
    ]);
    await db.insert(schema.orders).values({ customerId: customer!.id, status: "paid", channel: "whatsapp", subtotalCents: 18990, shippingCents: 0, totalCents: 18990, paidAt: new Date(NOW.getTime() + 2 * 86_400_000) });
    const funnel = await tryOnFunnel(sdb(), { from: new Date(NOW.getTime() - 86_400_000), to: new Date(NOW.getTime() + 30 * 86_400_000) });
    expect(funnel).toEqual({ offered: 2, accepted: 1, sent: 1, bought: 1, usdCents: 28 });
  });
});
