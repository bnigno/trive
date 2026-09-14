// Copiloto ponta a ponta (PGlite + fakes): em copiloto o turno vira sugestão
// (nada sai; ferramentas de efeito ficam bloqueadas; aviso à dona com
// dedupe por meia hora); a dona envia (igual ou editada) e a fila entrega
// com dedupe por sugestão; descartar e "superada" pela mensagem nova;
// responder à mão não assume a conversa; o retorno combinado vira sugestão.
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeSalesAssistant } from "@/adapters/assistant/fake";
import { FakeMessagingProvider } from "@/adapters/zapi/fake";
import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { runBotTurn, runScheduledBotTurn } from "@/services/wa-bot";
import { sendManualWaReply } from "@/services/wa-conversations";
import { scheduleBotFollowup } from "@/services/wa-followups";
import {
  approveSuggestion,
  countPendingSuggestions,
  discardSuggestion,
  getPendingSuggestion,
  listPendingSuggestions,
  sendApprovedSuggestion,
  setConversationBotMode,
} from "@/services/wa-suggestions";
import { createTestDb, type TestDb } from "../helpers/db";
import { nextMessageStamp } from "../helpers/clock";

const PHONE = "+5511999990000";
const OWNER = "00000000-0000-4000-8000-00000000d0a0";

let db: TestDb;
let sdb: DbOrTx;
let close: () => Promise<void>;
let assistant: FakeSalesAssistant;
let provider: FakeMessagingProvider;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  sdb = db as unknown as DbOrTx;
  assistant = new FakeSalesAssistant();
  provider = new FakeMessagingProvider();
  vi.stubEnv("ADAPTER_MODE", "fake");
  await db.insert(schema.settings).values([
    { key: "wa_enabled", value: true },
    { key: "bot_enabled", value: true },
    { key: "bot_seller_name", value: "Lia" },
    { key: "bot_mode", value: "copilot" },
    { key: "owner_whatsapp_phone", value: "+5591981037536" },
  ]);
  await db.insert(schema.users).values({ id: OWNER, email: "dona@trive.test", role: "owner", fullName: "Dona" });
});

afterEach(async () => {
  await close();
  vi.unstubAllEnvs();
});

async function createConversation(phoneE164 = PHONE): Promise<string> {
  const [conversation] = await db.insert(schema.waConversations).values({ phoneE164, status: "open" }).returning({ id: schema.waConversations.id });
  return conversation.id;
}

let sequence = 0;
async function addInbound(conversationId: string, body: string): Promise<string> {
  sequence += 1;
  const at = nextMessageStamp();
  const [message] = await db
    .insert(schema.waMessages)
    .values({ conversationId, direction: "inbound", zapiMessageId: `MSG-${sequence}-${Math.random().toString(36).slice(2, 8)}`, body, status: "delivered", deliveredAt: at, createdAt: at })
    .returning({ id: schema.waMessages.id });
  return message.id;
}

describe("turno em copiloto", () => {
  it("vira sugestão: nada sai, a ferramenta de efeito é bloqueada, a dona é avisada uma vez por meia hora; o retry não cria outra", async () => {
    const conversationId = await createConversation();
    const inboundId = await addInbound(conversationId, "quero fechar o pedido");
    assistant.enqueueScript({
      toolCalls: [{ name: "criar_pedido", input: { itens: [{ sku: "X", quantidade: 1 }], nome_completo: "Ana", cpf: "52998224725", telefone: PHONE, cep: "66000000", numero: "1" } }],
      replyTemplate: (texts) => `Claro! ${texts.join(" ")}\n---\nA equipe cuida disso em instantes 🤎`,
    });
    const result = await runBotTurn(sdb, assistant, provider, { conversationId });
    expect(result).toMatchObject({ suggested: true });
    expect(provider.sentMessages).toHaveLength(0);
    const pending = await getPendingSuggestion(sdb, conversationId);
    expect(pending).not.toBeNull();
    expect(pending!.inboundMessageId).toBe(inboundId);
    expect(pending!.bubbles).toHaveLength(2);
    expect(pending!.bubbles[0]).toContain("[Copiloto: criar_pedido não roda agora");
    expect(pending!.toolCalls).toEqual([{ name: "criar_pedido", ok: false }]);
    expect(await db.select().from(schema.orders)).toHaveLength(0);
    const events = await db.select().from(schema.outboxEvents);
    const notice = events.find((event) => event.eventType === "wa.owner_forward");
    expect(notice?.dedupeKey).toMatch(/^wa\.suggestion_notice:/);
    expect(await countPendingSuggestions(sdb)).toBe(1);
    expect((await listPendingSuggestions(sdb))[0]).toMatchObject({ conversationId, label: "(11) •••••-0000" });

    // Retry da fila (mesma inbound): a sugestão é a mesma, o modelo NÃO roda de novo, sem duplicar aviso.
    const turnsBefore = assistant.turns.length;
    assistant.enqueueScript({ replyTemplate: "de novo" });
    const again = await runBotTurn(sdb, assistant, provider, { conversationId });
    expect(again).toMatchObject({ suggested: true, suggestionId: pending!.id });
    expect(assistant.turns).toHaveLength(turnsBefore);
    expect(await db.select().from(schema.waSuggestions)).toHaveLength(1);
    expect((await db.select().from(schema.outboxEvents)).filter((event) => event.eventType === "wa.owner_forward")).toHaveLength(1);
  });

  it("a dona envia como está (dedupe por sugestão; retry não repete) — sai como mensagem da Lia; a nova mensagem da cliente supera a pendente", async () => {
    const conversationId = await createConversation();
    await addInbound(conversationId, "tem o longo dunas em M?");
    assistant.enqueueScript({ replyTemplate: "Tem sim! Quer que eu guarde? 🤎" });
    await runBotTurn(sdb, assistant, provider, { conversationId });
    const pending = (await getPendingSuggestion(sdb, conversationId))!;
    expect(await approveSuggestion(sdb, { suggestionId: pending.id, userId: OWNER })).toEqual({ queued: true });
    await expect(approveSuggestion(sdb, { suggestionId: pending.id, userId: OWNER })).rejects.toThrow("já foi enviada");
    const sendEvent = (await db.select().from(schema.outboxEvents)).find((event) => event.eventType === "wa.suggestion_send");
    expect(sendEvent?.dedupeKey).toBe(`wa.suggestion_send:${pending.id}`);

    expect(await sendApprovedSuggestion(sdb, provider, { suggestionId: pending.id })).toEqual({ sent: true, replied: true });
    expect(await sendApprovedSuggestion(sdb, provider, { suggestionId: pending.id })).toEqual({ sent: true, replied: false });
    expect(provider.sentMessages).toHaveLength(1);
    expect(provider.sentMessages[0].body).toBe("Tem sim! Quer que eu guarde? 🤎");
    const [outbound] = await db.select().from(schema.waMessages).where(eq(schema.waMessages.direction, "outbound"));
    expect(outbound.dedupeKey).toBe(`wa.bot_reply:suggestion:${pending.id}`);
    expect(await getPendingSuggestion(sdb, conversationId)).toBeNull();

    // Ela escreve de novo antes de a dona decidir a próxima: a antiga é superada.
    await addInbound(conversationId, "quanto custa?");
    assistant.enqueueScript({ replyTemplate: "R$ 289,90." });
    await runBotTurn(sdb, assistant, provider, { conversationId });
    const first = (await getPendingSuggestion(sdb, conversationId))!;
    await addInbound(conversationId, "e o frete?");
    assistant.enqueueScript({ replyTemplate: "Me passa o CEP?" });
    await runBotTurn(sdb, assistant, provider, { conversationId });
    const second = (await getPendingSuggestion(sdb, conversationId))!;
    expect(second.id).not.toBe(first.id);
    const [superseded] = await db.select().from(schema.waSuggestions).where(eq(schema.waSuggestions.id, first.id));
    expect(superseded.status).toBe("superseded");
    await expect(approveSuggestion(sdb, { suggestionId: first.id, userId: OWNER })).rejects.toThrow();
  });

  it("editar e enviar manda o texto da dona (sem os anexos da Lia); descartar não manda nada; responder à mão em copiloto não assume a conversa", async () => {
    const conversationId = await createConversation();
    await addInbound(conversationId, "oi");
    assistant.enqueueScript({ replyTemplate: "Oi! Como posso ajudar?" });
    await runBotTurn(sdb, assistant, provider, { conversationId });
    const pending = (await getPendingSuggestion(sdb, conversationId))!;
    await approveSuggestion(sdb, { suggestionId: pending.id, userId: OWNER, body: "Oi, Ana! Sou a Dona — em que posso ajudar?" });
    expect(await sendApprovedSuggestion(sdb, provider, { suggestionId: pending.id })).toEqual({ sent: true, replied: true });
    expect(provider.sentMessages[0].body).toBe("Oi, Ana! Sou a Dona — em que posso ajudar?");

    await addInbound(conversationId, "tem vestido?");
    assistant.enqueueScript({ replyTemplate: "Tem!" });
    await runBotTurn(sdb, assistant, provider, { conversationId });
    const next = (await getPendingSuggestion(sdb, conversationId))!;
    expect(await discardSuggestion(sdb, { suggestionId: next.id, userId: OWNER })).toEqual({ discarded: true });
    expect(await discardSuggestion(sdb, { suggestionId: next.id, userId: OWNER })).toEqual({ discarded: false });
    expect(await sendApprovedSuggestion(sdb, provider, { suggestionId: next.id })).toEqual({ skipped: "nao_aprovada" });
    expect(provider.sentMessages).toHaveLength(1);

    await addInbound(conversationId, "qual o horário?");
    assistant.enqueueScript({ replyTemplate: "Das 9h às 21h." });
    await runBotTurn(sdb, assistant, provider, { conversationId });
    expect(await getPendingSuggestion(sdb, conversationId)).not.toBeNull();
    // Respondendo à mão, a sugestão pendente perde o sentido — e a conversa continua aberta.
    await sendManualWaReply(sdb, { conversationId, userId: OWNER, body: "Respondo eu mesma." });
    const [conversation] = await db.select().from(schema.waConversations).where(eq(schema.waConversations.id, conversationId));
    expect(conversation.status).toBe("open");
    expect(await getPendingSuggestion(sdb, conversationId)).toBeNull();

    // A dona assume a conversa: a sugestão pendente é superada e some do badge.
    await addInbound(conversationId, "e o prazo?");
    assistant.enqueueScript({ replyTemplate: "3 dias." });
    await runBotTurn(sdb, assistant, provider, { conversationId });
    expect(await countPendingSuggestions(sdb)).toBe(1);
    const { takeOverWaConversation } = await import("@/services/wa-conversations");
    await takeOverWaConversation(sdb, { conversationId, userId: OWNER });
    expect(await countPendingSuggestions(sdb)).toBe(0);
    expect(await getPendingSuggestion(sdb, conversationId)).toBeNull();
  });

  it("override por conversa: 'sozinha nesta conversa' responde na hora mesmo com a loja em copiloto; e vice-versa", async () => {
    const conversationId = await createConversation();
    await setConversationBotMode(sdb, { conversationId, mode: "autonomous", userId: OWNER });
    await addInbound(conversationId, "oi");
    assistant.enqueueScript({ replyTemplate: "Oi!" });
    expect(await runBotTurn(sdb, assistant, provider, { conversationId })).toMatchObject({ replied: true });
    expect(provider.sentMessages).toHaveLength(1);

    await db.update(schema.settings).set({ value: "autonomous" }).where(eq(schema.settings.key, "bot_mode"));
    const other = await createConversation("+5511888880000");
    await setConversationBotMode(sdb, { conversationId: other, mode: "copilot", userId: OWNER });
    await addInbound(other, "oi");
    assistant.enqueueScript({ replyTemplate: "Oi!" });
    expect(await runBotTurn(sdb, assistant, provider, { conversationId: other })).toMatchObject({ suggested: true });
    expect(provider.sentMessages).toHaveLength(1);
    // Voltar ao modo da loja (sozinha) supera a sugestão pendente desta conversa.
    expect(await getPendingSuggestion(sdb, other)).not.toBeNull();
    await setConversationBotMode(sdb, { conversationId: other, mode: null, userId: OWNER });
    const [row] = await db.select().from(schema.waConversations).where(eq(schema.waConversations.id, other));
    expect(row.botMode).toBeNull();
    expect(await getPendingSuggestion(sdb, other)).toBeNull();
  });

  it("a Lia pede ajuda em copiloto (recusa/estouro): transfere para a dona sem texto para a cliente; sem sugestão avisa a dona", async () => {
    const conversationId = await createConversation();
    await addInbound(conversationId, "oi");
    assistant.enqueueScript({ toolCalls: [{ name: "transferir_para_atendente", input: { motivo: "x" } }], replyTemplate: "" });
    // transferir está bloqueada em copiloto: não transfere por ferramenta; sem balões → aviso "sem sugestão".
    const result = await runBotTurn(sdb, assistant, provider, { conversationId });
    expect(result).toEqual({ replied: false, handedOff: false });
    const notice = (await db.select().from(schema.outboxEvents)).find((event) => event.eventType === "wa.owner_forward");
    expect(notice?.dedupeKey).toContain(":vazia");
    expect((notice?.payload as { body: string }).body).toContain("não conseguiu sugerir");
    expect(provider.sentMessages).toHaveLength(0);
  });

  it("retorno combinado em copiloto vira sugestão (o combinado conta como cumprido)", async () => {
    const conversationId = await createConversation();
    await addInbound(conversationId, "pode me chamar amanhã");
    // A mensagem dela nasce com o relógio real do banco: o "agora" do retorno
    // precisa vir depois dela, senão o retorno conta como superado.
    const now = new Date(Date.now() + 60_000);
    const dueAt = new Date(now.getTime() + 19 * 60 * 60 * 1000);
    const { followupId } = await scheduleBotFollowup(sdb, { conversationId, phoneE164: PHONE, customerId: null, kind: "customer", reason: "ver se decidiu", dueAt, requestedBy: "lia", now });
    assistant.enqueueScript({ replyTemplate: "Oi! Passando como combinamos 🤎" });
    const result = await runScheduledBotTurn(sdb, assistant, provider, { followupId, now: dueAt });
    expect(result).toMatchObject({ sent: true, replied: false });
    expect(provider.sentMessages).toHaveLength(0);
    const pending = (await getPendingSuggestion(sdb, conversationId))!;
    expect(pending.followupId).toBe(followupId);
    const [followup] = await db.select().from(schema.waFollowups).where(eq(schema.waFollowups.id, followupId));
    expect(followup.status).toBe("sent");
  });
});
