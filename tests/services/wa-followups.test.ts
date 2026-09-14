// Retorno combinado ponta a ponta (PGlite + fakes): a Lia só agenda com o
// sim da cliente e dentro da janela; agendar de novo substitui; a dona
// cancela; no horário o turno proativo roda com os mesmos bloqueios do
// reativo (humano, fechada, SAIR, superada, fora da janela) e entrega com
// dedupe por retorno — o retry nunca manda duas vezes.
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeSalesAssistant } from "@/adapters/assistant/fake";
import { FakeMessagingProvider } from "@/adapters/zapi/fake";
import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { buildToolExecutor, runBotTurn, runScheduledBotTurn } from "@/services/wa-bot";
import { cancelBotFollowup, followupMemoryLines, listScheduledFollowups, scheduleBotFollowup } from "@/services/wa-followups";
import { createTestDb, type TestDb } from "../helpers/db";

const PHONE = "+5511999990000";
// Segunda 2026-09-14, 15:00 em SP.
const NOW = new Date("2026-09-14T18:00:00Z");
const DUE = new Date("2026-09-15T13:00:00Z"); // terça 10:00 SP

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
  ]);
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
async function addInbound(conversationId: string, body: string, at = new Date(NOW.getTime() - 60_000 + sequence * 1000)): Promise<string> {
  sequence += 1;
  const [message] = await db
    .insert(schema.waMessages)
    .values({ conversationId, direction: "inbound", zapiMessageId: `MSG-${sequence}-${Math.random().toString(36).slice(2, 8)}`, body, status: "delivered", deliveredAt: at, createdAt: at })
    .returning({ id: schema.waMessages.id });
  return message.id;
}

async function addOutbound(conversationId: string, body: string, at: Date): Promise<void> {
  await db.insert(schema.waMessages).values({ conversationId, direction: "outbound", body, status: "sent", dedupeKey: `wa.bot_reply:${Math.random().toString(36).slice(2, 10)}`, createdAt: at });
}

describe("agendar_retorno (executor)", () => {
  it("com o sim dela agenda dentro da janela, escreve no caderninho e enfileira o evento para o horário; agendar de novo substitui", async () => {
    const conversationId = await createConversation();
    await addInbound(conversationId, "vou pensar");
    await addOutbound(conversationId, "Posso te chamar amanhã às 10h?", new Date(NOW.getTime() - 30_000));
    const yes = await addInbound(conversationId, "pode sim");
    const executor = buildToolExecutor(sdb, { conversationId, phoneE164: PHONE, customerId: null, lastInboundId: yes, now: NOW });

    const result = await executor("agendar_retorno", { data: "2026-09-15", hora: "10:00", motivo: "ver se decidiu o Longo Dunas", cliente_autorizou: true });
    expect(result.ok).toBe(true);
    expect(result.text).toContain("Retorno combinado para terça-feira, 15 de setembro às 10:00");
    const scheduled = await listScheduledFollowups(sdb, conversationId);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]).toMatchObject({ kind: "customer", reason: "ver se decidiu o Longo Dunas", dueAt: DUE });
    const [row] = await db.select().from(schema.waFollowups);
    expect(row.consentWaMessageId).toBe(yes);
    const events = await db.select().from(schema.outboxEvents);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventType: "wa.bot_followup", dedupeKey: `wa.bot_followup:${row.id}` });
    expect(events[0].nextAttemptAt.getTime()).toBe(DUE.getTime());
    expect(await followupMemoryLines(sdb, conversationId)).toEqual([expect.stringContaining("Retorno combinado: você vai chamá-la em terça-feira, 15 de setembro às 10:00")]);

    // Ela muda o horário: o anterior é substituído (um agendado por conversa).
    const again = await executor("agendar_retorno", { data: "2026-09-15", hora: "07:00", motivo: "ver se decidiu", cliente_autorizou: true });
    expect(again.ok).toBe(true);
    expect(again.text).toContain("ajustado para a abertura, 9h");
    expect(again.text).toContain("substitui o combinado anterior");
    const after = await listScheduledFollowups(sdb, conversationId);
    expect(after).toHaveLength(1);
    expect(after[0].dueAt).toEqual(new Date("2026-09-15T12:00:00Z"));
    const [old] = await db.select().from(schema.waFollowups).where(eq(schema.waFollowups.id, row.id));
    expect(old).toMatchObject({ status: "canceled", canceledReason: "substituido" });
  });

  it("sem um sim claro recusa; horário no passado, perto ou longe recusa; dryRun não grava", async () => {
    const conversationId = await createConversation();
    const last = await addInbound(conversationId, "amanhã eu vejo");
    const executor = buildToolExecutor(sdb, { conversationId, phoneE164: PHONE, customerId: null, lastInboundId: last, now: NOW });
    const refused = await executor("agendar_retorno", { data: "2026-09-15", hora: "10:00", motivo: "ver se decidiu", cliente_autorizou: true });
    expect(refused.ok).toBe(false);
    expect(refused.text).toContain("não é um sim claro");
    expect(await db.select().from(schema.waFollowups)).toHaveLength(0);

    const yes = await addInbound(conversationId, "sim");
    const ok = buildToolExecutor(sdb, { conversationId, phoneE164: PHONE, customerId: null, lastInboundId: yes, now: NOW });
    expect((await ok("agendar_retorno", { data: "2026-09-14", hora: "14:00", motivo: "ver depois", cliente_autorizou: true })).text).toContain("já passou");
    expect((await ok("agendar_retorno", { data: "2026-09-14", hora: "15:10", motivo: "ver depois", cliente_autorizou: true })).text).toContain("Menos de 30 minutos");
    expect((await ok("agendar_retorno", { data: "2026-09-30", hora: "10:00", motivo: "ver depois", cliente_autorizou: true })).text).toContain("Mais de 7 dias");
    // cliente_autorizou=false não passa no schema.
    expect((await ok("agendar_retorno", { data: "2026-09-15", hora: "10:00", motivo: "ver depois", cliente_autorizou: false })).ok).toBe(false);
    const dry = buildToolExecutor(sdb, { conversationId, phoneE164: PHONE, customerId: null, lastInboundId: yes, now: NOW, dryRun: true });
    expect((await dry("agendar_retorno", { data: "2026-09-15", hora: "10:00", motivo: "ver depois", cliente_autorizou: true })).ok).toBe(true);
    expect(await db.select().from(schema.waFollowups)).toHaveLength(0);
  });
});

describe("runScheduledBotTurn (turno proativo)", () => {
  async function scheduled(opts: { conversationId?: string } = {}): Promise<{ conversationId: string; followupId: string }> {
    const conversationId = opts.conversationId ?? (await createConversation());
    await addInbound(conversationId, "vou pensar");
    await addOutbound(conversationId, "Posso te chamar amanhã às 10h?", new Date(NOW.getTime() - 30_000));
    const yes = await addInbound(conversationId, "pode sim", new Date(NOW.getTime() - 10_000));
    const { followupId } = await scheduleBotFollowup(sdb, { conversationId, phoneE164: PHONE, customerId: null, kind: "customer", reason: "ver se decidiu o Longo Dunas", dueAt: DUE, consentWaMessageId: yes, requestedBy: "lia", now: NOW });
    return { conversationId, followupId };
  }

  it("no horário a Lia chama por conta, com a fala sintética no fim do histórico; o retry não manda de novo; o histórico marca 'você chamou como combinado'", async () => {
    const { conversationId, followupId } = await scheduled();
    assistant.enqueueScript({ replyTemplate: "Oi! Passando como combinamos — decidiu sobre o Longo Dunas? 🤎" });
    const result = await runScheduledBotTurn(sdb, assistant, provider, { followupId, now: DUE });
    expect(result).toEqual({ sent: true, followupId, replied: true });
    expect(provider.sentMessages).toHaveLength(1);
    expect(provider.sentMessages[0].body).toContain("Passando como combinamos");
    const input = assistant.inputs[0];
    expect(input.history.at(-1)).toMatchObject({ role: "user", text: expect.stringContaining("[retorno combinado: ela pediu que você a chamasse") });
    expect(input.history[0].text).toContain("Retorno combinado: você vai chamá-la");
    const [row] = await db.select().from(schema.waFollowups).where(eq(schema.waFollowups.id, followupId));
    expect(row.status).toBe("sent");
    expect(row.sentWaMessageId).not.toBeNull();
    const outbound = await db.select().from(schema.waMessages).where(eq(schema.waMessages.id, row.sentWaMessageId as string));
    expect(outbound[0].dedupeKey).toBe(`wa.bot_reply:followup:${followupId}`);

    // Retry da fila: status já 'sent' → nada sai.
    assistant.enqueueScript({ replyTemplate: "de novo?" });
    expect(await runScheduledBotTurn(sdb, assistant, provider, { followupId, now: DUE })).toEqual({ skipped: "status_sent", followupId });
    expect(provider.sentMessages).toHaveLength(1);

    // A próxima conversa dela: a mensagem proativa entra no histórico marcada.
    await addInbound(conversationId, "decidi, quero o M", new Date(DUE.getTime() + 3_600_000));
    assistant.enqueueScript({ replyTemplate: "Que bom!" });
    await runBotTurn(sdb, assistant, provider, { conversationId });
    const next = assistant.inputs.at(-1)!;
    expect(next.history.some((message) => message.role === "assistant" && message.text.startsWith("[você chamou como combinado] "))).toBe(true);
    // Sem retorno agendado, o caderninho não fala nele.
    expect(next.history[0].text).not.toContain("Retorno combinado:");
  });

  it("cancelado pela dona, conversa com a equipe, SAIR e 'ela já voltou' não chamam; fora da janela re-enfileira datado", async () => {
    const owner = await scheduled();
    const [user] = await db.insert(schema.users).values({ id: "00000000-0000-4000-8000-00000000d0a0", email: "dona@trive.test", role: "owner", fullName: "Dona" }).returning({ id: schema.users.id });
    expect(await cancelBotFollowup(sdb, { followupId: owner.followupId, reason: "dono", userId: user.id })).toEqual({ canceled: true });
    expect(await cancelBotFollowup(sdb, { followupId: owner.followupId, reason: "dono", userId: user.id })).toEqual({ canceled: false });
    expect(await runScheduledBotTurn(sdb, assistant, provider, { followupId: owner.followupId, now: DUE })).toEqual({ skipped: "status_canceled", followupId: owner.followupId });
    expect(await listScheduledFollowups(sdb, owner.conversationId)).toEqual([]);

    const human = await scheduled({ conversationId: await createConversation("+5511888880000") });
    await db.update(schema.waConversations).set({ status: "human" }).where(eq(schema.waConversations.id, human.conversationId));
    expect(await runScheduledBotTurn(sdb, assistant, provider, { followupId: human.followupId, now: DUE })).toEqual({ skipped: "conversa_humana", followupId: human.followupId });
    expect((await db.select().from(schema.waFollowups).where(eq(schema.waFollowups.id, human.followupId)))[0]).toMatchObject({ status: "canceled", canceledReason: "conversa_humana" });

    const sair = await scheduled({ conversationId: await createConversation("+5511777770000") });
    await db.insert(schema.customers).values({ fullName: "Bia", phoneE164: "+5511777770000", marketingOptIn: false });
    expect(await runScheduledBotTurn(sdb, assistant, provider, { followupId: sair.followupId, now: DUE })).toEqual({ skipped: "sair", followupId: sair.followupId });

    const back = await scheduled({ conversationId: await createConversation("+5511666660000") });
    await addInbound(back.conversationId, "oi, voltei — quero o M", new Date(NOW.getTime() + 3_600_000));
    expect(await runScheduledBotTurn(sdb, assistant, provider, { followupId: back.followupId, now: DUE })).toEqual({ skipped: "superada", followupId: back.followupId });
    expect((await db.select().from(schema.waFollowups).where(eq(schema.waFollowups.id, back.followupId)))[0].status).toBe("superseded");

    const late = await scheduled({ conversationId: await createConversation("+5511555550000") });
    const night = new Date("2026-09-15T02:00:00Z"); // 23:00 SP da véspera
    expect(await runScheduledBotTurn(sdb, assistant, provider, { followupId: late.followupId, now: night })).toEqual({ skipped: "fora_da_janela", followupId: late.followupId });
    const deferred = (await db.select().from(schema.outboxEvents)).find((event) => event.dedupeKey === `wa.bot_followup:${late.followupId}:2026-09-14`);
    expect(deferred?.nextAttemptAt).toEqual(new Date("2026-09-15T12:00:00Z"));
    expect((await db.select().from(schema.waFollowups).where(eq(schema.waFollowups.id, late.followupId)))[0].status).toBe("scheduled");
    expect(provider.sentMessages).toHaveLength(0);
  });

  it("a Lia sem resposta no turno proativo: 'sem_resposta' e nada sai", async () => {
    const { followupId } = await scheduled();
    assistant.enqueueScript({ replyTemplate: () => "" });
    expect(await runScheduledBotTurn(sdb, assistant, provider, { followupId, now: DUE })).toEqual({ skipped: "sem_resposta", followupId });
    expect(provider.sentMessages).toHaveLength(0);
  });
});
