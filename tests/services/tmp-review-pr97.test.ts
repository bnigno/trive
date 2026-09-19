import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeSalesAssistant } from "@/adapters/assistant/fake";
import { FakeMessagingProvider } from "@/adapters/zapi/fake";
import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { runBotTurn } from "@/services/wa-bot";
import { returnWaConversationToBot } from "@/services/wa-conversations";
import { createTestDb, type TestDb } from "../helpers/db";

const PHONE = "+5511999990000";
const OWNER = "00000000-0000-4000-8000-00000000d0a0";
let db: TestDb; let sdb: DbOrTx; let close: () => Promise<void>;
let assistant: FakeSalesAssistant; let provider: FakeMessagingProvider;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  sdb = db as unknown as DbOrTx;
  assistant = new FakeSalesAssistant();
  provider = new FakeMessagingProvider();
  vi.stubEnv("ADAPTER_MODE", "fake");
  await db.insert(schema.settings).values([
    { key: "wa_enabled", value: true }, { key: "bot_enabled", value: true }, { key: "owner_whatsapp_phone", value: "+5591981037536" },
  ]);
  await db.insert(schema.users).values({ id: OWNER, email: "dona@trive.test", role: "owner", fullName: "Dona" });
});
afterEach(async () => { await close(); vi.unstubAllEnvs(); });

let seq = 0;
async function conv(status = "open") { const [c] = await db.insert(schema.waConversations).values({ phoneE164: PHONE, status }).returning({ id: schema.waConversations.id }); return c.id; }
async function inbound(conversationId: string, body: string, at: Date) {
  seq += 1;
  const [m] = await db.insert(schema.waMessages).values({ conversationId, direction: "inbound", zapiMessageId: `MSG-${seq}`, body, status: "delivered", deliveredAt: at, createdAt: at }).returning({ id: schema.waMessages.id });
  return m.id;
}
async function outbound(conversationId: string, body: string, dedupeKey: string, at: Date, extra: Record<string, unknown> = {}) {
  await db.insert(schema.waMessages).values({ conversationId, direction: "outbound", body, dedupeKey, status: "sent", createdAt: at, ...extra });
}

describe("tmp: saída da Lia sem inbound ancorada depois da pendente", () => {
  it.each([
    ["cartão atrasado wa.bot_media:<A>:card", (a: string) => `wa.bot_media:${a}:card`],
    ["retorno combinado wa.bot_reply:followup:<id>", () => "wa.bot_reply:followup:11111111-1111-4111-8111-111111111111"],
    ["cortesia pós-transferência wa.bot_handoff_notice:<A>", (a: string) => `wa.bot_handoff_notice:${a}`],
    ["sugestão aprovada (copiloto) wa.bot_reply:suggestion:<id>", () => "wa.bot_reply:suggestion:22222222-2222-4222-8222-222222222222"],
  ])("%s depois da mensagem nova → histórico termina com assistant", async (_label, key) => {
    const c = await conv();
    const base = Date.now() - 60_000;
    const a = await inbound(c, "Quero ver vestidos", new Date(base));
    await outbound(c, "Mandei um cartão com as três 🤎", `wa.bot_reply:${a}`, new Date(base + 2_000));
    await inbound(c, "Quero o M", new Date(base + 3_000));
    await outbound(c, "[cartão]", key(a), new Date(base + 5_000), { kind: "image" });
    assistant.enqueueScript({ replyTemplate: "ok" });
    const result = await runBotTurn(sdb, assistant, provider, { conversationId: c });
    const history = assistant.inputs[0]?.history ?? [];
    console.log(_label, JSON.stringify(result), history.slice(-3).map((m) => `${m.role}:${m.text.slice(0, 30)}`));
    expect(history.at(-1)?.role).toBe("user");
  });

  it("copiloto: pendente nunca zera → todas as inbounds desde a última resposta autônoma contam", async () => {
    const c = await conv();
    const base = Date.now() - 60_000;
    const a = await inbound(c, "Quero ver vestidos", new Date(base));
    await outbound(c, "Temos o Longo Dunas", "wa.bot_reply:suggestion:22222222-2222-4222-8222-222222222222", new Date(base + 2_000));
    // Evento atrasado da inbound A: já respondida pela sugestão aprovada → deveria pular.
    const result = await runBotTurn(sdb, assistant, provider, { conversationId: c });
    console.log("copiloto atrasado", JSON.stringify(result), a);
    expect(result).toEqual({ skipped: "ja_respondida" });
  });

  it("runbook: depois do plano B autônomo, Devolver à Lia NÃO responde o que ficou pendente", async () => {
    const c = await conv("human");
    const base = Date.now() - 60_000;
    const npn = await inbound(c, "Não precisa de nota", new Date(base));
    await outbound(c, "Assistente indisponível…", `wa.bot_reply:${npn}`, new Date(base + 2_000));
    const back = await returnWaConversationToBot(sdb, { conversationId: c, userId: OWNER });
    console.log("devolver", JSON.stringify(back));
    assistant.enqueueScript({ replyTemplate: "Sem problema" });
    const result = await runBotTurn(sdb, assistant, provider, { conversationId: c });
    console.log("turno após devolver", JSON.stringify(result));
    expect(back.botTurnQueued).toBe(true);
    expect(result).toEqual({ replied: true, handedOff: false });
  });
});
