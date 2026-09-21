// Aviso no celular com o painel fechado: a inbound da cliente enfileira
// push.new_message NA MESMA transação (regra 5), uma vez por conversa a cada
// 2 min, só quando alguém ligou o aviso, nunca para o WhatsApp do dono.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { upsertPushSubscription } from "@/services/push-subscriptions";

import { createTestDb, FIXED_USER_ID, type TestDb } from "../helpers/db";

const kicks: Array<{ name: string; data: Record<string, unknown> }> = [];
vi.mock("@/inngest/client", () => ({
  inngest: {
    send: async (event: { name: string; data: Record<string, unknown> }) => {
      kicks.push(event);
      return { ids: [] };
    },
  },
}));
const { processZapiInbound } = await import("@/services/wa-inbound");

const SECRET = "segredo-webhook-zapi";
const KEYS = { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" };

function receivedMessage(messageId: string, text: string, phone = "5511999990000") {
  return { type: "ReceivedCallback", instanceId: "instancia-x", messageId, phone, fromMe: false, isGroup: false, senderName: "Ana Cliente", momment: Date.now(), status: "RECEIVED", text: { message: text } };
}

describe("processZapiInbound → push.new_message", () => {
  let db: TestDb;
  let sdb: DbOrTx;
  let close: () => Promise<void>;
  const originalSecret = process.env.ZAPI_WEBHOOK_SECRET;

  beforeEach(async () => {
    kicks.length = 0;
    ({ db, close } = await createTestDb());
    sdb = db as unknown as DbOrTx;
    process.env.ZAPI_WEBHOOK_SECRET = SECRET;
    delete process.env.ZAPI_CLIENT_TOKEN;
    vi.stubEnv("ADAPTER_MODE", "fake");
    await db.insert(schema.settings).values([
      { key: "wa_enabled", value: true },
      { key: "bot_enabled", value: true },
      { key: "owner_whatsapp_phone", value: "+5511955550000" },
    ]);
  });
  afterEach(async () => {
    await close();
    vi.unstubAllEnvs();
    if (originalSecret === undefined) delete process.env.ZAPI_WEBHOOK_SECRET;
    else process.env.ZAPI_WEBHOOK_SECRET = originalSecret;
  });

  const pushEvents = async () => (await db.select().from(schema.outboxEvents)).filter((event) => event.eventType === "push.new_message");

  it("sem ninguém inscrito: nada de push na outbox e um kick só (o do turno)", async () => {
    await processZapiInbound(sdb, { providedSecret: SECRET, body: receivedMessage("MSG-1", "oi") });
    expect(await pushEvents()).toHaveLength(0);
    expect(kicks).toHaveLength(1);
  });

  it("com inscrição: o push nasce na transação da mensagem, com a chave da janela de 2 min e o kick depois do commit; a 2ª mensagem na janela não gera outro", async () => {
    await upsertPushSubscription(sdb, { userId: FIXED_USER_ID, endpoint: "https://push.example/owner", keys: KEYS });
    const first = await processZapiInbound(sdb, { providedSecret: SECRET, body: receivedMessage("MSG-1", "oi") });
    expect(first.action).toBe("bot_queued");
    const [conversation] = await db.select().from(schema.waConversations);
    const [message] = await db.select().from(schema.waMessages);
    const [push] = await pushEvents();
    expect(push).toMatchObject({
      eventType: "push.new_message",
      aggregateType: "wa_message",
      aggregateId: message.id,
      payload: { conversationId: conversation.id, waMessageId: message.id },
    });
    expect(push.dedupeKey).toMatch(new RegExp(`^push\\.new_message:${conversation.id}:\\d+$`));
    // Dois kicks depois do commit: o do turno (rede de segurança do inline) e o do push.
    expect(kicks.map((kick) => kick.data.outboxEventId)).toContain(push.id);
    expect(kicks).toHaveLength(2);

    kicks.length = 0;
    await processZapiInbound(sdb, { providedSecret: SECRET, body: receivedMessage("MSG-2", "tem em M?") });
    expect(await pushEvents()).toHaveLength(1);
    // Sem push novo, sem kick de push: só o do turno.
    expect(kicks).toHaveLength(1);
  });

  it("mensagem do WhatsApp do dono não avisa o dono; duplicata do webhook não enfileira de novo", async () => {
    await upsertPushSubscription(sdb, { userId: FIXED_USER_ID, endpoint: "https://push.example/owner", keys: KEYS });
    await processZapiInbound(sdb, { providedSecret: SECRET, body: receivedMessage("MSG-OWNER", "chegou a blusa", "5511955550000") });
    expect(await pushEvents()).toHaveLength(0);

    await processZapiInbound(sdb, { providedSecret: SECRET, body: receivedMessage("MSG-1", "oi") });
    expect(await pushEvents()).toHaveLength(1);
    const again = await processZapiInbound(sdb, { providedSecret: SECRET, body: receivedMessage("MSG-1", "oi") });
    expect(again.action).toBe("duplicate");
    expect(await pushEvents()).toHaveLength(1);
  });
});
