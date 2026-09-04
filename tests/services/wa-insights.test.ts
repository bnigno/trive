// Números da Central do WhatsApp: derivados da trilha do bot (audit_log) e
// dos pedidos do canal, com custo estimado por modelo.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import {
  estimateUsdCents,
  getBotActivitySummary,
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
    // 2000 entrada (US$ 0,006) + 1000 saída (US$ 0,015) + 10k cache (US$ 0,003) ≈ 2 centavos.
    expect(summary.estimatedCostUsdCents).toBe(2);

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
