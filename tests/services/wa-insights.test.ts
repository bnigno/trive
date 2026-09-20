// Números da Central do WhatsApp: derivados da trilha do bot (audit_log) e
// dos pedidos do canal, com custo estimado por modelo.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import {
  estimateUsdCents,
  getBotActivitySummary,
  getBotResponseTimes,
  listRecentBotActivity,
} from "@/services/wa-insights";
import { createTestDb, createTestCustomer, type TestDb } from "../helpers/db";

let db: TestDb;
let sdb: DbOrTx;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  sdb = db as unknown as DbOrTx;
});

afterEach(async () => {
  await close();
});

describe("estimateUsdCents", () => {
  it("aplica os preços por modelo (cache lido a 10%, gravado a 2×)", () => {
    // Sonnet: 1M entrada = US$ 3,00; 1M saída = US$ 15,00.
    expect(
      estimateUsdCents("claude-sonnet-5", {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    ).toBe(300);
    expect(
      estimateUsdCents("claude-sonnet-5", {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 1_000_000,
        cacheWriteTokens: 0,
      }),
    ).toBe(30);
    expect(
      estimateUsdCents("claude-haiku-4-5", {
        inputTokens: 0,
        outputTokens: 1_000_000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    ).toBe(500);
    // Modelo desconhecido cai na tabela do Sonnet.
    expect(
      estimateUsdCents("claude-x", {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    ).toBe(300);
  });
});

describe("getBotActivitySummary / listRecentBotActivity", () => {
  it("conta conversas de hoje, turnos, transferências, pedidos e custo dos últimos 7 dias", async () => {
    const customerId = await createTestCustomer(db, "Maria da Silva");
    const [conversation] = await db
      .insert(schema.waConversations)
      .values({ phoneE164: "+5511999998888", customerId, lastInboundAt: new Date() })
      .returning({ id: schema.waConversations.id });
    await db.insert(schema.waConversations).values({
      phoneE164: "+5511999997777",
      lastInboundAt: new Date(Date.now() - 3 * 86_400_000),
    });

    await db.insert(schema.auditLog).values([
      {
        actorType: "system",
        action: "wa.bot_turn",
        entityType: "wa_conversation",
        entityId: conversation.id,
        after: {
          inboundId: "x",
          model: "claude-sonnet-5",
          toolCalls: [{ name: "listar_produtos", ok: true }],
          usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 10_000, cacheWriteTokens: 0 },
          handedOff: false,
        },
      },
      {
        actorType: "system",
        action: "wa.bot_turn",
        entityType: "wa_conversation",
        entityId: conversation.id,
        after: {
          inboundId: "y",
          model: "claude-sonnet-5",
          toolCalls: [{ name: "transferir_para_atendente", ok: true }],
          usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 },
          handedOff: true,
        },
      },
      {
        actorType: "system",
        action: "wa.bot_handoff",
        entityType: "wa_conversation",
        entityId: conversation.id,
        after: { motivo: "quer trocar", resumo: "Dunas M por G." },
        reason: "quer trocar",
      },
      // Fora da janela de 7 dias: não conta.
      {
        actorType: "system",
        action: "wa.bot_turn",
        entityType: "wa_conversation",
        entityId: conversation.id,
        after: { inboundId: "z", model: "claude-sonnet-5", usage: { inputTokens: 999_999, outputTokens: 0 }, handedOff: false },
        createdAt: new Date(Date.now() - 10 * 86_400_000),
      },
    ]);

    await db.insert(schema.orders).values([
      { customerId, status: "pending_payment", channel: "whatsapp", subtotalCents: 4990, totalCents: 4990 },
      { customerId, status: "paid", channel: "store", subtotalCents: 100, totalCents: 100 },
    ]);

    const summary = await getBotActivitySummary(sdb);
    expect(summary).toMatchObject({
      windowDays: 7,
      conversationsToday: 1,
      turns: 2,
      handoffs: 1,
      ordersByBot: 1,
      ordersByBotCents: 4990,
    });
    // 2000 entrada (US$ 0,006) + 1000 saída (US$ 0,015) + 10k cache (US$ 0,003)
    // = US$ 0,024 → 3 centavos (a conta arredonda para cima: nunca subestima).
    expect(summary.estimatedCostUsdCents).toBe(3);

    const activity = await listRecentBotActivity(sdb);
    expect(activity.map((event) => event.kind)).toEqual(["order", "handoff"]);
    expect(activity[1]).toMatchObject({
      kind: "handoff",
      conversationId: conversation.id,
      who: "Maria da Silva",
      title: "quer trocar",
      detail: "Dunas M por G.",
    });
    expect(activity[0]).toMatchObject({ kind: "order", who: "Maria da Silva" });
    expect(activity[0].title).toMatch(/^Pedido #\d+$/);
  });
});

describe("getBotResponseTimes", () => {
  const timings = (totalMs: number, extra: Partial<Record<string, number | null>> = {}) => ({
    enqueuedAt: null,
    queueWaitMs: 1_000,
    prepMs: 500,
    modelMs: totalMs - 2_000,
    toolsMs: 100,
    deliveryMs: 500,
    totalMs,
    inboundToFirstBubbleMs: totalMs + 1_000,
    ...extra,
  });
  const turn = (after: Record<string, unknown>, createdAt = new Date()) => ({
    actorType: "system" as const,
    action: "wa.bot_turn",
    entityType: "wa_conversation",
    entityId: "00000000-0000-4000-8000-000000000001",
    after,
    createdAt,
  });

  it("sem turnos medidos: zero e nulos (a tela mostra o estado vazio)", async () => {
    const times = await getBotResponseTimes(sdb);
    expect(times.turns).toBe(0);
    expect(times.p50.totalMs).toBeNull();
    expect(times.p90.inboundToFirstBubbleMs).toBeNull();
  });

  it("mediana e p90 por trecho, só de turnos autônomos com tempos e dentro de 7 dias", async () => {
    // Totais 10, 20, …, 100 s mais um de 50 s (11 linhas): p50 = 50 s, p90 = 90 s (percentile_cont).
    // queueWaitMs: 5 linhas com 1 s, 5 com 3 s e uma null — null ignorado dá mediana 2 s;
    // contado como 0 daria 1 s.
    const rows = Array.from({ length: 10 }, (_, i) =>
      turn({ mode: "autonomous", timings: timings((i + 1) * 10_000, { queueWaitMs: i < 5 ? 1_000 : 3_000 }) }),
    );
    await db.insert(schema.auditLog).values([
      ...rows,
      // Sem timings (turno anterior ao PR), copiloto e velho demais: fora.
      turn({ mode: "autonomous", durationMs: 999_999 }),
      turn({ mode: "copilot", timings: timings(999_999) }),
      turn({ mode: "autonomous", timings: timings(999_999) }, new Date(Date.now() - 8 * 86_400_000)),
      // queueWaitMs desconhecido numa linha: os outros trechos ainda contam.
      turn({ mode: "autonomous", timings: timings(50_000, { queueWaitMs: null }) }),
    ]);

    const times = await getBotResponseTimes(sdb);
    expect(times.turns).toBe(11);
    expect(times.p50.totalMs).toBe(50_000);
    expect(times.p50.inboundToFirstBubbleMs).toBe(51_000);
    expect(times.p50.queueWaitMs).toBe(2_000);
    // Médias (a barra): total médio = (10+20+…+100+50)/11 = 54,5 s; fila média só das 10 linhas com valor.
    expect(times.mean.totalMs).toBe(54_545);
    expect(times.mean.prepMs).toBe(500);
    expect(times.mean.queueWaitMs).toBe(2_000);
    expect(times.p50.prepMs).toBe(500);
    expect(times.p50.deliveryMs).toBe(500);
    expect(times.p90.totalMs).toBe(90_000);
    expect(times.p90.modelMs).toBe(88_000);
    // Turnos anteriores à medição de origem: todos "sem origem"; sem recibo de entrega: nada.
    expect(times.bySource).toEqual({ inline: 0, kick: 0, cron: 0, unknown: 11 });
    expect(times.delivered).toEqual({ turns: 0, p50Ms: null, p90Ms: null });
  });

  it("conta a origem de cada resposta medida e mede 'entregue no celular' pelo recibo da Z-API (dedupe da resposta → inbound)", async () => {
    await db.insert(schema.auditLog).values([
      turn({ mode: "autonomous", timings: { ...timings(10_000), source: "inline" } }),
      turn({ mode: "autonomous", timings: { ...timings(10_000), source: "inline" } }),
      turn({ mode: "autonomous", timings: { ...timings(10_000), source: "kick" } }),
      turn({ mode: "autonomous", timings: timings(10_000) }),
      // Sem balão (transferência sem texto): não é resposta em origem nenhuma.
      turn({ mode: "autonomous", timings: { ...timings(10_000, { inboundToFirstBubbleMs: null }), source: "inline" } }),
    ]);
    const [conversation] = await db.insert(schema.waConversations).values({ phoneE164: "+5511999990000", status: "open" }).returning({ id: schema.waConversations.id });
    const inboundAt = new Date(Date.now() - 60_000);
    const [inbound] = await db
      .insert(schema.waMessages)
      .values({ conversationId: conversation.id, direction: "inbound", kind: "text", body: "oi", status: "delivered", zapiMessageId: "IN-ENTREGUE-1", createdAt: inboundAt })
      .returning({ id: schema.waMessages.id });
    await db.insert(schema.waMessages).values([
      // Primeiro balão: aceito 6 s e ENTREGUE 8 s depois da mensagem dela.
      { conversationId: conversation.id, direction: "outbound", kind: "text", body: "Oi!", status: "delivered", dedupeKey: `wa.bot_reply:${inbound.id}`, createdAt: new Date(inboundAt.getTime() + 6_000), deliveredAt: new Date(inboundAt.getTime() + 8_000) },
      // Segundo balão e um envio sem recibo: fora da conta.
      { conversationId: conversation.id, direction: "outbound", kind: "text", body: "…", status: "delivered", dedupeKey: `wa.bot_reply:${inbound.id}:1`, createdAt: new Date(inboundAt.getTime() + 9_000), deliveredAt: new Date(inboundAt.getTime() + 11_000) },
      { conversationId: conversation.id, direction: "outbound", kind: "text", body: "x", status: "sent", dedupeKey: `wa.bot_reply:${crypto.randomUUID()}`, createdAt: new Date() },
    ]);

    const times = await getBotResponseTimes(sdb);
    expect(times.turns).toBe(4);
    expect(times.bySource).toEqual({ inline: 2, kick: 1, cron: 0, unknown: 1 });
    expect(times.delivered).toEqual({ turns: 1, p50Ms: 8_000, p90Ms: 8_000 });
  });
});
