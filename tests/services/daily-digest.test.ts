// "Bom dia da maison": números de ontem na janela de São Paulo, o que
// espera o dono, a vendedora, estoque baixo, publicação idempotente e o
// envio ao dono com dedupe por dia (e o "Enviar agora" com força).
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeFileStorage } from "@/adapters/storage/fake";
import { FakeMessagingProvider } from "@/adapters/zapi/fake";
import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import {
  buildDailyDigestData,
  buildDigestVars,
  digestDedupeKey,
  digestStoragePath,
  enqueueDailyDigest,
  getLastDigest,
  publishDailyDigest,
  sendDailyDigestWa,
  yesterdaySpDayKey,
  type DigestRenderer,
} from "@/services/daily-digest";
import { createCityEdition, setCityEditionProducts } from "@/services/city-editions";
import { createTestDb, createTestCustomer, createTestVariant, FIXED_USER_ID, type TestDb } from "../helpers/db";

let db: TestDb;
let close: () => Promise<void>;
let sdb: DbOrTx;
let storage: FakeFileStorage;
let provider: FakeMessagingProvider;
let renders = 0;

const DAY = "2026-09-09";
const OWNER_PHONE = "+5511900001111";

const render: DigestRenderer = async () => {
  renders += 1;
  return sharp({ create: { width: 1080, height: 1350, channels: 3, background: "#faf7f0" } })
    .png()
    .toBuffer();
};

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  sdb = db as unknown as DbOrTx;
  storage = new FakeFileStorage();
  provider = new FakeMessagingProvider();
  renders = 0;
});

afterEach(async () => {
  await close();
});

async function insertOrder(
  customerId: string,
  over: Partial<typeof schema.orders.$inferInsert>,
): Promise<string> {
  const [row] = await db
    .insert(schema.orders)
    .values({
      customerId,
      status: "paid",
      channel: "store",
      subtotalCents: over.totalCents ?? 10000,
      totalCents: 10000,
      createdAt: new Date("2026-09-09T12:00:00-03:00"),
      ...over,
    })
    .returning({ id: schema.orders.id });
  return row.id;
}

async function enableOwnerWa(): Promise<void> {
  await db.insert(schema.settings).values([
    { key: "wa_enabled", value: true },
    { key: "owner_whatsapp_phone", value: OWNER_PHONE },
  ]);
  await db.insert(schema.waTemplates).values({
    key: "owner_daily_digest",
    label: "Bom dia",
    bodyTemplate: "Bom dia! Vendas: {{vendas}} em {{pedidos}} pedido(s). Lia: {{lia_conversas}} conversa(s), custo {{lia_custo}}.",
    variables: ["vendas", "pedidos", "lia_conversas", "lia_custo"],
    isActive: true,
  });
}

describe("enqueueDailyDigest (o cron das 08:00)", () => {
  it("enfileira digest.daily de ONTEM sem aggregateId (uuid no banco) e não repete no mesmo dia", async () => {
    const now = new Date("2026-09-16T11:00:00Z");
    const first = await enqueueDailyDigest(sdb, now);
    expect(first).toEqual({ date: "2026-09-15", enqueued: true });
    const again = await enqueueDailyDigest(sdb, now);
    expect(again).toEqual({ date: "2026-09-15", enqueued: false });

    const rows = await db.select().from(schema.outboxEvents);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ eventType: "digest.daily", dedupeKey: "digest.daily:2026-09-15", aggregateType: "digest", aggregateId: null, payload: { date: "2026-09-15" } });
  });
});

describe("buildDailyDigestData", () => {
  it("conta só os pagamentos do dia de São Paulo, o que espera o dono, a Lia e o estoque", async () => {
    const customerId = await createTestCustomer(db, "Maria da Silva");
    // 23h30 de SP do dia 9 conta; 00h10 de SP do dia 10 não; reembolsado não.
    await insertOrder(customerId, { paidAt: new Date("2026-09-09T23:30:00-03:00"), totalCents: 30000 });
    await insertOrder(customerId, { paidAt: new Date("2026-09-09T08:00:00-03:00"), totalCents: 10000 });
    await insertOrder(customerId, { paidAt: new Date("2026-09-10T00:10:00-03:00"), totalCents: 99900 });
    await insertOrder(customerId, {
      status: "refunded",
      paidAt: new Date("2026-09-09T10:00:00-03:00"),
      totalCents: 55500,
    });
    // Estado de agora: a pagar, a embalar (os 3 pagos acima + separação sem foto), a enviar (com foto).
    await insertOrder(customerId, { status: "pending_payment", paidAt: null });
    await insertOrder(customerId, { status: "preparing", paidAt: new Date("2026-09-08T10:00:00-03:00") });
    await insertOrder(customerId, {
      status: "preparing",
      paidAt: new Date("2026-09-08T10:00:00-03:00"),
      packagePhotoPath: "packages/x/embalagem.jpg",
      packedAt: new Date(),
    });

    // Vendedora: 2 turnos no dia (1 transferência), 1 fora; 1 pedido do WhatsApp no dia.
    const [conversation] = await db
      .insert(schema.waConversations)
      .values({ phoneE164: "+5511999998888", customerId })
      .returning({ id: schema.waConversations.id });
    await db.insert(schema.waMessages).values([
      {
        conversationId: conversation.id,
        direction: "inbound",
        body: "oi",
        status: "delivered",
        createdAt: new Date("2026-09-09T15:00:00-03:00"),
      },
    ]);
    const turn = (at: string, handedOff: boolean) => ({
      actorType: "system",
      action: "wa.bot_turn",
      entityType: "wa_conversation",
      entityId: conversation.id,
      after: {
        inboundId: "x",
        model: "claude-sonnet-5",
        usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 10_000, cacheWriteTokens: 0 },
        handedOff,
      },
      createdAt: new Date(at),
    });
    await db.insert(schema.auditLog).values([
      turn("2026-09-09T15:00:30-03:00", false),
      turn("2026-09-09T15:01:00-03:00", true),
      turn("2026-09-10T09:00:00-03:00", false),
      {
        actorType: "system",
        action: "wa.bot_handoff",
        entityType: "wa_conversation",
        entityId: conversation.id,
        after: { motivo: "troca" },
        createdAt: new Date("2026-09-09T15:01:00-03:00"),
      },
    ]);
    await insertOrder(customerId, {
      channel: "whatsapp",
      status: "pending_payment",
      paidAt: null,
      totalCents: 28900,
      createdAt: new Date("2026-09-09T15:02:00-03:00"),
    });

    // Estoque: duas variações no limiar, uma folgada.
    const { variantId: low1 } = await createTestVariant(db, { sku: "A-1", name: "Vestido Dunas 🤍", onHand: 0 });
    const { variantId: low2 } = await createTestVariant(db, { sku: "B-2", name: "Blusa Linho", onHand: 2 });
    await createTestVariant(db, { sku: "C-3", name: "Saia Midi", onHand: 40 });
    void low1;
    void low2;

    await db.insert(schema.settings).values({ key: "store_name", value: "TRIVÉ" });

    const data = await buildDailyDigestData(sdb, { date: DAY });

    expect(data.dayKey).toBe(DAY);
    expect(data.dayLabel).toBe("quarta-feira, 9 de setembro");
    expect(data.sales).toEqual({
      paidOrders: 2,
      revenueCents: 40000,
      averageTicketCents: 20000,
      // 9 pedidos criados no dia (todos os insertOrder com createdAt padrão) menos os que mudei.
      newOrders: 8,
    });
    expect(data.waiting).toMatchObject({ pendingPayment: 2, toPack: 4, toShip: 1 });
    expect(data.bot).toMatchObject({ conversations: 1, turns: 2, handoffs: 1, orders: 1, ordersCents: 28900 });
    expect(data.bot.costUsdCents).toBeGreaterThan(0);
    expect(data.lowStock.map((row) => [row.sku, row.available])).toEqual([
      ["A-1", 0],
      ["B-2", 2],
    ]);
    expect(data.lowStock[0].name).toBe("Vestido Dunas");
    expect(data.storeName).toBe("TRIVÉ");
    expect(data.opening.length).toBeGreaterThan(10);
    expect(JSON.stringify(data)).not.toMatch(/Maria|99999/);

    const vars = buildDigestVars(data);
    expect(vars).toMatchObject({ dia: "quarta-feira", data: "09/09", pedidos: "2", a_pagar: "2", a_embalar: "4", a_enviar: "1", lia_conversas: "1" });
  });

  it("dia sem venda: frase de descanso, ticket zero, sem mais vendida", async () => {
    const data = await buildDailyDigestData(sdb, { date: DAY });
    expect(data.sales).toEqual({ paidOrders: 0, revenueCents: 0, averageTicketCents: 0, newOrders: 0 });
    expect(data.bestSeller).toBeNull();
    expect(data.opening).toContain("Hoje a gente muda isso");
    expect(data.editions).toEqual([]);
    expect(buildDigestVars(data).edicoes).toBe("");
  });

  it("Edições de Belém: a próxima a começar entra com peças e fotos faltando; a linha vira {{edicoes}}", async () => {
    const { editionId } = await createCityEdition(sdb, { isActive: true, fields: { name: "Edição Círio", startsOn: "2026-10-01", endsOn: "2026-10-12" }, userId: FIXED_USER_ID });
    const { productId } = await createTestVariant(db, { sku: "DUNAS", costCents: 1000, onHand: 1, name: "Longo Dunas" });
    await setCityEditionProducts(sdb, { editionId, productIds: [productId], userId: FIXED_USER_ID });
    // O Bom dia de 10/09 chega na manhã de 10/09: faltam 21 dias para 1/10.
    const data = await buildDailyDigestData(sdb, { date: DAY });
    expect(data.editions).toEqual([{ name: "Edição Círio", isCurrent: false, daysUntil: 21, kind: "period", hours: null, products: 1, missingPhoto: 1 }]);
    expect(buildDigestVars(data).edicoes).toBe("\nFaltam 21 dias para a Edição Círio — 1 peça escolhida, 1 ainda sem foto");
  });
});

describe("publishDailyDigest / sendDailyDigestWa", () => {
  it("publica em digests/<dia>.jpg com audit e envia ao dono uma vez por dia", async () => {
    await enableOwnerWa();

    const published = await publishDailyDigest(sdb, storage, render, { date: DAY });
    expect(published.path).toBe(digestStoragePath(DAY));
    expect(published.url).toMatch(/^memory:\/\/digests\/2026-09-09\.jpg\?v=\d+$/);
    expect(storage.get(published.path)?.contentType).toBe("image/jpeg");
    expect(await getLastDigest(sdb)).toMatchObject({ date: DAY, path: published.path });

    const first = await sendDailyDigestWa(sdb, provider, storage, render, { date: DAY });
    expect(first).toMatchObject({ sent: true });
    expect(provider.sentImages).toHaveLength(1);
    expect(provider.sentImages[0].toE164).toBe(OWNER_PHONE);
    expect(provider.sentImages[0].caption).toContain("Bom dia! Vendas:");
    const [message] = await db.select().from(schema.waMessages);
    expect(message.dedupeKey).toBe(digestDedupeKey(DAY));
    expect(renders).toBe(2);

    expect(await sendDailyDigestWa(sdb, provider, storage, render, { date: DAY })).toEqual({
      skipped: "ja_enviado",
    });
    expect(renders).toBe(2);

    // "Enviar agora": manda de novo com dedupe próprio.
    const forced = await sendDailyDigestWa(sdb, provider, storage, render, { date: DAY, force: true });
    expect(forced).toMatchObject({ sent: true });
    expect(provider.sentImages).toHaveLength(2);
  });

  it("pula sem renderizar: desligado no painel, WhatsApp desligado, sem telefone do dono, sem template", async () => {
    await db.insert(schema.settings).values({ key: "owner_digest_enabled", value: false });
    expect(await sendDailyDigestWa(sdb, provider, storage, render, { date: DAY })).toEqual({
      skipped: "digest_desligado",
    });
    await db.delete(schema.settings).where(eq(schema.settings.key, "owner_digest_enabled"));

    expect(await sendDailyDigestWa(sdb, provider, storage, render, { date: DAY })).toEqual({
      skipped: "desabilitado",
    });

    await db.insert(schema.settings).values({ key: "wa_enabled", value: true });
    expect(await sendDailyDigestWa(sdb, provider, storage, render, { date: DAY })).toEqual({
      skipped: "sem_telefone_dono",
    });

    await db.insert(schema.settings).values({ key: "owner_whatsapp_phone", value: OWNER_PHONE });
    expect(await sendDailyDigestWa(sdb, provider, storage, render, { date: DAY })).toEqual({
      skipped: "sem_template",
    });
    expect(provider.sentImages).toHaveLength(0);
  });

  it("ontem em São Paulo", () => {
    expect(yesterdaySpDayKey(new Date("2026-09-10T02:30:00Z"))).toBe("2026-09-08");
    expect(yesterdaySpDayKey(new Date("2026-09-10T11:00:00Z"))).toBe("2026-09-09");
  });
});
