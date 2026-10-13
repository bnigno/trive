// "Me vê com ela" — pôr um pedido aceito na fila: só com o toque dela em
// "Quero me ver" (o consentimento DESTA prévia), com a prévia ligada, dentro
// dos tetos do dia, e uma prévia sendo feita por conversa de cada vez (o
// árbitro é o índice do banco).
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { countTryOnsToday, queueTryOn, TRYON_EVENT } from "@/services/tryon";
import { loadTryOnSettings } from "@/services/tryon-settings";
import { createTestDb, type TestDb } from "../helpers/db";

vi.mock("@/inngest/client", () => ({ inngest: { send: async () => ({ ids: [] }) } }));

const NOW = new Date("2026-10-13T15:00:00Z");
const PHONE = "+5591988887777";

let db: TestDb;
let close: () => Promise<void>;
const sdb = () => db as unknown as DbOrTx;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  vi.stubEnv("ADAPTER_MODE", "fake");
  await db.insert(schema.settings).values([
    { key: "tryon_enabled", value: true },
    { key: "tryon_per_customer_daily", value: 2 },
    { key: "tryon_daily_total", value: 3 },
  ]);
});

afterEach(async () => {
  await close();
  vi.unstubAllEnvs();
});

async function seedConversation(phone = PHONE) {
  const [product] = await db
    .insert(schema.products)
    .values({ name: "VESTIDO AMORA", slug: `amora-${Math.random().toString(36).slice(2, 7)}`, status: "active", pieceType: "vestido" })
    .returning({ id: schema.products.id });
  const [conversation] = await db.insert(schema.waConversations).values({ phoneE164: phone }).returning({ id: schema.waConversations.id });
  const [photo] = await db
    .insert(schema.waMessages)
    .values({ conversationId: conversation!.id, direction: "inbound", kind: "image", body: "", mediaUrl: "https://zapi.example/f.jpg", status: "delivered" })
    .returning({ id: schema.waMessages.id });
  return { productId: product!.id, conversationId: conversation!.id, photoId: photo!.id };
}

async function offer(input: { conversationId: string; productId: string; phone?: string; accepted?: boolean; status?: string }) {
  const [row] = await db
    .insert(schema.tryonRequests)
    .values({
      conversationId: input.conversationId,
      phoneE164: input.phone ?? PHONE,
      productId: input.productId,
      status: input.status ?? "awaiting_photo",
      acceptedAt: input.accepted === false ? null : NOW,
    })
    .returning({ id: schema.tryonRequests.id });
  return row!.id;
}

describe("queueTryOn", () => {
  it("aceito + foto: vai para a fila com a foto, a hora e um evento (sem kick dentro do turno)", async () => {
    const { productId, conversationId, photoId } = await seedConversation();
    const requestId = await offer({ conversationId, productId });
    const result = await queueTryOn(sdb(), { requestId, photoWaMessageId: photoId, now: NOW, kick: false });
    expect(result).toMatchObject({ ok: true });
    const [row] = await db.select().from(schema.tryonRequests).where(eq(schema.tryonRequests.id, requestId));
    expect(row).toMatchObject({ status: "queued", photoWaMessageId: photoId, queuedAt: NOW });
    const events = await db.select().from(schema.outboxEvents);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventType: TRYON_EVENT, dedupeKey: `${TRYON_EVENT}:${requestId}`, payload: { requestId } });
  });

  it("sem o toque em 'Quero me ver' não há prévia; pedido já na fila ou encerrado não volta", async () => {
    const { productId, conversationId, photoId } = await seedConversation();
    const notAccepted = await offer({ conversationId, productId, accepted: false, status: "offered" });
    expect(await queueTryOn(sdb(), { requestId: notAccepted, photoWaMessageId: photoId, now: NOW })).toEqual({ ok: false, reason: "sem_consentimento" });
    const sent = await offer({ conversationId, productId, status: "sent" });
    expect(await queueTryOn(sdb(), { requestId: sent, photoWaMessageId: photoId, now: NOW })).toEqual({ ok: false, reason: "estado_invalido" });
    expect(await queueTryOn(sdb(), { requestId: "00000000-0000-4000-8000-00000000abcd", photoWaMessageId: photoId, now: NOW })).toEqual({ ok: false, reason: "nao_encontrado" });
    expect(await db.select().from(schema.outboxEvents)).toHaveLength(0);
  });

  it("desligado: não enfileira", async () => {
    const { productId, conversationId, photoId } = await seedConversation();
    const requestId = await offer({ conversationId, productId });
    await db.update(schema.settings).set({ value: false }).where(eq(schema.settings.key, "tryon_enabled"));
    expect(await queueTryOn(sdb(), { requestId, photoWaMessageId: photoId, now: NOW })).toEqual({ ok: false, reason: "desligado" });
  });

  it("uma prévia por conversa de cada vez: o índice do banco decide, e a transação de quem chama segue viva", async () => {
    const { productId, conversationId, photoId } = await seedConversation();
    const first = await offer({ conversationId, productId });
    const second = await offer({ conversationId, productId });
    expect(await queueTryOn(sdb(), { requestId: first, photoWaMessageId: photoId, now: NOW, kick: false })).toMatchObject({ ok: true });
    await db.transaction(async (tx) => {
      const result = await queueTryOn(tx as unknown as DbOrTx, { requestId: second, photoWaMessageId: photoId, now: NOW, kick: false });
      expect(result).toEqual({ ok: false, reason: "em_andamento" });
      // O savepoint segurou o conflito: a transação do turno continua usável.
      await tx.select().from(schema.tryonRequests);
    });
  });

  it("tetos do dia: o da cliente (2) e o da loja (3) contam só o que chegou à FASHN (ou está a caminho)", async () => {
    const { productId, conversationId, photoId } = await seedConversation();
    await db.insert(schema.tryonRequests).values([
      { conversationId, phoneE164: PHONE, productId, status: "sent", acceptedAt: NOW, queuedAt: NOW, submittedAt: NOW },
      { conversationId, phoneE164: PHONE, productId, status: "failed", acceptedAt: NOW, queuedAt: NOW, submittedAt: NOW },
      // Falhou antes de pedir (a foto não abriu) e foto recusada: não gastam a cota.
      { conversationId, phoneE164: PHONE, productId, status: "failed", acceptedAt: NOW, queuedAt: NOW },
      { conversationId, phoneE164: PHONE, productId, status: "photo_rejected", acceptedAt: NOW, queuedAt: NOW },
    ]);
    expect(await countTryOnsToday(sdb(), { phoneE164: PHONE, now: NOW })).toEqual({ customer: 2, total: 2, rejected: 1 });
    const requestId = await offer({ conversationId, productId });
    expect(await queueTryOn(sdb(), { requestId, photoWaMessageId: photoId, now: NOW })).toEqual({ ok: false, reason: "limite_cliente" });

    // Outra cliente: o da loja (3) chega primeiro.
    const other = await seedConversation("+5591977776666");
    await db.insert(schema.tryonRequests).values({ conversationId: other.conversationId, phoneE164: "+5591977776666", productId, status: "sent", acceptedAt: NOW, queuedAt: NOW, submittedAt: NOW });
    const otherRequest = await offer({ conversationId: other.conversationId, productId, phone: "+5591977776666" });
    expect(await queueTryOn(sdb(), { requestId: otherRequest, photoWaMessageId: other.photoId, now: NOW })).toEqual({ ok: false, reason: "limite_loja" });

    // O dia vira (São Paulo): conta do zero.
    const tomorrow = new Date("2026-10-14T13:00:00Z");
    expect(await countTryOnsToday(sdb(), { phoneE164: PHONE, now: tomorrow })).toEqual({ customer: 0, total: 0, rejected: 0 });
  });

  it("fotos recusadas têm teto próprio (cada uma passa pela visão): 3× o teto de prévias", async () => {
    const { productId, conversationId, photoId } = await seedConversation();
    for (let index = 0; index < 6; index += 1) {
      await db.insert(schema.tryonRequests).values({ conversationId, phoneE164: PHONE, productId, status: "photo_rejected", acceptedAt: NOW, queuedAt: NOW });
    }
    const requestId = await offer({ conversationId, productId });
    expect(await queueTryOn(sdb(), { requestId, photoWaMessageId: photoId, now: NOW })).toEqual({ ok: false, reason: "limite_cliente" });
  });

  it("a foto tem de ser uma imagem que ELA mandou nesta conversa", async () => {
    const mine = await seedConversation();
    const other = await seedConversation("+5591977776666");
    const requestId = await offer({ conversationId: mine.conversationId, productId: mine.productId });
    // Foto da outra conversa, ou uma imagem que a loja mandou: nunca.
    expect(await queueTryOn(sdb(), { requestId, photoWaMessageId: other.photoId, now: NOW })).toEqual({ ok: false, reason: "foto_invalida" });
    const [sentByStore] = await db
      .insert(schema.waMessages)
      .values({ conversationId: mine.conversationId, direction: "outbound", kind: "image", body: "cartão", mediaUrl: "https://x.example/c.jpg", status: "sent" })
      .returning({ id: schema.waMessages.id });
    expect(await queueTryOn(sdb(), { requestId, photoWaMessageId: sentByStore!.id, now: NOW })).toEqual({ ok: false, reason: "foto_invalida" });
    expect(await queueTryOn(sdb(), { requestId, photoWaMessageId: mine.photoId, now: NOW })).toMatchObject({ ok: true });
  });

  it("'Agora não' depois do 'Quero me ver' revoga o consentimento", async () => {
    const { productId, conversationId, photoId } = await seedConversation();
    const [row] = await db
      .insert(schema.tryonRequests)
      .values({ conversationId, phoneE164: PHONE, productId, status: "awaiting_photo", acceptedAt: new Date(NOW.getTime() - 60_000), declinedAt: new Date(NOW.getTime() - 30_000) })
      .returning({ id: schema.tryonRequests.id });
    expect(await queueTryOn(sdb(), { requestId: row!.id, photoWaMessageId: photoId, now: NOW })).toEqual({ ok: false, reason: "sem_consentimento" });
  });

  it("pedido preso há mais de 15 min (a fila perdeu a linha) não trava a conversa: encerra, avisa pela fila e libera", async () => {
    const { productId, conversationId, photoId } = await seedConversation();
    const old = new Date(NOW.getTime() - 20 * 60_000);
    const [stuck] = await db
      .insert(schema.tryonRequests)
      .values({ conversationId, phoneE164: PHONE, productId, status: "processing", acceptedAt: old, queuedAt: old, submittedAt: old, vendorJobId: "job-preso", updatedAt: old })
      .returning({ id: schema.tryonRequests.id });
    const requestId = await offer({ conversationId, productId });
    expect(await queueTryOn(sdb(), { requestId, photoWaMessageId: photoId, now: NOW, kick: false })).toMatchObject({ ok: true });
    const [healed] = await db.select().from(schema.tryonRequests).where(eq(schema.tryonRequests.id, stuck!.id));
    expect(healed).toMatchObject({ status: "failed", failureReason: "demorou_demais", vendorJobId: "job-preso" });
    const notice = (await db.select().from(schema.outboxEvents)).find((row) => row.dedupeKey === `wa.bot_tryon:${stuck!.id}:falhou:demorou_demais`);
    expect(notice?.eventType).toBe("wa.send");
  });

  it("settings: desligado e padrões quando ausentes ou tortos", async () => {
    await db.delete(schema.settings).where(eq(schema.settings.key, "tryon_enabled"));
    await db.update(schema.settings).set({ value: "muitos" }).where(eq(schema.settings.key, "tryon_daily_total"));
    expect(await loadTryOnSettings(sdb())).toEqual({ enabled: false, perCustomerDaily: 2, dailyTotal: 20 });
  });
});
