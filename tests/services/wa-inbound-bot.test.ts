// Roteamento do inbound para o BOT DE VENDAS (Onda B): texto em conversa
// 'open' com bot habilitado enfileira 'wa.bot_turn' em vez de encaminhar ao
// dono; qualquer condição fora disso (conversa 'human', bot silenciado por
// bot_disabled_until, bot_enabled false) mantém o forward. SAIR/PARAR fica
// SEMPRE antes do bot (LGPD) e o dedupe de inbound continua intacto.
// O FakeSalesAssistant NÃO participa aqui — o turno em si roda no handler
// 'wa.bot_turn' da fila, não no webhook.
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { OPT_OUT_ACK_BODY, processZapiInbound } from "@/services/wa-inbound";
import { createTestDb, type TestDb } from "../helpers/db";

const SECRET = "segredo-webhook-zapi";
const PHONE_E164 = "+5511999990000";
// A Z-API entrega o telefone SEM o '+' do E.164.
const PHONE_ZAPI = "5511999990000";

function receivedMessage(messageId: string, text: string, phone = PHONE_ZAPI) {
  return {
    type: "ReceivedCallback",
    instanceId: "instancia-x",
    messageId,
    phone,
    fromMe: false,
    isGroup: false,
    senderName: "Ana Cliente",
    momment: Date.now(),
    status: "RECEIVED",
    text: { message: text },
  };
}

describe("processZapiInbound → roteamento para o bot de vendas", () => {
  let db: TestDb;
  let sdb: DbOrTx;
  let close: () => Promise<void>;
  const originalSecret = process.env.ZAPI_WEBHOOK_SECRET;

  beforeEach(async () => {
    ({ db, close } = await createTestDb());
    sdb = db as unknown as DbOrTx;
    process.env.ZAPI_WEBHOOK_SECRET = SECRET;
    delete process.env.ZAPI_CLIENT_TOKEN;
    // Modo fake: isWaEnabled/isBotEnabled não exigem credenciais no ambiente.
    vi.stubEnv("ADAPTER_MODE", "fake");
  });

  afterEach(async () => {
    await close();
    vi.unstubAllEnvs();
    if (originalSecret === undefined) delete process.env.ZAPI_WEBHOOK_SECRET;
    else process.env.ZAPI_WEBHOOK_SECRET = originalSecret;
  });

  async function setSettings(waEnabled: boolean, botEnabled: boolean) {
    await db.insert(schema.settings).values([
      { key: "wa_enabled", value: waEnabled },
      { key: "bot_enabled", value: botEnabled },
    ]);
  }

  async function createConversation(
    overrides: Partial<typeof schema.waConversations.$inferInsert> = {},
  ) {
    const [conv] = await db
      .insert(schema.waConversations)
      .values({ phoneE164: PHONE_E164, status: "open", ...overrides })
      .returning({ id: schema.waConversations.id });
    return conv.id;
  }

  it("texto em conversa open com bot ligado: enfileira wa.bot_turn e NÃO encaminha ao dono", async () => {
    await setSettings(true, true);

    const result = await processZapiInbound(sdb, {
      providedSecret: SECRET,
      body: receivedMessage("MSG-BOT-1", "Oi! Quero ver os produtos"),
    });

    expect(result.action).toBe("bot_queued");
    if (result.action !== "bot_queued") throw new Error("unreachable");

    const [conversation] = await db.select().from(schema.waConversations);
    expect(result.conversationId).toBe(conversation.id);

    const outbox = await db.select().from(schema.outboxEvents);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      eventType: "wa.bot_turn",
      dedupeKey: "wa.bot_turn:MSG-BOT-1",
      aggregateType: "wa_conversation",
      aggregateId: conversation.id,
      payload: { conversationId: conversation.id },
    });
    expect(outbox.some((e) => e.eventType === "wa.owner_forward")).toBe(false);

    // Mensagem inbound registrada e inbound_event fechado como sempre.
    const messages = await db.select().from(schema.waMessages);
    expect(messages).toHaveLength(1);
    expect(result.waMessageId).toBe(messages[0].id);
    const [inbound] = await db.select().from(schema.inboundEvents);
    expect(inbound.status).toBe("done");
  });

  it("bot_disabled_until no PASSADO não silencia: bot volta a responder", async () => {
    await setSettings(true, true);
    await createConversation({
      botDisabledUntil: new Date(Date.now() - 60 * 60 * 1000),
    });

    const result = await processZapiInbound(sdb, {
      providedSecret: SECRET,
      body: receivedMessage("MSG-BOT-2", "Ainda tem em estoque?"),
    });

    expect(result.action).toBe("bot_queued");
    const outbox = await db.select().from(schema.outboxEvents);
    expect(outbox).toHaveLength(1);
    expect(outbox[0].eventType).toBe("wa.bot_turn");
  });

  it("conversa 'human' (dono assumiu): forward ao dono como antes, sem bot", async () => {
    await setSettings(true, true);
    await createConversation({ status: "human" });

    const result = await processZapiInbound(sdb, {
      providedSecret: SECRET,
      body: receivedMessage("MSG-HUM-1", "Pode me ajudar?"),
    });

    expect(result.action).toBe("forwarded");
    const outbox = await db.select().from(schema.outboxEvents);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      eventType: "wa.owner_forward",
      dedupeKey: "wa.fwd:MSG-HUM-1",
    });
    expect(outbox.some((e) => e.eventType === "wa.bot_turn")).toBe(false);
  });

  it("bot_disabled_until no FUTURO: forward ao dono (bot silenciado)", async () => {
    await setSettings(true, true);
    await createConversation({
      botDisabledUntil: new Date(Date.now() + 60 * 60 * 1000),
    });

    const result = await processZapiInbound(sdb, {
      providedSecret: SECRET,
      body: receivedMessage("MSG-SIL-1", "Alô?"),
    });

    expect(result.action).toBe("forwarded");
    const outbox = await db.select().from(schema.outboxEvents);
    expect(outbox).toHaveLength(1);
    expect(outbox[0].eventType).toBe("wa.owner_forward");
  });

  it("bot_enabled false: forward ao dono como antes", async () => {
    await setSettings(true, false);

    const result = await processZapiInbound(sdb, {
      providedSecret: SECRET,
      body: receivedMessage("MSG-OFF-1", "Quero comprar"),
    });

    expect(result.action).toBe("forwarded");
    const outbox = await db.select().from(schema.outboxEvents);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      eventType: "wa.owner_forward",
      dedupeKey: "wa.fwd:MSG-OFF-1",
    });
  });

  it("REGRESSÃO: SAIR continua fazendo opt-out + ack ANTES do bot, mesmo com bot ligado", async () => {
    await setSettings(true, true);
    const [customer] = await db
      .insert(schema.customers)
      .values({ fullName: "Ana Cliente", phoneE164: PHONE_E164, marketingOptIn: true })
      .returning({ id: schema.customers.id });

    const result = await processZapiInbound(sdb, {
      providedSecret: SECRET,
      body: receivedMessage("MSG-SAIR-BOT", "  saír  "),
    });

    expect(result).toMatchObject({ action: "opt_out", optedOut: true });

    const [row] = await db
      .select()
      .from(schema.customers)
      .where(eq(schema.customers.id, customer.id));
    expect(row.marketingOptIn).toBe(false);

    const outbox = await db.select().from(schema.outboxEvents);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      eventType: "wa.send",
      dedupeKey: "wa.optout_ack:MSG-SAIR-BOT",
      payload: { body: OPT_OUT_ACK_BODY },
    });
    expect(outbox.some((e) => e.eventType === "wa.bot_turn")).toBe(false);
  });

  it("duplicata de messageId: segunda entrega não enfileira nada novo", async () => {
    await setSettings(true, true);
    const input = {
      providedSecret: SECRET,
      body: receivedMessage("MSG-DUP-BOT", "Tem no tamanho M?"),
    };

    const first = await processZapiInbound(sdb, input);
    const second = await processZapiInbound(sdb, input);

    expect(first.action).toBe("bot_queued");
    expect(second).toEqual({ action: "duplicate", duplicate: true });

    expect(await db.select().from(schema.inboundEvents)).toHaveLength(1);
    expect(await db.select().from(schema.waMessages)).toHaveLength(1);
    const outbox = await db.select().from(schema.outboxEvents);
    expect(outbox).toHaveLength(1);
    expect(outbox[0].eventType).toBe("wa.bot_turn");
  });
});
