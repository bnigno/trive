import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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

describe("processZapiInbound", () => {
  let db: TestDb;
  let sdb: DbOrTx;
  let close: () => Promise<void>;
  const originalSecret = process.env.ZAPI_WEBHOOK_SECRET;
  const originalClientToken = process.env.ZAPI_CLIENT_TOKEN;

  beforeEach(async () => {
    ({ db, close } = await createTestDb());
    sdb = db as unknown as DbOrTx;
    process.env.ZAPI_WEBHOOK_SECRET = SECRET;
    delete process.env.ZAPI_CLIENT_TOKEN;
  });

  afterEach(async () => {
    await close();
    if (originalSecret === undefined) delete process.env.ZAPI_WEBHOOK_SECRET;
    else process.env.ZAPI_WEBHOOK_SECRET = originalSecret;
    if (originalClientToken === undefined) delete process.env.ZAPI_CLIENT_TOKEN;
    else process.env.ZAPI_CLIENT_TOKEN = originalClientToken;
  });

  async function createOptedInCustomer(phoneE164 = PHONE_E164): Promise<string> {
    const [customer] = await db
      .insert(schema.customers)
      .values({ fullName: "Ana Cliente", phoneE164, marketingOptIn: true })
      .returning({ id: schema.customers.id });
    return customer.id;
  }

  it("secret errado: rejeita sem tocar no banco (rota devolve 404)", async () => {
    const result = await processZapiInbound(sdb, {
      providedSecret: "secret-invalido",
      body: receivedMessage("MSG-1", "Oi"),
    });

    expect(result).toEqual({ action: "rejected", rejected: "secret" });
    expect(await db.select().from(schema.inboundEvents)).toHaveLength(0);
    expect(await db.select().from(schema.waConversations)).toHaveLength(0);
  });

  it("client-token divergente do env: rejeita; ausente: aceita", async () => {
    process.env.ZAPI_CLIENT_TOKEN = "token-esperado";

    const rejected = await processZapiInbound(sdb, {
      providedSecret: SECRET,
      clientToken: "token-errado",
      body: receivedMessage("MSG-CT-1", "Oi"),
    });
    expect(rejected).toEqual({ action: "rejected", rejected: "client_token" });

    const accepted = await processZapiInbound(sdb, {
      providedSecret: SECRET,
      clientToken: null,
      body: receivedMessage("MSG-CT-2", "Oi"),
    });
    expect(accepted.action).toBe("forwarded");
  });

  it("duplicata (mesmo messageId): segunda entrega retorna duplicate e não duplica nada", async () => {
    const input = {
      providedSecret: SECRET,
      body: receivedMessage("MSG-DUP", "Tem no tamanho M?"),
    };

    const first = await processZapiInbound(sdb, input);
    const second = await processZapiInbound(sdb, input);

    expect(first.action).toBe("forwarded");
    expect(second).toEqual({ action: "duplicate", duplicate: true });

    expect(await db.select().from(schema.inboundEvents)).toHaveLength(1);
    expect(await db.select().from(schema.waMessages)).toHaveLength(1);
    expect(await db.select().from(schema.outboxEvents)).toHaveLength(1);
  });

  it("SAIR (com trim/caixa/acento) desliga o opt-in, audita e enfileira o ack", async () => {
    const customerId = await createOptedInCustomer();

    const result = await processZapiInbound(sdb, {
      providedSecret: SECRET,
      body: receivedMessage("MSG-SAIR", "  saír  "),
    });

    expect(result).toMatchObject({ action: "opt_out", optedOut: true });

    const [customer] = await db
      .select()
      .from(schema.customers)
      .where(eq(schema.customers.id, customerId));
    expect(customer.marketingOptIn).toBe(false);

    const audits = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "wa.opt_out"));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorType: "customer",
      actorId: customerId,
      entityType: "customer",
      entityId: customerId,
      before: { marketingOptIn: true },
      after: { marketingOptIn: false },
    });

    const outbox = await db.select().from(schema.outboxEvents);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      eventType: "wa.send",
      dedupeKey: "wa.optout_ack:MSG-SAIR",
      payload: {
        templateKey: null,
        phoneE164: PHONE_E164,
        body: OPT_OUT_ACK_BODY,
        dedupeKey: "wa.optout_ack:MSG-SAIR",
      },
    });

    // Conversa vinculada ao cliente + mensagem inbound registrada.
    const conversations = await db.select().from(schema.waConversations);
    expect(conversations).toHaveLength(1);
    expect(conversations[0]).toMatchObject({
      phoneE164: PHONE_E164,
      customerId,
      status: "open",
    });
    expect(conversations[0].lastInboundAt).not.toBeNull();

    const messages = await db.select().from(schema.waMessages);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      conversationId: conversations[0].id,
      direction: "inbound",
      zapiMessageId: "MSG-SAIR",
      body: "  saír  ",
    });
  });

  it("PARAR de número sem cadastro: ack enfileirado mesmo assim, sem audit", async () => {
    const result = await processZapiInbound(sdb, {
      providedSecret: SECRET,
      body: receivedMessage("MSG-PARAR", "PARAR", "5521988887777"),
    });

    expect(result).toMatchObject({ action: "opt_out", optedOut: false });
    expect(await db.select().from(schema.auditLog)).toHaveLength(0);

    const outbox = await db.select().from(schema.outboxEvents);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      eventType: "wa.send",
      dedupeKey: "wa.optout_ack:MSG-PARAR",
    });
  });

  it("texto comum: encaminha ao dono com customerName e trunca em 300 chars", async () => {
    await createOptedInCustomer();
    const longText = "Quero trocar o pedido. ".repeat(30); // > 300 chars

    const result = await processZapiInbound(sdb, {
      providedSecret: SECRET,
      body: receivedMessage("MSG-FWD", longText),
    });

    expect(result.action).toBe("forwarded");

    const outbox = await db.select().from(schema.outboxEvents);
    expect(outbox).toHaveLength(1);
    expect(outbox[0].eventType).toBe("wa.owner_forward");
    expect(outbox[0].dedupeKey).toBe("wa.fwd:MSG-FWD");
    const payload = outbox[0].payload as {
      phoneE164: string;
      body: string;
      customerName?: string;
    };
    expect(payload.phoneE164).toBe(PHONE_E164);
    expect(payload.customerName).toBe("Ana Cliente");
    expect(payload.body).toHaveLength(300);
    expect(payload.body).toBe(longText.slice(0, 300));

    // Cliente NÃO recebe resposta automática (sem chatbot): nada de wa.send.
    expect(outbox.some((event) => event.eventType === "wa.send")).toBe(false);
  });

  it("segunda mensagem do mesmo número reaproveita a conversa aberta", async () => {
    await processZapiInbound(sdb, {
      providedSecret: SECRET,
      body: receivedMessage("MSG-A", "Primeira"),
    });
    await processZapiInbound(sdb, {
      providedSecret: SECRET,
      body: receivedMessage("MSG-B", "Segunda"),
    });

    const conversations = await db.select().from(schema.waConversations);
    expect(conversations).toHaveLength(1);
    expect(conversations[0].customerId).toBeNull();

    const messages = await db.select().from(schema.waMessages);
    expect(messages).toHaveLength(2);
    expect(messages.every((m) => m.conversationId === conversations[0].id)).toBe(true);
  });

  it("callback de status atualiza a mensagem (sent → delivered → read, monotônico)", async () => {
    // Mensagem outbound existente com zapi_message_id, status 'sent'.
    const [conv] = await db
      .insert(schema.waConversations)
      .values({ phoneE164: "+5511977776666" })
      .returning({ id: schema.waConversations.id });
    const [msg] = await db
      .insert(schema.waMessages)
      .values({
        conversationId: conv.id,
        direction: "outbound",
        body: "Olá!",
        status: "sent",
        zapiMessageId: "MSG-STATUS",
      })
      .returning({ id: schema.waMessages.id });

    const statusBody = (status: string) => ({
      type: "MessageStatusCallback",
      phone: PHONE_ZAPI,
      status,
      ids: ["MSG-STATUS"],
    });

    const delivered = await processZapiInbound(sdb, {
      providedSecret: SECRET,
      body: statusBody("RECEIVED"),
    });
    expect(delivered).toEqual({ action: "status", updated: 1 });

    const read = await processZapiInbound(sdb, {
      providedSecret: SECRET,
      body: statusBody("READ"),
    });
    expect(read).toEqual({ action: "status", updated: 1 });

    // Monotônico: um DELIVERED atrasado não regride a mensagem lida.
    const late = await processZapiInbound(sdb, {
      providedSecret: SECRET,
      body: statusBody("RECEIVED"),
    });
    expect(late).toEqual({ action: "status", updated: 0 });

    const [finalMsg] = await db
      .select()
      .from(schema.waMessages)
      .where(eq(schema.waMessages.id, msg.id));
    expect(finalMsg.status).toBe("read");
    expect(finalMsg.deliveredAt).not.toBeNull();
    expect(finalMsg.readAt).not.toBeNull();
    // Callbacks de status não registram inbound_events (sem dedupe a consumir).
    const statusInbound = (await db.select().from(schema.inboundEvents)).filter(
      (e) => e.externalEventId.includes("MSG-STATUS"),
    );
    expect(statusInbound).toHaveLength(0);
    expect(await db.select().from(schema.outboxEvents)).toHaveLength(0);
  });

  it("eco de mensagem própria (fromMe) e body não-objeto são ignorados", async () => {
    const echo = await processZapiInbound(sdb, {
      providedSecret: SECRET,
      body: { ...receivedMessage("MSG-ECO", "resposta do dono"), fromMe: true },
    });
    expect(echo).toEqual({ action: "ignored", ignored: true });

    const garbage = await processZapiInbound(sdb, {
      providedSecret: SECRET,
      body: "lixo qualquer",
    });
    expect(garbage).toEqual({ action: "ignored", ignored: true });

    expect(await db.select().from(schema.inboundEvents)).toHaveLength(0);
  });

  it("inbound_event fica done com processedAt após processar", async () => {
    await processZapiInbound(sdb, {
      providedSecret: SECRET,
      body: receivedMessage("MSG-DONE", "Oi, tudo bem?"),
    });

    const [inbound] = await db.select().from(schema.inboundEvents);
    expect(inbound).toMatchObject({
      source: "zapi",
      externalEventId: "MSG-DONE",
      status: "done",
    });
    expect(inbound.processedAt).not.toBeNull();
  });
});
