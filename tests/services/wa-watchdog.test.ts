// Vigia do WhatsApp: chats da Z-API × o que o sistema registrou → alerta ao
// dono (WhatsApp + e-mail) uma vez por buraco.
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeEmailProvider } from "@/adapters/email/fake";
import { FakeMessagingProvider } from "@/adapters/zapi/fake";
import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { chatAddress, checkInboundGapsAndAlert } from "@/services/wa-watchdog";
import { createTestDb, type TestDb } from "../helpers/db";

const NOW = new Date("2026-09-16T23:00:00Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

describe("checkInboundGapsAndAlert", () => {
  let db: TestDb;
  let sdb: DbOrTx;
  let close: () => Promise<void>;
  let provider: FakeMessagingProvider;
  let email: FakeEmailProvider;

  beforeEach(async () => {
    ({ db, close } = await createTestDb());
    sdb = db as unknown as DbOrTx;
    provider = new FakeMessagingProvider();
    email = new FakeEmailProvider();
    await db.insert(schema.settings).values([
      { key: "wa_enabled", value: true },
      { key: "owner_whatsapp_phone", value: "+5511988887777" },
    ]);
  });

  afterEach(async () => {
    await close();
  });

  it("chatAddress: telefone da Z-API vira E.164, LID fica LID, grupo/lixo vira null", () => {
    expect(chatAddress("5591999991528")).toBe("+5591999991528");
    expect(chatAddress("220839349862480@lid")).toBe("220839349862480@lid");
    expect(chatAddress("120363041234567890-group")).toBeNull();
    expect(chatAddress("")).toBeNull();
  });

  it("chat com mensagem que o sistema não tem: avisa o dono no WhatsApp e por e-mail, e não repete o mesmo buraco", async () => {
    // Conversa conhecida com atividade DEPOIS da última mensagem do chat: não é buraco.
    const [known] = await db
      .insert(schema.waConversations)
      .values({ phoneE164: "+5591999997536", lastInboundAt: minutesAgo(29), lastOutboundAt: minutesAgo(28) })
      .returning({ id: schema.waConversations.id });
    provider.recentChats = [
      { phone: "5591999991528", lid: null, name: "Sogra", lastMessageAt: minutesAgo(10), unread: 1, isGroup: false },
      { phone: "5591999997536", lid: null, name: "Fabiano", lastMessageAt: minutesAgo(30), unread: 0, isGroup: false },
      { phone: "120363041234567890-group", lid: null, name: "TRIVÉ VIP", lastMessageAt: minutesAgo(5), unread: 3, isGroup: true },
      { phone: "5591999990002", lid: null, name: "Agora", lastMessageAt: minutesAgo(1), unread: 1, isGroup: false },
    ];

    const first = await checkInboundGapsAndAlert(sdb, provider, { now: NOW, emailProvider: email });
    expect(first).toEqual({ checked: 3, gaps: 1, alerted: 1, alreadyAlerted: 0 });

    // WhatsApp do dono: uma mensagem com o nome e a hora local (20:50 em São Paulo).
    const owner = provider.sentMessages.filter((m) => m.toE164 === "+5511988887777");
    expect(owner).toHaveLength(1);
    // 22:50Z = 19:50 em São Paulo (fuso da loja).
    expect(owner[0].body).toContain("Sogra às 19:50");
    expect(owner[0].body).toContain("NÃO chegou ao sistema");
    // E-mail com o mesmo texto.
    expect(email.sentEmails).toHaveLength(1);
    expect(email.sentEmails[0].subject).toContain("não chegou ao sistema");

    // Segunda rodada, 10 min depois: o mesmo buraco não avisa de novo. (O chat
    // "Agora" sai da lista: com 11 min ele deixaria de ser "a caminho".)
    provider.recentChats = provider.recentChats.filter((chat) => chat.name !== "Agora");
    const second = await checkInboundGapsAndAlert(sdb, provider, { now: new Date(NOW.getTime() + 10 * 60_000), emailProvider: email });
    expect(second).toEqual({ checked: 2, gaps: 1, alerted: 0, alreadyAlerted: 1 });
    expect(provider.sentMessages.filter((m) => m.toE164 === "+5511988887777")).toHaveLength(1);

    // Mensagem mais nova no mesmo chat dentro da mesma hora: NÃO avisa de novo (teto por chat).
    provider.recentChats[0] = { ...provider.recentChats[0], lastMessageAt: new Date(NOW.getTime() + 5 * 60_000) };
    const third = await checkInboundGapsAndAlert(sdb, provider, { now: new Date(NOW.getTime() + 10 * 60_000), emailProvider: email });
    expect(third).toEqual({ checked: 2, gaps: 1, alerted: 0, alreadyAlerted: 1 });

    // Passada a hora, com mensagem mais nova: avisa.
    provider.recentChats[0] = { ...provider.recentChats[0], lastMessageAt: new Date(NOW.getTime() + 55 * 60_000) };
    const fourth = await checkInboundGapsAndAlert(sdb, provider, { now: new Date(NOW.getTime() + 61 * 60_000), emailProvider: email });
    expect(fourth).toMatchObject({ alerted: 1 });

    const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "wa.watchdog_alert"));
    expect(audits).toHaveLength(2);
    expect(audits[0].entityId).toBe("+5591999991528");
    expect(known.id).toBeTruthy();
  });

  it("conversa achada pelo LID ou pela mensagem mais recente não é buraco", async () => {
    const [conversation] = await db
      .insert(schema.waConversations)
      .values({ phoneE164: "220839349862480@lid", lid: "220839349862480@lid" })
      .returning({ id: schema.waConversations.id });
    await db.insert(schema.waMessages).values({
      conversationId: conversation.id,
      direction: "inbound",
      body: "Boa noite",
      status: "delivered",
      createdAt: minutesAgo(19),
    });
    provider.recentChats = [{ phone: "220839349862480@lid", lid: null, name: null, lastMessageAt: minutesAgo(20), unread: 0, isGroup: false }];
    const result = await checkInboundGapsAndAlert(sdb, provider, { now: NOW, emailProvider: email });
    expect(result).toEqual({ checked: 1, gaps: 0, alerted: 0, alreadyAlerted: 0 });

    // A Z-API resolve o telefone e manda o LID à parte: a conversa (só LID) continua conhecida.
    provider.recentChats = [{ phone: "5591999998888", lid: "220839349862480@lid", name: "Dona do LID", lastMessageAt: minutesAgo(20), unread: 0, isGroup: false }];
    expect(await checkInboundGapsAndAlert(sdb, provider, { now: NOW, emailProvider: email })).toEqual({ checked: 1, gaps: 0, alerted: 0, alreadyAlerted: 0 });
  });

  it("buraco escondido: mensagem perdida, depois um envio nosso — o chat tem não-lida numa conversa que a Lia lê → avisa", async () => {
    await db.insert(schema.settings).values({ key: "bot_enabled", value: true });
    const [conversation] = await db
      .insert(schema.waConversations)
      .values({ phoneE164: "+5591999990005", status: "open", lastInboundAt: minutesAgo(90), lastOutboundAt: minutesAgo(30) })
      .returning({ id: schema.waConversations.id });
    provider.recentChats = [{ phone: "5591999990005", lid: null, name: "Cliente", lastMessageAt: minutesAgo(30), unread: 1, isGroup: false }];
    const result = await checkInboundGapsAndAlert(sdb, provider, { now: NOW, emailProvider: email });
    expect(result).toMatchObject({ gaps: 1, alerted: 1 });

    // Conversa em atendimento humano: ninguém marca lido — não é buraco.
    await db.update(schema.waConversations).set({ status: "human" }).where(eq(schema.waConversations.id, conversation.id));
    await db.delete(schema.auditLog);
    expect(await checkInboundGapsAndAlert(sdb, provider, { now: NOW, emailProvider: email })).toEqual({ checked: 1, gaps: 0, alerted: 0, alreadyAlerted: 0 });
  });

  it("WhatsApp desligado ou Z-API fora do ar: pula sem lançar", async () => {
    provider.simulateDisconnect();
    provider.recentChats = [{ phone: "5591999991528", lid: null, name: "Sogra", lastMessageAt: minutesAgo(10), unread: 1, isGroup: false }];
    expect(await checkInboundGapsAndAlert(sdb, provider, { now: NOW, emailProvider: email })).toMatchObject({ skipped: "z-api_indisponivel" });
    await db.update(schema.settings).set({ value: false }).where(eq(schema.settings.key, "wa_enabled"));
    expect(await checkInboundGapsAndAlert(sdb, provider, { now: NOW, emailProvider: email })).toEqual({ skipped: "desabilitado" });
  });
});
