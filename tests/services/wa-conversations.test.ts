// Painel de conversas (Onda C): leitura de lista/thread e ações do dono —
// assumir, devolver ao bot e resposta manual (que assume e enfileira wa.send).
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { ServiceError } from "@/services/settings";
import {
  getWaConversationThread,
  listWaConversations,
  returnWaConversationToBot,
  sendManualWaReply,
  takeOverWaConversation,
} from "@/services/wa-conversations";
import { createTestDb, type TestDb } from "../helpers/db";

const USER_ID = randomUUID();

describe("wa-conversations (painel do admin)", () => {
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

  async function createConversation(
    overrides: Partial<typeof schema.waConversations.$inferInsert> = {},
  ) {
    const [conversation] = await db
      .insert(schema.waConversations)
      .values({ phoneE164: "+5511999990000", status: "open", ...overrides })
      .returning({ id: schema.waConversations.id });
    return conversation.id;
  }

  async function addMessage(
    conversationId: string,
    direction: "inbound" | "outbound",
    body: string,
    createdAt: Date,
    extra: Partial<typeof schema.waMessages.$inferInsert> = {},
  ) {
    await db.insert(schema.waMessages).values({
      conversationId,
      direction,
      body,
      status: direction === "inbound" ? "delivered" : "sent",
      createdAt,
      ...extra,
    });
  }

  it("lista conversas com nome do cliente e a ÚLTIMA mensagem de cada uma", async () => {
    const [customer] = await db
      .insert(schema.customers)
      .values({
        fullName: "Ana Compradora",
        documentNumber: "39053344705",
        phoneE164: "+5511999990000",
      })
      .returning({ id: schema.customers.id });

    const conversationA = await createConversation({ customerId: customer.id });
    const conversationB = await createConversation({
      phoneE164: "+5511888880000",
      status: "human",
    });
    await addMessage(conversationA, "inbound", "Oi!", new Date("2026-08-01T10:00:00Z"));
    await addMessage(conversationA, "outbound", "Olá! Posso ajudar?", new Date("2026-08-01T10:01:00Z"));
    await addMessage(conversationB, "inbound", "Tem entrega hoje?", new Date("2026-08-02T09:00:00Z"));

    const list = await listWaConversations(sdb);

    expect(list).toHaveLength(2);
    const itemA = list.find((item) => item.id === conversationA)!;
    expect(itemA.customerName).toBe("Ana Compradora");
    expect(itemA.lastMessagePreview).toBe("Olá! Posso ajudar?");
    expect(itemA.lastMessageDirection).toBe("outbound");
    const itemB = list.find((item) => item.id === conversationB)!;
    expect(itemB.customerName).toBeNull();
    expect(itemB.status).toBe("human");
    expect(itemB.lastMessagePreview).toBe("Tem entrega hoje?");
  });

  it("thread devolve as mensagens em ordem cronológica; conversa inexistente → null", async () => {
    const conversationId = await createConversation();
    await addMessage(conversationId, "outbound", "segunda", new Date("2026-08-01T11:00:00Z"));
    await addMessage(conversationId, "inbound", "primeira", new Date("2026-08-01T10:00:00Z"));

    const thread = await getWaConversationThread(sdb, conversationId);
    expect(thread).not.toBeNull();
    expect(thread!.messages.map((message) => message.body)).toEqual([
      "primeira",
      "segunda",
    ]);
    // Mensagem comum expõe os campos de mídia com os defaults.
    expect(thread!.messages[0]).toMatchObject({ kind: "text", mediaUrl: null });
    expect(thread!.conversation.phoneE164).toBe("+5511999990000");

    expect(await getWaConversationThread(sdb, randomUUID())).toBeNull();
  });

  it("thread expõe kind e mediaUrl de mensagens de mídia (foto e menu)", async () => {
    const conversationId = await createConversation();
    await addMessage(
      conversationId,
      "outbound",
      "Camiseta Básica",
      new Date("2026-08-01T10:00:00Z"),
      { kind: "image", mediaUrl: "https://cdn.exemplo.com/foto.webp" },
    );
    await addMessage(
      conversationId,
      "outbound",
      "Escolha um produto:\n• Camiseta Básica — R$ 49,90",
      new Date("2026-08-01T10:01:00Z"),
      { kind: "option_list" },
    );

    const thread = await getWaConversationThread(sdb, conversationId);
    expect(thread!.messages).toHaveLength(2);
    expect(thread!.messages[0]).toMatchObject({
      kind: "image",
      mediaUrl: "https://cdn.exemplo.com/foto.webp",
      body: "Camiseta Básica",
    });
    expect(thread!.messages[1]).toMatchObject({
      kind: "option_list",
      mediaUrl: null,
    });
  });

  it("assumir: open → human com audit; repetir é no-op idempotente", async () => {
    const conversationId = await createConversation();

    await takeOverWaConversation(sdb, { conversationId, userId: USER_ID });

    const [conversation] = await db
      .select()
      .from(schema.waConversations)
      .where(eq(schema.waConversations.id, conversationId));
    expect(conversation.status).toBe("human");

    const audits = await db.select().from(schema.auditLog);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorType: "user",
      actorId: USER_ID,
      action: "wa.conversation_takeover",
      entityId: conversationId,
    });

    // Já está 'human': não duplica audit nem falha.
    await takeOverWaConversation(sdb, { conversationId, userId: USER_ID });
    expect(await db.select().from(schema.auditLog)).toHaveLength(1);
  });

  it("devolver ao bot: human → open, limpa o silêncio e audita", async () => {
    const conversationId = await createConversation({
      status: "human",
      botDisabledUntil: new Date(Date.now() + 60 * 60 * 1000),
    });

    await returnWaConversationToBot(sdb, { conversationId, userId: USER_ID });

    const [conversation] = await db
      .select()
      .from(schema.waConversations)
      .where(eq(schema.waConversations.id, conversationId));
    expect(conversation.status).toBe("open");
    expect(conversation.botDisabledUntil).toBeNull();

    const audits = await db.select().from(schema.auditLog);
    expect(audits.map((audit) => audit.action)).toEqual([
      "wa.conversation_return_to_bot",
    ]);
  });

  it("resposta manual: assume a conversa e enfileira wa.send com telefone e cliente", async () => {
    const [customer] = await db
      .insert(schema.customers)
      .values({
        fullName: "Ana Compradora",
        documentNumber: "39053344705",
        phoneE164: "+5511999990000",
      })
      .returning({ id: schema.customers.id });
    const conversationId = await createConversation({ customerId: customer.id });

    const result = await sendManualWaReply(sdb, {
      conversationId,
      userId: USER_ID,
      body: "Oi! Aqui é o dono da loja, posso ajudar?",
    });
    expect(result).toEqual({ queued: true });

    const [conversation] = await db
      .select()
      .from(schema.waConversations)
      .where(eq(schema.waConversations.id, conversationId));
    expect(conversation.status).toBe("human");

    const outbox = await db.select().from(schema.outboxEvents);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      eventType: "wa.send",
      aggregateType: "wa_conversation",
      aggregateId: conversationId,
      payload: {
        phoneE164: "+5511999990000",
        body: "Oi! Aqui é o dono da loja, posso ajudar?",
        customerId: customer.id,
      },
    });

    const audits = await db.select().from(schema.auditLog);
    expect(audits.map((audit) => audit.action)).toEqual([
      "wa.conversation_takeover",
    ]);
  });

  it("resposta manual em conversa já 'human' NÃO re-audita a tomada", async () => {
    const conversationId = await createConversation({ status: "human" });

    await sendManualWaReply(sdb, {
      conversationId,
      userId: USER_ID,
      body: "Segunda resposta",
    });

    expect(await db.select().from(schema.auditLog)).toHaveLength(0);
    expect(await db.select().from(schema.outboxEvents)).toHaveLength(1);
  });

  it("conversa encerrada rejeita ações; corpo vazio rejeita resposta", async () => {
    const conversationId = await createConversation({ status: "closed" });

    await expect(
      takeOverWaConversation(sdb, { conversationId, userId: USER_ID }),
    ).rejects.toThrow(ServiceError);
    await expect(
      sendManualWaReply(sdb, { conversationId, userId: USER_ID, body: "oi" }),
    ).rejects.toThrow(ServiceError);

    const openConversation = await createConversation({
      phoneE164: "+5511777770000",
    });
    await expect(
      sendManualWaReply(sdb, {
        conversationId: openConversation,
        userId: USER_ID,
        body: "   ",
      }),
    ).rejects.toThrow();
  });
});
