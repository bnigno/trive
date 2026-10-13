// "Me vê com ela" — a Lia oferece, a cliente toca, a foto vai para a fila.
// Ponta a ponta com PGlite + fakes: detalhar_produto avisa quando PODE
// oferecer (e só onde dá para mandar a pergunta tocável); oferecer_previa
// conta UMA vez por dia; o toque volta pelo webhook (consentimento desta
// prévia, sem turno da Lia, só com a Lia atendendo a conversa);
// vestir_em_mim só funciona depois do toque e com foto de DEPOIS da
// pergunta; foto recusada por problema da foto reabre a MESMA prévia (nunca
// o "não pode"); "Agora não" e SAIR valem até a foto ir à FASHN; o
// caderninho conta em que pé está; o funil soma no painel.
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

/** Peça pública com preço, estoque e foto real (a Lia só acha o que a vitrine mostra; a prévia precisa da foto). */
async function seedProduct(input: { name: string; slug: string; pieceType: string; onHand?: number; photo?: boolean }) {
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
  if (input.photo !== false) {
    await db.insert(schema.productImages).values({ productId: product!.id, storagePath: `products/${input.slug}/a-full.webp`, origin: "upload", color: "Vinho", sortOrder: 0 });
  }
  return product!.id;
}

async function seedConversation(input: { photoBeforeOffer?: boolean; phone?: string } = {}) {
  const [conversation] = await db.insert(schema.waConversations).values({ phoneE164: input.phone ?? PHONE }).returning({ id: schema.waConversations.id });
  const photoId = input.photoBeforeOffer
    ? await seedPhoto(conversation!.id, "IMG-1", new Date(NOW.getTime() - 60_000))
    : null;
  return { conversationId: conversation!.id, photoId };
}

async function seedPhoto(conversationId: string, zapiMessageId: string, createdAt = new Date()): Promise<string> {
  const [photo] = await db
    .insert(schema.waMessages)
    .values({ conversationId, direction: "inbound", kind: "image", body: "", mediaUrl: `${PHOTO_URL}?${zapiMessageId}`, status: "delivered", zapiMessageId, createdAt })
    .returning({ id: schema.waMessages.id });
  return photo!.id;
}

function executor(conversationId: string, input: { photoIds?: string[]; attachments?: unknown[]; now?: Date; proactive?: boolean; copilot?: boolean } = {}) {
  return buildToolExecutor(sdb(), {
    conversationId,
    phoneE164: PHONE,
    customerId: null,
    lastInboundId: input.photoIds?.at(-1) ?? "00000000-0000-4000-8000-000000000999",
    recentImages: (input.photoIds ?? []).map((id) => ({ waMessageId: id, mediaUrl: PHOTO_URL })),
    onAttachment: (attachment) => input.attachments?.push(attachment),
    now: input.now ?? new Date(),
    ...(input.proactive ? { proactive: true } : {}),
    ...(input.copilot ? { copilot: true } : {}),
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

async function acksFor(requestId: string): Promise<string[]> {
  const events = await db.select().from(schema.outboxEvents);
  return events.filter((event) => event.dedupeKey?.startsWith(`wa.bot_tryon:${requestId}:resposta:`)).map((event) => (event.payload as { body: string }).body);
}

describe("detalhar_produto avisa quando a Lia PODE oferecer", () => {
  it("roupa com foto e estoque, prévia ligada: a linha aparece; acessório, esgotada, sem foto real ou desligada: não", async () => {
    await seedProduct({ name: "VESTIDO AMORA", slug: "vestido-amora", pieceType: "vestido" });
    await seedProduct({ name: "BOLSA LUA", slug: "bolsa-lua", pieceType: "bolsa" });
    await seedProduct({ name: "BLUSA SEM ESTOQUE", slug: "blusa-sem", pieceType: "blusa", onHand: 0 });
    await seedProduct({ name: "SAIA SEM FOTO", slug: "saia-sem-foto", pieceType: "saia", photo: false });
    const { conversationId } = await seedConversation();
    const run = executor(conversationId);
    expect((await run("detalhar_produto", { produto: "vestido-amora" })).text).toContain("PRÉVIA NA FOTO DELA");
    for (const produto of ["bolsa-lua", "blusa-sem", "saia-sem-foto"]) {
      expect((await run("detalhar_produto", { produto })).text).not.toContain("PRÉVIA NA FOTO DELA");
    }
    await db.update(schema.settings).set({ value: false }).where(eq(schema.settings.key, "tryon_enabled"));
    expect((await run("detalhar_produto", { produto: "vestido-amora" })).text).not.toContain("PRÉVIA NA FOTO DELA");
  });

  it("não no copiloto nem na retomada por conta própria (lá não sai a pergunta tocável)", async () => {
    await seedProduct({ name: "VESTIDO AMORA", slug: "vestido-amora", pieceType: "vestido" });
    const { conversationId } = await seedConversation();
    expect((await executor(conversationId, { copilot: true })("detalhar_produto", { produto: "vestido-amora" })).text).not.toContain("PRÉVIA NA FOTO DELA");
    expect((await executor(conversationId, { proactive: true })("detalhar_produto", { produto: "vestido-amora" })).text).not.toContain("PRÉVIA NA FOTO DELA");
    const proactiveOffer = await executor(conversationId, { proactive: true })("oferecer_previa", { produto: "vestido-amora" });
    expect(proactiveOffer.ok).toBe(false);
    expect(await requests()).toHaveLength(0);
  });
});

describe("oferecer_previa → toque → vestir_em_mim", () => {
  it("o caminho completo: a pergunta tocável, 'Quero me ver' (sem turno da Lia), a foto NOVA dela vai para a fila", async () => {
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
    // Nesta conversa, a Lia não oferece de novo hoje; e detalhar_produto para de avisar.
    expect((await executor(conversationId)("oferecer_previa", { produto: "vestido-amora" })).ok).toBe(false);
    expect((await executor(conversationId)("detalhar_produto", { produto: "vestido-amora" })).text).not.toContain("PRÉVIA NA FOTO DELA");

    // Antes do toque, nada vai para a IA — a Lia lembra do botão (não oferece de novo).
    const before = await executor(conversationId)("vestir_em_mim", {});
    expect(before.ok).toBe(false);
    expect(before.text).toContain("ainda não tocou");

    const result = await tap("TAP-1", tryOnRowId("quero", offer!.id), "Quero me ver");
    expect(result.action).toBe("tryon_answer");
    const [accepted] = await requests();
    expect(accepted).toMatchObject({ status: "awaiting_photo", consentVersion: "previa-v1-2026-10" });
    expect(accepted!.acceptedAt).not.toBeNull();
    const events = await db.select().from(schema.outboxEvents);
    expect(events.some((event) => event.eventType === "wa.bot_turn")).toBe(false);
    expect(await acksFor(offer!.id)).toEqual([expect.stringContaining("corpo inteiro")]);
    const [tapMessage] = await db.select().from(schema.waMessages).where(eq(schema.waMessages.zapiMessageId, "TAP-1"));
    expect(tapMessage!.body).toBe('[resposta à pergunta "Quer se ver com ela?" (VESTIDO AMORA)]: Quero me ver');
    expect(await tryOnMemoryLines(sdb(), { conversationId, now: new Date() })).toEqual([
      'Ela tocou "Quero me ver" (VESTIDO AMORA (Vinho)): quando a foto DELA chegar, chame vestir_em_mim — não pergunte de novo.',
    ]);

    // A foto chega: vestir_em_mim põe na fila (sem kick: o turno dá depois do commit).
    const photoId = await seedPhoto(conversationId, "IMG-2");
    const queued = await executor(conversationId, { photoIds: [photoId] })("vestir_em_mim", {});
    expect(queued.ok).toBe(true);
    expect(queued.text).toContain("Não comente o corpo dela");
    const [row] = await requests();
    expect(row).toMatchObject({ status: "queued", photoWaMessageId: photoId });
    expect((await db.select().from(schema.outboxEvents)).some((event) => event.eventType === TRYON_EVENT)).toBe(true);
    expect((await executor(conversationId, { photoIds: [photoId] })("vestir_em_mim", {})).ok).toBe(false);
  });

  it("foto de ANTES da pergunta (um print) não vira 'a foto dela': vestir_em_mim espera a nova", async () => {
    await seedProduct({ name: "VESTIDO AMORA", slug: "vestido-amora", pieceType: "vestido" });
    const { conversationId, photoId: print } = await seedConversation({ photoBeforeOffer: true });
    await executor(conversationId, { attachments: [] })("oferecer_previa", { produto: "vestido-amora" });
    const [offer] = await requests();
    await tap("TAP-P", tryOnRowId("quero", offer!.id), "Quero me ver");
    const old = await executor(conversationId, { photoIds: [print!] })("vestir_em_mim", {});
    expect(old.ok).toBe(false);
    expect(old.text).toContain("de antes da pergunta");
    expect((await requests())[0]).toMatchObject({ status: "awaiting_photo" });
  });

  it("ela mandou a foto ANTES de tocar: o 'Quero me ver' já usa essa foto e diz que está vestindo", async () => {
    await seedProduct({ name: "VESTIDO AMORA", slug: "vestido-amora", pieceType: "vestido" });
    const { conversationId } = await seedConversation();
    await executor(conversationId, { attachments: [] })("oferecer_previa", { produto: "vestido-amora" });
    const [offer] = await requests();
    const photoId = await seedPhoto(conversationId, "IMG-ANTES-DO-TOQUE", new Date(Date.now() + 1_000));
    const result = await tap("TAP-F", tryOnRowId("quero", offer!.id), "Quero me ver");
    expect(result).toMatchObject({ action: "tryon_answer", tryOnEventId: expect.any(String) });
    expect((await requests())[0]).toMatchObject({ status: "queued", photoWaMessageId: photoId });
    expect(await acksFor(offer!.id)).toEqual([expect.stringContaining("Tô te vestindo")]);
  });

  it("oferta COM a foto dela: o 'Quero me ver' já põe na fila e responde que está vestindo", async () => {
    await seedProduct({ name: "VESTIDO AMORA", slug: "vestido-amora", pieceType: "vestido" });
    const { conversationId, photoId } = await seedConversation({ photoBeforeOffer: true });
    const attachments: unknown[] = [];
    await executor(conversationId, { photoIds: [photoId!], attachments })("oferecer_previa", { produto: "vestido-amora", com_a_foto_dela: true });
    expect(JSON.stringify(attachments[0])).toContain("nessa sua foto");
    const [offer] = await requests();
    expect(offer!.photoWaMessageId).toBe(photoId);
    const result = await tap("TAP-2", tryOnRowId("quero", offer!.id), "Quero me ver");
    expect(result).toMatchObject({ action: "tryon_answer", tryOnEventId: expect.any(String) });
    expect((await requests())[0]).toMatchObject({ status: "queued" });
    expect(await acksFor(offer!.id)).toEqual([expect.stringContaining("Tô te vestindo")]);
  });

  it("'Agora não': silencia por 30 dias (a não ser que ela peça); repetido não responde de novo; outra conversa ou 24 h depois vira texto", async () => {
    await seedProduct({ name: "VESTIDO AMORA", slug: "vestido-amora", pieceType: "vestido" });
    const { conversationId } = await seedConversation();
    await executor(conversationId, { attachments: [] })("oferecer_previa", { produto: "vestido-amora" });
    const [offer] = await requests();
    expect((await tap("TAP-3", tryOnRowId("agora_nao", offer!.id), "Agora não")).action).toBe("tryon_answer");
    expect((await requests())[0]).toMatchObject({ status: "declined" });
    expect(await tryOnMemoryLines(sdb(), { conversationId, now: new Date() })).toEqual(['Ela respondeu "Agora não" à prévia (VESTIDO AMORA): não ofereça de novo; ela pode pedir.']);
    const later = new Date(Date.now() + 2 * 86_400_000);
    const run = executor(conversationId, { attachments: [], now: later });
    expect((await run("oferecer_previa", { produto: "vestido-amora" })).text).toContain("Agora não");
    expect((await run("oferecer_previa", { produto: "vestido-amora", ela_pediu: true })).ok).toBe(true);

    expect(await recordTryOnAnswer(sdb(), { requestId: offer!.id, answer: "agora_nao", conversationId, tapMessageId: "00000000-0000-4000-8000-0000000000bb", now: new Date() })).toMatchObject({ ackEventId: null });
    expect(await acksFor(offer!.id)).toHaveLength(1);
    expect(await recordTryOnAnswer(sdb(), { requestId: offer!.id, answer: "quero", conversationId: "00000000-0000-4000-8000-0000000000aa", tapMessageId: "x", now: new Date() })).toBeNull();
    expect(await recordTryOnAnswer(sdb(), { requestId: offer!.id, answer: "quero", conversationId, tapMessageId: "y", now: later })).toBeNull();
  });

  it("'Quero me ver' → 'Agora não' → 'Quero me ver': cada toque tem a sua resposta", async () => {
    await seedProduct({ name: "VESTIDO AMORA", slug: "vestido-amora", pieceType: "vestido" });
    const { conversationId } = await seedConversation();
    await executor(conversationId, { attachments: [] })("oferecer_previa", { produto: "vestido-amora" });
    const [offer] = await requests();
    await tap("TAP-Q1", tryOnRowId("quero", offer!.id), "Quero me ver");
    await tap("TAP-N", tryOnRowId("agora_nao", offer!.id), "Agora não");
    await tap("TAP-Q2", tryOnRowId("quero", offer!.id), "Quero me ver");
    expect((await requests())[0]).toMatchObject({ status: "awaiting_photo", declinedAt: null });
    expect(await acksFor(offer!.id)).toHaveLength(3);
  });

  it("'Agora não' depois de entrar na fila (antes da FASHN): cancela, e nada vai à IA", async () => {
    await seedProduct({ name: "VESTIDO AMORA", slug: "vestido-amora", pieceType: "vestido" });
    const { conversationId, photoId } = await seedConversation({ photoBeforeOffer: true });
    await executor(conversationId, { photoIds: [photoId!], attachments: [] })("oferecer_previa", { produto: "vestido-amora", com_a_foto_dela: true });
    const [offer] = await requests();
    await tap("TAP-Q", tryOnRowId("quero", offer!.id), "Quero me ver");
    expect((await requests())[0]).toMatchObject({ status: "queued" });
    await tap("TAP-N2", tryOnRowId("agora_nao", offer!.id), "Agora não");
    expect((await requests())[0]).toMatchObject({ status: "failed", failureReason: "cliente_desistiu" });
    expect((await acksFor(offer!.id)).at(-1)).toContain("Não vou fazer a prévia");
  });

  it("com a equipe no comando da conversa, o toque não grava consentimento (vira texto para a equipe)", async () => {
    await seedProduct({ name: "VESTIDO AMORA", slug: "vestido-amora", pieceType: "vestido" });
    const { conversationId } = await seedConversation();
    await executor(conversationId, { attachments: [] })("oferecer_previa", { produto: "vestido-amora" });
    const [offer] = await requests();
    await db.update(schema.waConversations).set({ botDisabledUntil: new Date(Date.now() + 3_600_000) }).where(eq(schema.waConversations.id, conversationId));
    expect((await tap("TAP-H", tryOnRowId("quero", offer!.id), "Quero me ver")).action).not.toBe("tryon_answer");
    expect((await requests())[0]).toMatchObject({ status: "offered", acceptedAt: null });
  });

  it("acessório, cor que a peça não tem e prévia desligada: oferecer_previa recusa sem criar nada", async () => {
    await seedProduct({ name: "BOLSA LUA", slug: "bolsa-lua", pieceType: "bolsa" });
    await seedProduct({ name: "VESTIDO AMORA", slug: "vestido-amora", pieceType: "vestido" });
    const { conversationId } = await seedConversation();
    expect((await executor(conversationId, { attachments: [] })("oferecer_previa", { produto: "bolsa-lua" })).text).toContain("só roupa");
    expect((await executor(conversationId, { attachments: [] })("oferecer_previa", { produto: "vestido-amora", cor: "Lilás" })).text).toContain("Essa cor");
    await db.update(schema.settings).set({ value: false }).where(eq(schema.settings.key, "tryon_enabled"));
    expect((await executor(conversationId, { attachments: [] })("oferecer_previa", { produto: "vestido-amora" })).text).toContain("desligada");
    expect(await requests()).toHaveLength(0);
  });
});

describe("foto que não serviu, SAIR e o funil", () => {
  async function rejected(failureReason: string, extra: Partial<typeof schema.tryonRequests.$inferInsert> = {}) {
    const productId = await seedProduct({ name: "VESTIDO AMORA", slug: "vestido-amora", pieceType: "vestido" });
    const { conversationId } = await seedConversation();
    const at = new Date(Date.now() - 60_000);
    const [row] = await db
      .insert(schema.tryonRequests)
      .values({ conversationId, phoneE164: PHONE, productId, status: "photo_rejected", failureReason, offeredAt: at, acceptedAt: at, queuedAt: at, consentVersion: "previa-v1-2026-10", ...extra })
      .returning();
    return { conversationId, request: row! };
  }

  it("foto recusada por enquadramento: a foto NOVA dela reabre a MESMA prévia (mesmo toque, uma linha só)", async () => {
    const { conversationId, request } = await rejected("enquadramento");
    expect((await findTryOnForPhoto(sdb(), { conversationId, now: new Date() })).kind).toBe("reopen");
    const photoId = await seedPhoto(conversationId, "IMG-NOVA");
    expect((await executor(conversationId, { photoIds: [photoId] })("vestir_em_mim", {})).ok).toBe(true);
    const rows = await requests();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: request.id, status: "queued", photoWaMessageId: photoId, photoCheck: null, failureReason: null });
  });

  it("'não pode' (possível menor ou nudez): nunca reabre — e o caderninho manda seguir sem prévia", async () => {
    const { conversationId } = await rejected("nao_pode");
    expect((await findTryOnForPhoto(sdb(), { conversationId, now: new Date() })).kind).toBe("none");
    const photoId = await seedPhoto(conversationId, "IMG-NOVA");
    expect((await executor(conversationId, { photoIds: [photoId] })("vestir_em_mim", {})).ok).toBe(false);
    expect((await tryOnMemoryLines(sdb(), { conversationId, now: new Date() }))[0]).toContain("não ofereça de novo hoje");
  });

  it("'Agora não' (ou SAIR) depois da foto recusada: não reabre", async () => {
    const { conversationId, request } = await rejected("enquadramento");
    await recordTryOnAnswer(sdb(), { requestId: request.id, answer: "agora_nao", conversationId, tapMessageId: "t-1", now: new Date() });
    expect((await findTryOnForPhoto(sdb(), { conversationId, now: new Date() })).kind).toBe("none");
  });

  it("passadas 2 h do toque, a foto nova precisa de toque novo", async () => {
    const { conversationId } = await rejected("enquadramento");
    expect((await findTryOnForPhoto(sdb(), { conversationId, now: new Date(Date.now() + 3 * 3_600_000) })).kind).toBe("none");
  });

  it("SAIR: oferta e aceite sem foto viram 'Agora não', o que está na fila é cancelado, o que está com a FASHN segue", async () => {
    const productId = await seedProduct({ name: "VESTIDO AMORA", slug: "vestido-amora", pieceType: "vestido" });
    const { conversationId } = await seedConversation();
    const other = await seedConversation({ phone: "+5511988887777" });
    await db.insert(schema.tryonRequests).values([
      { conversationId, phoneE164: PHONE, productId, status: "offered" },
      { conversationId, phoneE164: PHONE, productId, status: "awaiting_photo", acceptedAt: NOW },
      { conversationId: other.conversationId, phoneE164: PHONE, productId, status: "queued", acceptedAt: NOW, queuedAt: NOW },
    ]);
    await db.insert(schema.tryonRequests).values({ conversationId, phoneE164: PHONE, productId, status: "processing", acceptedAt: NOW, vendorJobId: "job-1" });
    expect(await declinePendingTryOns(sdb(), { conversationId, now: new Date() })).toBe(2);
    expect(await declinePendingTryOns(sdb(), { conversationId: other.conversationId, now: new Date() })).toBe(1);
    expect((await requests()).map((row) => `${row.status}:${row.failureReason ?? ""}`).sort()).toEqual([
      "declined:",
      "declined:",
      "failed:cliente_desistiu",
      "processing:",
    ]);
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
