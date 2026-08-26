// Painel de conversas (Onda C): leitura de lista/thread e ações do dono —
// assumir, devolver ao bot e resposta manual (que assume e enfileira wa.send).
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { ServiceError } from "@/services/settings";
import {
  countConversationsAwaitingOwner,
  getWaConversationThread,
  getWaThreadTail,
  listConversationsAwaitingOwner,
  listWaConversations,
  markConversationSeen,
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

  // -------------------------------------------------------------------------
  // unreadCount na lista
  // -------------------------------------------------------------------------

  it("unreadCount: nunca vista conta todo inbound; vista conta só o que veio depois; outbound nunca conta", async () => {
    // A: nunca vista (owner_last_seen_at NULL) com 2 inbound + 1 outbound.
    const conversationA = await createConversation();
    await addMessage(conversationA, "inbound", "oi", new Date("2026-08-01T10:00:00Z"));
    await addMessage(conversationA, "inbound", "tem estoque?", new Date("2026-08-01T10:01:00Z"));
    await addMessage(conversationA, "outbound", "resposta", new Date("2026-08-01T10:02:00Z"));

    // B: vista às 10:00 — só o inbound das 11:00 conta.
    const conversationB = await createConversation({
      phoneE164: "+5511888880000",
      ownerLastSeenAt: new Date("2026-08-01T10:00:00Z"),
    });
    await addMessage(conversationB, "inbound", "antes da leitura", new Date("2026-08-01T09:00:00Z"));
    await addMessage(conversationB, "inbound", "depois da leitura", new Date("2026-08-01T11:00:00Z"));

    // C: vista depois de tudo — zero.
    const conversationC = await createConversation({
      phoneE164: "+5511777770000",
      ownerLastSeenAt: new Date("2026-08-02T00:00:00Z"),
    });
    await addMessage(conversationC, "inbound", "já vista", new Date("2026-08-01T12:00:00Z"));

    // D: só outbound — zero mesmo sem leitura.
    const conversationD = await createConversation({ phoneE164: "+5511666660000" });
    await addMessage(conversationD, "outbound", "notificação", new Date("2026-08-01T12:00:00Z"));

    const list = await listWaConversations(sdb);
    const byId = new Map(list.map((item) => [item.id, item.unreadCount]));
    expect(byId.get(conversationA)).toBe(2);
    expect(byId.get(conversationB)).toBe(1);
    expect(byId.get(conversationC)).toBe(0);
    expect(byId.get(conversationD)).toBe(0);
  });

  // -------------------------------------------------------------------------
  // markConversationSeen
  // -------------------------------------------------------------------------

  it("markSeen grava owner_last_seen_at SEM bumpar updated_at, sem audit; aceita closed", async () => {
    const conversationId = await createConversation({ status: "closed" });
    const [before] = await db
      .select()
      .from(schema.waConversations)
      .where(eq(schema.waConversations.id, conversationId));
    expect(before.ownerLastSeenAt).toBeNull();

    const result = await markConversationSeen(sdb, { conversationId });
    expect(result.seenAt).toBeInstanceOf(Date);

    const [after] = await db
      .select()
      .from(schema.waConversations)
      .where(eq(schema.waConversations.id, conversationId));
    expect(after.ownerLastSeenAt).not.toBeNull();
    // Contrato: ler NÃO reordena a lista — updated_at fica INTACTO.
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    // Telemetria de leitura: sem trilha de auditoria.
    expect(await db.select().from(schema.auditLog)).toHaveLength(0);
  });

  it("markSeen em conversa inexistente lança conversa_inexistente; markSeen zera unreadCount", async () => {
    await expect(
      markConversationSeen(sdb, { conversationId: randomUUID() }),
    ).rejects.toMatchObject({ code: "conversa_inexistente" });

    const conversationId = await createConversation();
    await addMessage(conversationId, "inbound", "oi", new Date("2026-08-01T10:00:00Z"));
    expect((await listWaConversations(sdb))[0].unreadCount).toBe(1);

    await markConversationSeen(sdb, { conversationId });
    expect((await listWaConversations(sdb))[0].unreadCount).toBe(0);
  });

  // -------------------------------------------------------------------------
  // getWaThreadTail
  // -------------------------------------------------------------------------

  it("tail: created_at empatado tem ordem estável (tie-break por id) em 2 chamadas", async () => {
    const conversationId = await createConversation();
    // Mesma transação do bot: created_at idêntico nas três mensagens.
    const tiedAt = new Date("2026-08-01T10:00:00Z");
    const ids = [
      "00000000-0000-4000-8000-0000000000aa",
      "00000000-0000-4000-8000-0000000000bb",
      "00000000-0000-4000-8000-0000000000cc",
    ];
    for (const id of ids) {
      await addMessage(conversationId, "outbound", `corpo ${id.slice(-2)}`, tiedAt, { id });
    }

    const first = await getWaThreadTail(sdb, { conversationId });
    const second = await getWaThreadTail(sdb, { conversationId });
    // Empate de created_at resolve por id, na MESMA direção do sort → asc.
    expect(first!.messages.map((message) => message.id)).toEqual(ids);
    expect(second!.messages.map((message) => message.id)).toEqual(ids);
  });

  it("tail: devolve as ÚLTIMAS N em ordem cronológica, com origin e campos da conversa", async () => {
    const conversationId = await createConversation({ status: "human" });
    await addMessage(conversationId, "inbound", "primeira", new Date("2026-08-01T10:00:00Z"));
    await addMessage(conversationId, "inbound", "segunda", new Date("2026-08-01T10:01:00Z"), {
      status: "delivered",
    });
    await addMessage(conversationId, "outbound", "resposta do robô", new Date("2026-08-01T10:02:00Z"), {
      dedupeKey: "wa.bot_reply:m2",
    });
    await addMessage(conversationId, "outbound", "resposta do dono", new Date("2026-08-01T10:03:00Z"), {
      dedupeKey: "wa.send:evt-1",
    });

    const tail = await getWaThreadTail(sdb, { conversationId, limit: 3 });
    expect(tail!.conversation).toMatchObject({
      id: conversationId,
      status: "human",
      botDisabledUntil: null,
      ownerLastSeenAt: null,
    });
    expect(tail!.messages.map((message) => message.body)).toEqual([
      "segunda",
      "resposta do robô",
      "resposta do dono",
    ]);
    expect(tail!.messages.map((message) => message.origin)).toEqual([
      "customer",
      "bot",
      "manual",
    ]);
    // dedupe_key/template_key são insumo interno — não vazam no tipo.
    expect(tail!.messages[0]).not.toHaveProperty("dedupeKey");
    expect(tail!.messages[0]).not.toHaveProperty("templateKey");

    expect(await getWaThreadTail(sdb, { conversationId: randomUUID() })).toBeNull();
  });

  it("tail: tick de status (UPDATE sem mensagem nova) aparece na chamada seguinte", async () => {
    const conversationId = await createConversation();
    const messageId = "00000000-0000-4000-8000-0000000000dd";
    await addMessage(conversationId, "outbound", "olá", new Date("2026-08-01T10:00:00Z"), {
      id: messageId,
      status: "sent",
    });

    const before = await getWaThreadTail(sdb, { conversationId });
    expect(before!.messages[0]).toMatchObject({ id: messageId, status: "sent" });

    // Webhook de status muda a linha sem criar mensagem nova (tick ✓✓).
    await db
      .update(schema.waMessages)
      .set({ status: "read", readAt: new Date() })
      .where(eq(schema.waMessages.id, messageId));

    const after = await getWaThreadTail(sdb, { conversationId });
    expect(after!.messages[0]).toMatchObject({ id: messageId, status: "read" });
  });

  it("thread completa também usa tie-break por id e expõe origin", async () => {
    const conversationId = await createConversation();
    const tiedAt = new Date("2026-08-01T10:00:00Z");
    await addMessage(conversationId, "outbound", "b", tiedAt, {
      id: "00000000-0000-4000-8000-0000000000b0",
      dedupeKey: "wa.bot_media:m1:0",
    });
    await addMessage(conversationId, "outbound", "a", tiedAt, {
      id: "00000000-0000-4000-8000-0000000000a0",
      dedupeKey: "wa.bot_reply:m1",
    });

    const thread = await getWaConversationThread(sdb, conversationId);
    expect(thread!.messages.map((message) => message.body)).toEqual(["a", "b"]);
    expect(thread!.messages.map((message) => message.origin)).toEqual([
      "bot",
      "bot",
    ]);
  });

  // -------------------------------------------------------------------------
  // countConversationsAwaitingOwner / listConversationsAwaitingOwner
  // -------------------------------------------------------------------------

  it("countAwaiting: só conversa 'human' com inbound não vista; lista traz nome e telefone", async () => {
    const [customer] = await db
      .insert(schema.customers)
      .values({
        fullName: "Ana Compradora",
        documentNumber: "39053344705",
        phoneE164: "+5511999990000",
      })
      .returning({ id: schema.customers.id });

    // Conta: human + inbound nunca vista.
    const awaiting = await createConversation({
      status: "human",
      customerId: customer.id,
    });
    await addMessage(awaiting, "inbound", "cadê você?", new Date("2026-08-01T10:00:00Z"));

    // NÃO conta: human com tudo visto.
    const seen = await createConversation({
      phoneE164: "+5511888880000",
      status: "human",
      ownerLastSeenAt: new Date("2026-08-02T00:00:00Z"),
    });
    await addMessage(seen, "inbound", "obrigado", new Date("2026-08-01T10:00:00Z"));

    // NÃO conta: open com inbound não vista (o bot está atendendo).
    const openConversation = await createConversation({
      phoneE164: "+5511777770000",
    });
    await addMessage(openConversation, "inbound", "oi", new Date("2026-08-01T10:00:00Z"));

    // NÃO conta: closed.
    const closedConversation = await createConversation({
      phoneE164: "+5511666660000",
      status: "closed",
    });
    await addMessage(closedConversation, "inbound", "até mais", new Date("2026-08-01T10:00:00Z"));

    expect(await countConversationsAwaitingOwner(sdb)).toBe(1);
    const list = await listConversationsAwaitingOwner(sdb);
    expect(list).toEqual([
      {
        id: awaiting,
        phoneE164: "+5511999990000",
        customerName: "Ana Compradora",
      },
    ]);

    // Ler a conversa apaga o badge; inbound nova reacende. O "visto" usa o
    // relógio real, então a mensagem nova precisa nascer DEPOIS dele.
    await markConversationSeen(sdb, { conversationId: awaiting });
    expect(await countConversationsAwaitingOwner(sdb)).toBe(0);
    await addMessage(awaiting, "inbound", "voltei", new Date(Date.now() + 60_000));
    expect(await countConversationsAwaitingOwner(sdb)).toBe(1);
  });
});
