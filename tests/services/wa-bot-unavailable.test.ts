// Modelo fora do ar e mensagens em rajada (PGlite + fakes). O caso real de
// 14/09: a cliente mandou "Oi" e "Quero um vestido vermelho" em um minuto;
// cada mensagem enfileira um turno, o primeiro respondeu às duas e o segundo
// rodou o modelo de novo — bateu no limite por minuto da API (429) e a
// conversa foi para a equipe com um "indisponível" sem causa. Agora: turno
// sem pendência não roda o modelo; falha passageira relança para a fila
// tentar de novo; só na última tentativa (ou falha que não melhora sozinha)
// vem o plano B, com a causa no motivo; "Devolver à Lia" com mensagem
// esperando enfileira o turno.
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AssistantUnavailableError } from "@/adapters/assistant";
import { FakeSalesAssistant } from "@/adapters/assistant/fake";
import { FakeMessagingProvider } from "@/adapters/zapi/fake";
import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { BOT_UNAVAILABLE_REPLY } from "@/services/bot/shared";
import { BOT_TURN_MODEL_ATTEMPTS, runBotTurn } from "@/services/wa-bot";
import { returnWaConversationToBot } from "@/services/wa-conversations";
import { createTestDb, type TestDb } from "../helpers/db";

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
    { key: "owner_whatsapp_phone", value: "+5591981037536" },
  ]);
  await db.insert(schema.users).values({ id: OWNER, email: "dona@trive.test", role: "owner", fullName: "Dona" });
});

afterEach(async () => {
  await close();
  vi.unstubAllEnvs();
});

async function createConversation(status = "open"): Promise<string> {
  const [conversation] = await db.insert(schema.waConversations).values({ phoneE164: PHONE, status }).returning({ id: schema.waConversations.id });
  return conversation.id;
}

let sequence = 0;
async function addMessage(conversationId: string, direction: "inbound" | "outbound", body: string, at?: Date): Promise<string> {
  sequence += 1;
  at ??= new Date(Date.now() - 60_000 + sequence * 1000);
  const [message] = await db
    .insert(schema.waMessages)
    .values({
      conversationId,
      direction,
      zapiMessageId: `MSG-${sequence}`,
      dedupeKey: direction === "outbound" ? `out:${sequence}` : null,
      body,
      status: "delivered",
      deliveredAt: at,
      createdAt: at,
    })
    .returning({ id: schema.waMessages.id });
  return message.id;
}

async function conversationStatus(conversationId: string): Promise<string> {
  const [row] = await db.select({ status: schema.waConversations.status }).from(schema.waConversations).where(eq(schema.waConversations.id, conversationId));
  return row.status;
}

const rateLimited = () =>
  new AssistantUnavailableError("Assistente de IA indisponível no momento", { status: 429, code: "rate_limit_error", retryable: true, reason: "limite de uso da API (429)" });
const noCredit = () =>
  new AssistantUnavailableError("Assistente de IA indisponível no momento", { status: 400, code: "invalid_request_error", retryable: false, reason: "sem crédito na API da Anthropic" });

describe("rajada de mensagens: um turno por mensagem, mas o modelo roda uma vez", () => {
  it("o segundo turno acha tudo respondido e não chama o modelo", async () => {
    const conversationId = await createConversation();
    await addMessage(conversationId, "inbound", "Oi");
    await addMessage(conversationId, "inbound", "Quero um vestido vermelho");
    assistant.enqueueScript({ replyTemplate: "Temos o Longo Dunas — quer ver as cores? 🤎" });

    const first = await runBotTurn(sdb, assistant, provider, { conversationId });
    expect(first).toEqual({ replied: true, handedOff: false });
    expect(provider.sentMessages).toHaveLength(1);

    // O evento da segunda mensagem chega depois: nada pendente.
    const second = await runBotTurn(sdb, assistant, provider, { conversationId });
    expect(second).toEqual({ skipped: "ja_respondida" });
    expect(assistant.inputs).toHaveLength(1);
    expect(provider.sentMessages).toHaveLength(1);
    expect(await conversationStatus(conversationId)).toBe("open");
  });

  it("saída automática depois da mensagem dela (template de pedido, cartão atrasado) NÃO conta como resposta", async () => {
    const conversationId = await createConversation();
    await addMessage(conversationId, "inbound", "Qual o prazo de entrega para Belém?");
    // O webhook do pagamento manda o template no mesmo minuto…
    await db.insert(schema.waMessages).values({
      conversationId,
      direction: "outbound",
      body: "Pagamento confirmado! 🤎",
      templateKey: "order_paid",
      dedupeKey: "order.paid:xyz",
      status: "sent",
      createdAt: new Date(Date.now() + 500),
    });
    // …e um cartão de um turno anterior chega atrasado.
    await db.insert(schema.waMessages).values({
      conversationId,
      direction: "outbound",
      kind: "image",
      body: "Cartão",
      mediaUrl: "https://cdn.test/cartao.png",
      dedupeKey: "wa.bot_media:00000000-0000-4000-8000-00000000aaaa:card",
      status: "sent",
      createdAt: new Date(Date.now() + 600),
    });
    assistant.enqueueScript({ replyTemplate: "Em Belém, motoboy no mesmo dia 🤎" });

    const result = await runBotTurn(sdb, assistant, provider, { conversationId });
    expect(result).toEqual({ replied: true, handedOff: false });
    expect(provider.sentMessages.map((m) => m.body)).toEqual(["Em Belém, motoboy no mesmo dia 🤎"]);
  });

  it("mensagem que chegou enquanto o modelo pensava: o turno seguinte responde a ela, com a resposta anterior no lugar certo (caso real de 19/09: a API recusa histórico que termina com a assistente)", async () => {
    const conversationId = await createConversation();
    const base = Date.now() - 60_000;
    const a = await addMessage(conversationId, "inbound", "Mercadinho camarada", new Date(base));
    const b = await addMessage(conversationId, "inbound", "9", new Date(base + 3_000));
    await addMessage(conversationId, "inbound", "Não precisa de nota", new Date(base + 13_000));
    // A resposta ao "9" saiu DEPOIS do "Não precisa de nota" (o modelo estava pensando quando ela chegou).
    await db.insert(schema.waMessages).values({
      conversationId,
      direction: "outbound",
      body: "Combinado, motoboy amanhã 9h–12h 🤎 Agora me confirma seu nome completo e o CPF?",
      dedupeKey: `wa.bot_reply:${b}`,
      status: "sent",
      createdAt: new Date(base + 14_000),
    });
    assistant.enqueueScript({ replyTemplate: "Sem problema, fica sem nota 🤎 Só o nome, então?" });

    const result = await runBotTurn(sdb, assistant, provider, { conversationId });
    expect(result).toEqual({ replied: true, handedOff: false });
    const history = assistant.inputs[0].history;
    const roles = history.slice(-4).map((m) => `${m.role}:${m.text.slice(0, 12)}`);
    expect(roles).toEqual(["user:Mercadinho c", "user:9", "assistant:Combinado, m", "user:Não precisa "]);
    expect(history.at(-1)?.role).toBe("user");
    expect(provider.sentMessages.map((m) => m.body)).toEqual(["Sem problema, fica sem nota 🤎 Só o nome, então?"]);
    void a;
  });

  it("aviso automático ou mensagem da equipe entram como contexto (papel de usuário), e depois da resposta da Lia não há o que responder", async () => {
    const conversationId = await createConversation();
    const base = Date.now() - 60_000;
    const a = await addMessage(conversationId, "inbound", "Quero um vestido", new Date(base));
    await db.insert(schema.waMessages).values([
      { conversationId, direction: "outbound", body: "Oi, aqui é o Fabiano", dedupeKey: "wa.send:manual-1", status: "sent", createdAt: new Date(base + 1_000) },
      { conversationId, direction: "outbound", body: "Temos o Longo Dunas 🤎", dedupeKey: `wa.bot_reply:${a}`, status: "sent", createdAt: new Date(base + 2_000) },
      { conversationId, direction: "outbound", body: "Seu pedido #1001 foi pago!", dedupeKey: "order.paid:1001", templateKey: "order_paid", status: "sent", createdAt: new Date(base + 3_000) },
    ]);
    // O evento de "Quero um vestido" chega atrasado: a Lia já respondeu; o template depois não é pergunta nova.
    expect(await runBotTurn(sdb, assistant, provider, { conversationId })).toEqual({ skipped: "ja_respondida" });
    expect(assistant.inputs).toHaveLength(0);

    // Ela volta a falar: a equipe e o aviso aparecem como contexto, nunca como fala da Lia.
    await addMessage(conversationId, "inbound", "Quero o M", new Date(base + 4_000));
    assistant.enqueueScript({ replyTemplate: "M separado 🤎" });
    expect(await runBotTurn(sdb, assistant, provider, { conversationId })).toEqual({ replied: true, handedOff: false });
    const history = assistant.inputs[0].history.slice(-5);
    expect(history.map((m) => m.role)).toEqual(["user", "assistant", "user", "user", "user"]);
    expect(history[0].text).toBe("Quero um vestido");
    expect(history[1].text).toBe("Temos o Longo Dunas 🤎");
    expect(history[2].text).toBe("[mensagem enviada pela equipe da loja, não por você] Oi, aqui é o Fabiano");
    expect(history[3].text).toBe("[aviso automático da loja] Seu pedido #1001 foi pago!");
    expect(history[4].text).toBe("Quero o M");
  });

  it.each([
    ["cartão de um turno antigo (wa.bot_media:<A>:card)", (a: string) => `wa.bot_media:${a}:card`, "image"],
    ["cortesia pós-transferência da 1ª mensagem (wa.bot_handoff_notice:<A>)", (a: string) => `wa.bot_handoff_notice:${a}`, "text"],
    ["retorno combinado que saiu enquanto ela escrevia (wa.bot_reply:followup:<id>)", () => "wa.bot_reply:followup:11111111-1111-4111-8111-111111111111", "text"],
  ])("saída da Lia sem responder à mensagem nova — %s: a conversa termina com a cliente e ela é respondida", async (_label, key, kind) => {
    const conversationId = await createConversation();
    const base = Date.now() - 60_000;
    const a = await addMessage(conversationId, "inbound", "Quero ver vestidos", new Date(base));
    await db.insert(schema.waMessages).values({ conversationId, direction: "outbound", body: "Mandei um cartão com as três 🤎", dedupeKey: `wa.bot_reply:${a}`, status: "sent", createdAt: new Date(base + 2_000) });
    await addMessage(conversationId, "inbound", "Quero o M", new Date(base + 3_000));
    await db.insert(schema.waMessages).values({ conversationId, direction: "outbound", kind, body: "[saída tardia]", dedupeKey: key(a), status: "sent", createdAt: new Date(base + 5_000) });
    assistant.enqueueScript({ replyTemplate: "M separado 🤎" });

    const result = await runBotTurn(sdb, assistant, provider, { conversationId });
    const history = assistant.inputs[0]?.history ?? [];
    expect(result).toEqual({ replied: true, handedOff: false });
    expect(history.at(-1)).toMatchObject({ role: "user", text: "Quero o M" });
    expect(history.at(-2)?.role).toBe("assistant");
  });

  it("copiloto: a sugestão aprovada responde à mensagem dela (âncora pela tabela de sugestões) — evento atrasado não roda o modelo; mensagem nova, sim", async () => {
    const conversationId = await createConversation();
    const base = Date.now() - 60_000;
    const a = await addMessage(conversationId, "inbound", "Quero ver vestidos", new Date(base));
    const [suggestion] = await db
      .insert(schema.waSuggestions)
      .values({ conversationId, inboundMessageId: a, bubbles: ["Temos o Longo Dunas"], status: "sent" })
      .returning({ id: schema.waSuggestions.id });
    await db.insert(schema.waMessages).values({ conversationId, direction: "outbound", body: "Temos o Longo Dunas", dedupeKey: `wa.bot_reply:suggestion:${suggestion.id}`, status: "sent", createdAt: new Date(base + 2_000) });
    expect(await runBotTurn(sdb, assistant, provider, { conversationId })).toEqual({ skipped: "ja_respondida" });
    expect(assistant.inputs).toHaveLength(0);

    await addMessage(conversationId, "inbound", "Quero o M", new Date(base + 4_000));
    assistant.enqueueScript({ replyTemplate: "M separado 🤎" });
    expect(await runBotTurn(sdb, assistant, provider, { conversationId })).toEqual({ replied: true, handedOff: false });
    const history = assistant.inputs[0].history.slice(-3);
    expect(history.map((m) => `${m.role}:${m.text}`)).toEqual(["user:Quero ver vestidos", "assistant:Temos o Longo Dunas", "user:Quero o M"]);
  });

  it("resposta manual da dona cobre só a mensagem que ela viu na tela: a que ficou presa na trava do turno (hora anterior ao clique) continua pendente", async () => {
    const conversationId = await createConversation();
    const base = Date.now() - 60_000;
    const a = await addMessage(conversationId, "inbound", "Oi, tem o vestido azul?", new Date(base));
    // B nasceu 5 s depois de A mas só ficou visível quando o turno de A soltou a trava; a dona respondeu A às +8 s sem ver B.
    await addMessage(conversationId, "inbound", "M, e quanto custa?", new Date(base + 5_000));
    await db.insert(schema.waMessages).values({ conversationId, direction: "outbound", body: "Tenho sim! Qual tamanho?", dedupeKey: `wa.send:evt-1:re:${a}`, status: "sent", createdAt: new Date(base + 8_000) });
    assistant.enqueueScript({ replyTemplate: "M por R$ 159 🤎" });

    expect(await runBotTurn(sdb, assistant, provider, { conversationId })).toEqual({ replied: true, handedOff: false });
    const history = assistant.inputs[0].history.slice(-3);
    expect(history.map((m) => `${m.role}:${m.text}`)).toEqual([
      "user:Oi, tem o vestido azul?",
      "user:[mensagem enviada pela equipe da loja, não por você] Tenho sim! Qual tamanho?",
      "user:M, e quanto custa?",
    ]);
  });

  it("mensagem nova depois da resposta volta a rodar o modelo", async () => {
    const conversationId = await createConversation();
    await addMessage(conversationId, "inbound", "Oi");
    await runBotTurn(sdb, assistant, provider, { conversationId });
    // Depois da resposta (que nasce com o relógio real).
    await addMessage(conversationId, "inbound", "Mostre as cores", new Date(Date.now() + 1000));
    const result = await runBotTurn(sdb, assistant, provider, { conversationId });
    expect(result).toEqual({ replied: true, handedOff: false });
    expect(assistant.inputs).toHaveLength(2);
  });
});

describe("✓✓ azul só quando a Lia vai responder agora", () => {
  it("texto enquanto um áudio dela ainda transcreve: turno espera a transcrição e NÃO marca como lida", async () => {
    const conversationId = await createConversation();
    await db.insert(schema.settings).values({ key: "bot_media_enabled", value: true }).onConflictDoNothing();
    await db.insert(schema.waMessages).values({
      conversationId,
      direction: "inbound",
      kind: "audio",
      zapiMessageId: "MSG-AUDIO",
      body: "[a cliente enviou um áudio]",
      mediaUrl: "https://cdn.test/audio.ogg",
      mediaMeta: { transcript: { status: "pending" } },
      status: "delivered",
      createdAt: new Date(Date.now() - 5_000),
    });
    await addMessage(conversationId, "inbound", "e no M tem?");
    const result = await runBotTurn(sdb, assistant, provider, { conversationId });
    expect(result).toEqual({ skipped: "aguardando_transcricao" });
    expect(provider.readReceipts).toEqual([]);
    expect(assistant.inputs).toHaveLength(0);
  });

  it("Z-API recusa o read-message: o turno segue e responde", async () => {
    const conversationId = await createConversation();
    await addMessage(conversationId, "inbound", "Oi");
    provider.setPhoneExists(PHONE, false); // paridade: /read-message 4xx (e phoneExists não é consultado no turno)
    assistant.enqueueScript({ replyTemplate: "Oi! 🤎" });
    const spy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const result = await runBotTurn(sdb, assistant, provider, { conversationId });
    expect(result).toEqual({ replied: true, handedOff: false });
    expect(provider.readReceipts).toEqual([]);
    expect(provider.sentMessages).toHaveLength(1);
    expect(spy).toHaveBeenCalledWith("[wa-bot] não marcou a mensagem como lida", expect.stringContaining("read-message"));
    spy.mockRestore();
  });
});

describe("modelo indisponível", () => {
  it("falha passageira (429) na primeira tentativa relança: nada sai, a fila tenta de novo", async () => {
    const conversationId = await createConversation();
    await addMessage(conversationId, "inbound", "Oi");
    assistant.enqueueScript(rateLimited());

    await expect(runBotTurn(sdb, assistant, provider, { conversationId, attempt: 0 })).rejects.toBeInstanceOf(AssistantUnavailableError);

    expect(provider.sentMessages).toHaveLength(0);
    expect(await conversationStatus(conversationId)).toBe("open");
    const audits = await db.select().from(schema.auditLog);
    expect(audits.filter((row) => row.action === "wa.bot_handoff" || row.action === "wa.bot_turn_failed")).toHaveLength(0);

    // A tentativa seguinte (modelo voltou) responde normalmente.
    assistant.enqueueScript({ replyTemplate: "Oi! Que bom te ver por aqui 🤎" });
    const result = await runBotTurn(sdb, assistant, provider, { conversationId, attempt: 1 });
    expect(result).toEqual({ replied: true, handedOff: false });
    expect(provider.sentMessages).toHaveLength(1);
  });

  it("na última tentativa vem o plano B, com a causa no motivo da transferência", async () => {
    const conversationId = await createConversation();
    await addMessage(conversationId, "inbound", "Oi");
    assistant.enqueueScript(rateLimited());
    const maxAttempts = BOT_TURN_MODEL_ATTEMPTS;
    expect(maxAttempts).toBeGreaterThanOrEqual(3);

    // A penúltima ainda relança…
    await expect(runBotTurn(sdb, assistant, provider, { conversationId, attempt: maxAttempts - 2 })).rejects.toBeInstanceOf(AssistantUnavailableError);
    assistant.enqueueScript(rateLimited());
    // …a última faz o plano B.
    const result = await runBotTurn(sdb, assistant, provider, { conversationId, attempt: maxAttempts - 1 });
    expect(result).toEqual({ replied: true, handedOff: true });

    expect(provider.sentMessages).toHaveLength(1);
    expect(provider.sentMessages[0].body).toBe(BOT_UNAVAILABLE_REPLY);
    expect(await conversationStatus(conversationId)).toBe("human");

    const audits = await db.select().from(schema.auditLog);
    const handoff = audits.find((row) => row.action === "wa.bot_handoff");
    expect(handoff?.reason).toBe("Assistente de IA indisponível (limite de uso da API (429))");
    const failed = audits.find((row) => row.action === "wa.bot_turn_failed");
    expect(failed?.after).toMatchObject({ attempt: maxAttempts, status: 429, code: "rate_limit_error", reason: "limite de uso da API (429)" });

    const [forward] = await db.select().from(schema.outboxEvents).where(eq(schema.outboxEvents.eventType, "wa.owner_forward"));
    expect(String((forward.payload as { body: string }).body)).toContain("limite de uso da API (429)");
  });

  it("falha que não melhora sozinha (sem crédito) faz o plano B na primeira tentativa", async () => {
    const conversationId = await createConversation();
    await addMessage(conversationId, "inbound", "Oi");
    assistant.enqueueScript(noCredit());

    const result = await runBotTurn(sdb, assistant, provider, { conversationId, attempt: 0 });
    expect(result).toEqual({ replied: true, handedOff: true });
    expect(await conversationStatus(conversationId)).toBe("human");
    const audits = await db.select().from(schema.auditLog);
    expect(audits.find((row) => row.action === "wa.bot_handoff")?.reason).toBe("Assistente de IA indisponível (sem crédito na API da Anthropic)");
  });

  it("'tempo esgotado' (prazo do turno) é passageiro: relança na primeira, plano B na última — e o audit da falha leva os tempos", async () => {
    const conversationId = await createConversation();
    await addMessage(conversationId, "inbound", "Oi");
    const timedOut = () =>
      new AssistantUnavailableError("Assistente de IA indisponível no momento (tempo esgotado)", { retryable: true, reason: "tempo esgotado" });
    assistant.enqueueScript(timedOut());
    await expect(runBotTurn(sdb, assistant, provider, { conversationId, attempt: 0 })).rejects.toBeInstanceOf(AssistantUnavailableError);
    expect(provider.sentMessages).toHaveLength(0);

    assistant.enqueueScript(timedOut());
    const result = await runBotTurn(sdb, assistant, provider, { conversationId, attempt: BOT_TURN_MODEL_ATTEMPTS - 1, enqueuedAt: new Date(Date.now() - 2_000) });
    expect(result).toEqual({ replied: true, handedOff: true });
    const audits = await db.select().from(schema.auditLog);
    expect(audits.find((row) => row.action === "wa.bot_handoff")?.reason).toBe("Assistente de IA indisponível (tempo esgotado)");
    const failed = audits.find((row) => row.action === "wa.bot_turn_failed")?.after as { timings: { queueWaitMs: number; modelMs: number; deliveryMs: null } };
    expect(failed.timings.queueWaitMs).toBeGreaterThanOrEqual(2_000);
    expect(failed.timings.modelMs).toBeGreaterThanOrEqual(0);
    expect(failed.timings.deliveryMs).toBeNull();
  });

  it("erro genérico (sem os campos) segue como antes: plano B com a mensagem", async () => {
    const conversationId = await createConversation();
    await addMessage(conversationId, "inbound", "Oi");
    assistant.enqueueScript(new AssistantUnavailableError("Assistente de IA não configurado — informe a ANTHROPIC_API_KEY"));
    const result = await runBotTurn(sdb, assistant, provider, { conversationId });
    expect(result).toEqual({ replied: true, handedOff: true });
    const audits = await db.select().from(schema.auditLog);
    expect(audits.find((row) => row.action === "wa.bot_handoff")?.reason).toContain("ANTHROPIC_API_KEY");
  });
});

describe("Devolver à Lia", () => {
  it("com mensagem dela esperando, enfileira o turno (dedupe pela mensagem)", async () => {
    const conversationId = await createConversation("human");
    await addMessage(conversationId, "outbound", BOT_UNAVAILABLE_REPLY);
    const inboundId = await addMessage(conversationId, "inbound", "Mostre as cores");

    const result = await returnWaConversationToBot(sdb, { conversationId, userId: OWNER });
    expect(result).toEqual({ status: "open", botTurnQueued: true });
    expect(await conversationStatus(conversationId)).toBe("open");

    const events = await db.select().from(schema.outboxEvents).where(eq(schema.outboxEvents.eventType, "wa.bot_turn"));
    expect(events).toHaveLength(1);
    expect(events[0].dedupeKey).toBe(`wa.bot_turn:return:${inboundId}`);
    expect(events[0].payload).toEqual({ conversationId });

    // Devolver de novo não duplica o turno — e diz que não enfileirou.
    await db.update(schema.waConversations).set({ status: "human" }).where(eq(schema.waConversations.id, conversationId));
    expect(await returnWaConversationToBot(sdb, { conversationId, userId: OWNER })).toEqual({ status: "open", botTurnQueued: false });
    expect(await db.select().from(schema.outboxEvents).where(eq(schema.outboxEvents.eventType, "wa.bot_turn"))).toHaveLength(1);
  });

  it("copiloto: sugestão aprovada respondeu à mensagem dela — Devolver à Lia não enfileira turno à toa", async () => {
    const conversationId = await createConversation("human");
    const base = Date.now() - 60_000;
    const a = await addMessage(conversationId, "inbound", "Tem em azul?", new Date(base));
    const [suggestion] = await db.insert(schema.waSuggestions).values({ conversationId, inboundMessageId: a, bubbles: ["Tem sim!"], status: "sent" }).returning({ id: schema.waSuggestions.id });
    await db.insert(schema.waMessages).values({ conversationId, direction: "outbound", body: "Tem sim!", dedupeKey: `wa.bot_reply:suggestion:${suggestion.id}`, status: "sent", createdAt: new Date(base + 2_000) });
    expect(await returnWaConversationToBot(sdb, { conversationId, userId: OWNER })).toEqual({ status: "open", botTurnQueued: false });
    expect(await db.select().from(schema.outboxEvents).where(eq(schema.outboxEvents.eventType, "wa.bot_turn"))).toHaveLength(0);
  });

  it("aviso automático depois da mensagem dela não conta como resposta: Devolver à Lia enfileira o turno mesmo assim", async () => {
    const conversationId = await createConversation("human");
    await addMessage(conversationId, "outbound", BOT_UNAVAILABLE_REPLY);
    const inboundId = await addMessage(conversationId, "inbound", "Mostre as cores");
    await db.insert(schema.waMessages).values({ conversationId, direction: "outbound", body: "Pagamento confirmado! 🤎", templateKey: "order_paid", dedupeKey: "order.paid:xyz", status: "sent", createdAt: new Date(Date.now() + 500) });
    expect(await returnWaConversationToBot(sdb, { conversationId, userId: OWNER })).toEqual({ status: "open", botTurnQueued: true });
    const events = await db.select().from(schema.outboxEvents).where(eq(schema.outboxEvents.eventType, "wa.bot_turn"));
    expect(events.map((e) => e.dedupeKey)).toEqual([`wa.bot_turn:return:${inboundId}`]);
  });

  it("SAIR esperando é comando, não pergunta: só reabre", async () => {
    const conversationId = await createConversation("human");
    await addMessage(conversationId, "inbound", " sair ");
    const result = await returnWaConversationToBot(sdb, { conversationId, userId: OWNER });
    expect(result).toEqual({ status: "open", botTurnQueued: false });
  });

  it("sem nada esperando (a equipe respondeu por último), só reabre", async () => {
    const conversationId = await createConversation("human");
    await addMessage(conversationId, "inbound", "Oi");
    await db.insert(schema.waMessages).values({ conversationId, direction: "outbound", body: "Oi, tudo bem?", dedupeKey: "wa.send:manual-1", status: "sent", createdAt: new Date() });
    const result = await returnWaConversationToBot(sdb, { conversationId, userId: OWNER });
    expect(result).toEqual({ status: "open", botTurnQueued: false });
    expect(await db.select().from(schema.outboxEvents).where(eq(schema.outboxEvents.eventType, "wa.bot_turn"))).toHaveLength(0);
  });
});
