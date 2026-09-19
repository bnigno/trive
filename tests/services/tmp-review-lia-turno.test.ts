import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeSalesAssistant } from "@/adapters/assistant/fake";
import { FakeMessagingProvider } from "@/adapters/zapi/fake";
import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { runBotTurn, loadTurnHistory } from "@/services/wa-bot";
import { createTestDb, type TestDb } from "../helpers/db";
import { eq } from "drizzle-orm";

const PHONE = "+5511999990000";
let db: TestDb; let sdb: DbOrTx; let close: () => Promise<void>;
let assistant: FakeSalesAssistant; let provider: FakeMessagingProvider;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  sdb = db as unknown as DbOrTx;
  assistant = new FakeSalesAssistant();
  provider = new FakeMessagingProvider();
  vi.stubEnv("ADAPTER_MODE", "fake");
  await db.insert(schema.settings).values([
    { key: "wa_enabled", value: true },
    { key: "bot_enabled", value: true },
    { key: "bot_media_enabled", value: true },
    { key: "owner_whatsapp_phone", value: "+5591981037536" },
  ]);
});
afterEach(async () => { await close(); vi.unstubAllEnvs(); });

async function conv(status = "open") {
  const [c] = await db.insert(schema.waConversations).values({ phoneE164: PHONE, status }).returning({ id: schema.waConversations.id });
  return c.id;
}
let seq = 0;
async function inbound(conversationId: string, body: string, at: Date, extra: Partial<typeof schema.waMessages.$inferInsert> = {}) {
  seq += 1;
  const [m] = await db.insert(schema.waMessages).values({ conversationId, direction: "inbound", zapiMessageId: `MSG-${seq}`, body, status: "delivered", deliveredAt: at, createdAt: at, ...extra }).returning({ id: schema.waMessages.id });
  return m.id;
}
async function outbound(conversationId: string, body: string, dedupeKey: string, at: Date, extra: Partial<typeof schema.waMessages.$inferInsert> = {}) {
  const [m] = await db.insert(schema.waMessages).values({ conversationId, direction: "outbound", body, dedupeKey, status: "sent", createdAt: at, ...extra }).returning({ id: schema.waMessages.id });
  return m.id;
}

describe("tmp review", () => {
  it("(a) 3 balões + lista :0 anchored; cartão :card depois da nova inbound → histórico termina com assistant", async () => {
    const c = await conv();
    const base = Date.now() - 60_000;
    await inbound(c, "Mercadinho camarada", new Date(base));
    const b = await inbound(c, "9", new Date(base + 3_000));
    await inbound(c, "Não precisa de nota", new Date(base + 13_000));
    await outbound(c, "Toque abaixo (1–3 de 3)", `wa.bot_media:${b}:0`, new Date(base + 14_000), { kind: "option_list" });
    await outbound(c, "Combinado 1", `wa.bot_reply:${b}`, new Date(base + 14_100));
    await outbound(c, "Combinado 2", `wa.bot_reply:${b}:1`, new Date(base + 14_200));
    await outbound(c, "Combinado 3", `wa.bot_reply:${b}:2`, new Date(base + 14_300));
    // cartão do turno de B sai pela fila depois do commit (render frio)
    await outbound(c, "Olha esses looks", `wa.bot_media:${b}:card`, new Date(base + 16_000), { kind: "image", mediaUrl: "https://cdn.test/card.png" });
    assistant.enqueueScript({ replyTemplate: "ok" });
    const r = await runBotTurn(sdb, assistant, provider, { conversationId: c });
    console.log("(a) result", r);
    const h = assistant.inputs[0]?.history ?? [];
    console.log("(a) roles", h.map((m) => `${m.role}:${m.text.slice(0, 22)}`));
    console.log("(a) LAST ROLE =", h.at(-1)?.role);
  });

  it("(a2) copiloto: sugestão aprovada (wa.bot_reply:suggestion:) depois da inbound nova → termina com assistant", async () => {
    const c = await conv();
    const base = Date.now() - 60_000;
    const n1 = await inbound(c, "Oi", new Date(base));
    await inbound(c, "Tem o M?", new Date(base + 5_000));
    await outbound(c, "Oi! Temos sim", `wa.bot_reply:suggestion:${n1}`, new Date(base + 10_000));
    assistant.enqueueScript({ replyTemplate: "ok" });
    const r = await runBotTurn(sdb, assistant, provider, { conversationId: c });
    const h = assistant.inputs[0]?.history ?? [];
    console.log("(a2)", r, h.map((m) => `${m.role}:${m.text.slice(0, 22)}`), "LAST=", h.at(-1)?.role);
  });

  it("(a3) retorno combinado saiu enquanto ela escrevia → termina com assistant", async () => {
    const c = await conv();
    const base = Date.now() - 60_000;
    const n1 = await inbound(c, "Oi", new Date(base));
    await outbound(c, "Oi!", `wa.bot_reply:${n1}`, new Date(base + 1_000));
    await inbound(c, "Voltei", new Date(base + 5_000));
    await outbound(c, "E aí, pensou?", `wa.bot_reply:followup:f1`, new Date(base + 6_000));
    assistant.enqueueScript({ replyTemplate: "ok" });
    const r = await runBotTurn(sdb, assistant, provider, { conversationId: c });
    const h = assistant.inputs[0]?.history ?? [];
    console.log("(a3)", r, h.map((m) => `${m.role}:${m.text.slice(0, 22)}`), "LAST=", h.at(-1)?.role);
  });

  it("(c) conversa devolvida à Lia depois de longa troca com a equipe: fotos antigas viram 'pendentes' (unavailable)", async () => {
    const c = await conv();
    const base = Date.now() - 20 * 60_000;
    const n1 = await inbound(c, "Oi", new Date(base));
    await outbound(c, "Oi!", `wa.bot_reply:${n1}`, new Date(base + 1_000));
    for (let i = 0; i < 5; i++) {
      await inbound(c, "[a cliente enviou uma foto]", new Date(base + 10_000 + i * 2_000), { kind: "image", mediaUrl: `https://cdn.test/f${i}.jpg` });
      await outbound(c, `Linda ${i}`, `wa.send:m${i}`, new Date(base + 11_000 + i * 2_000));
    }
    await inbound(c, "E o preço?", new Date(base + 60_000));
    const [conversation] = await db.select().from(schema.waConversations).where(eq(schema.waConversations.id, c));
    const loaded = await loadTurnHistory(sdb, provider, { conversation, now: new Date() });
    if ("skipped" in loaded) throw new Error("skipped");
    console.log("(c) pendingInbound", loaded.pendingInbound, "media", loaded.media);
    console.log("(c) hist", loaded.history.map((m) => `${m.role}:${m.text.slice(0, 60)}`));
  });

  it("(d) template automático depois da pendente termina o histórico no papel user", async () => {
    const c = await conv();
    const base = Date.now() - 60_000;
    const n1 = await inbound(c, "Oi", new Date(base));
    await outbound(c, "Oi!", `wa.bot_reply:${n1}`, new Date(base + 1_000));
    await inbound(c, "Qual o prazo?", new Date(base + 5_000));
    await outbound(c, "Seu pedido #1001 foi pago!", `order.paid:1001`, new Date(base + 6_000), { templateKey: "order_paid" });
    assistant.enqueueScript({ replyTemplate: "ok" });
    await runBotTurn(sdb, assistant, provider, { conversationId: c });
    console.log("(d)", assistant.inputs[0].history.slice(-3).map((m) => `${m.role}:${m.text.slice(0, 50)}`));
  });

  it("(e) mensagem manual com body vazio / só marcador", async () => {
    const c = await conv();
    const base = Date.now() - 60_000;
    await inbound(c, "Oi", new Date(base));
    await outbound(c, "", `wa.send:m1`, new Date(base + 1_000));
    await inbound(c, "Tem?", new Date(base + 2_000));
    assistant.enqueueScript({ replyTemplate: "ok" });
    await runBotTurn(sdb, assistant, provider, { conversationId: c });
    console.log("(e)", JSON.stringify(assistant.inputs[0].history.slice(-3).map((m) => `${m.role}:${m.text}`)));
  });

  it("(g) HISTORY_LIMIT: resposta ancorada fora da janela", async () => {
    const c = await conv();
    const base = Date.now() - 60 * 60_000;
    const x = await inbound(c, "X", new Date(base));
    await outbound(c, "resp X", `wa.bot_reply:${x}`, new Date(base + 1_000));
    for (let i = 0; i < 45; i++) await outbound(c, `aviso ${i}`, `auto:${i}`, new Date(base + 2_000 + i * 1_000), { templateKey: "t" });
    await inbound(c, "Y", new Date(base + 60_000));
    const [conversation] = await db.select().from(schema.waConversations).where(eq(schema.waConversations.id, c));
    const loaded = await loadTurnHistory(sdb, provider, { conversation, now: new Date() });
    if ("skipped" in loaded) throw new Error("skipped");
    console.log("(g) pending", loaded.pendingInbound, "first", loaded.history[0]?.role, loaded.history.length, "last", loaded.history.at(-1)?.role);
  });
});
