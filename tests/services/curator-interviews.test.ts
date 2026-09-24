// Entrevista da curadora de ponta a ponta: a pergunta do dia sai com a peça,
// o áudio da dona passa pela transcrição e vira rascunho, e o "ok voz" grava
// a nota e o áudio na peça. Texto solto dela continua indo à Lia; lote de
// fotos do Ateliê aberto ganha da entrevista.
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeSalesAssistant } from "@/adapters/assistant/fake";
import { FakeFileStorage } from "@/adapters/storage/fake";
import { FakeTranscriber } from "@/adapters/transcription/fake";
import { FakeMessagingProvider } from "@/adapters/zapi/fake";
import * as schema from "@/db/schema";
import { initialWaTemplates } from "@/db/seed-data";
import type { DbOrTx } from "@/queue/enqueue";
import {
  askCuratorInterview,
  decideCuratorInterview,
  draftCuratorInterview,
  enqueueCuratorInterviewAsk,
  interviewProblems,
  requestCuratorInterviewNow,
} from "@/services/curator-interviews";
import { processZapiInbound } from "@/services/wa-inbound";
import { transcribeInboundAudio } from "@/services/wa-transcribe";
import { createTestDb, createTestVariant, type TestDb } from "../helpers/db";

const SECRET = "segredo-webhook-zapi";
const OWNER_ZAPI = "5591981037536";

let db: TestDb;
let sdb: DbOrTx;
let close: () => Promise<void>;
let provider: FakeMessagingProvider;
let storage: FakeFileStorage;
const originalSecret = process.env.ZAPI_WEBHOOK_SECRET;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  sdb = db as unknown as DbOrTx;
  provider = new FakeMessagingProvider();
  storage = new FakeFileStorage();
  process.env.ZAPI_WEBHOOK_SECRET = SECRET;
  delete process.env.ZAPI_CLIENT_TOKEN;
  vi.stubEnv("ADAPTER_MODE", "fake");
  await db.insert(schema.settings).values([
    { key: "wa_enabled", value: true },
    { key: "bot_enabled", value: true },
    { key: "owner_whatsapp_phone", value: "(91) 98103-7536" },
    { key: "curator_interview_enabled", value: true },
    { key: "curator_interview_hour", value: 10 },
  ]);
  await db.insert(schema.waTemplates).values(
    initialWaTemplates
      .filter((template) => template.key.startsWith("owner_interview_") || template.key.startsWith("owner_atelier_"))
      .map((template) => ({ key: template.key, label: template.label, bodyTemplate: template.bodyTemplate, variables: template.variables })),
  );
});

afterEach(async () => {
  await close();
  vi.unstubAllEnvs();
  if (originalSecret === undefined) delete process.env.ZAPI_WEBHOOK_SECRET;
  else process.env.ZAPI_WEBHOOK_SECRET = originalSecret;
});

function base(messageId: string) {
  return { type: "ReceivedCallback", instanceId: "x", messageId, phone: OWNER_ZAPI, fromMe: false, isGroup: false, senderName: "Dona", momment: Date.now(), status: "RECEIVED" };
}
const send = (body: unknown) => processZapiInbound(sdb, { providedSecret: SECRET, body });
const text = (id: string, message: string) => send({ ...base(id), text: { message } });
const audio = (id: string, seconds = 12) => send({ ...base(id), audio: { audioUrl: `https://cdn/${id}.ogg`, mimeType: "audio/ogg", seconds } });

async function interviews() {
  return db.select().from(schema.curatorInterviews);
}
async function outboxTypes() {
  return (await db.select().from(schema.outboxEvents)).map((event) => event.eventType);
}
async function outboxOf(type: string) {
  return (await db.select().from(schema.outboxEvents)).filter((event) => event.eventType === type);
}
function lastBodies(): string[] {
  return [...provider.sentMessages.map((message) => message.body), ...provider.sentImages.map((image) => image.caption ?? "")];
}

async function askToday(): Promise<{ productId: string }> {
  const { productId } = await createTestVariant(db, { sku: "DUNAS-M", name: "Longo Dunas" });
  const result = await askCuratorInterview(sdb, provider, { askKey: "2026-10-05" });
  expect(result).toMatchObject({ asked: true, productId });
  return { productId };
}

async function transcribe(zapiId: string, speech: string | Error) {
  const transcriber = new FakeTranscriber();
  if (speech instanceof Error) {
    transcriber.failNext();
    transcriber.failNext();
    transcriber.failNext();
  } else {
    transcriber.enqueueText(speech);
  }
  const media = new FakeMessagingProvider();
  media.setMediaFixture(`https://cdn/${zapiId}.ogg`, Buffer.from("OggS fake"), "audio/ogg");
  const [message] = await db.select().from(schema.waMessages).where(eq(schema.waMessages.zapiMessageId, zapiId));
  return transcribeInboundAudio(sdb, media, transcriber, { waMessageId: message.id, attempt: speech instanceof Error ? 2 : 0 });
}

describe("a pergunta do dia", () => {
  it("o cron só enfileira na hora escolhida (São Paulo), uma vez por dia", async () => {
    expect(await enqueueCuratorInterviewAsk(sdb, new Date("2026-10-05T14:05:00Z"))).toEqual({ enqueued: false, reason: "fora_da_hora" });
    expect(await enqueueCuratorInterviewAsk(sdb, new Date("2026-10-05T13:05:00Z"))).toEqual({ enqueued: true });
    expect(await enqueueCuratorInterviewAsk(sdb, new Date("2026-10-05T13:35:00Z"))).toEqual({ enqueued: false });
    // Sábado sem o sim da dona: nada.
    expect(await enqueueCuratorInterviewAsk(sdb, new Date("2026-10-10T13:05:00Z"))).toEqual({ enqueued: false, reason: "fora_da_hora" });
  });

  it("desligada: nem o cron nem o handler perguntam", async () => {
    await db.update(schema.settings).set({ value: false }).where(eq(schema.settings.key, "curator_interview_enabled"));
    expect(await enqueueCuratorInterviewAsk(sdb, new Date("2026-10-05T13:05:00Z"))).toEqual({ enqueued: false, reason: "desligado" });
    await createTestVariant(db, { name: "Longo Dunas" });
    expect(await askCuratorInterview(sdb, provider, { askKey: "2026-10-05" })).toEqual({ skipped: "desligado" });
  });

  it("manda a pergunta com o nome da peça; reentrega não duplica; outra pergunta espera a aberta", async () => {
    await askToday();
    expect(provider.sentMessages).toHaveLength(1);
    expect(provider.sentMessages[0].body).toContain("Por que você escolheu trazer a peça Longo Dunas para a loja?");
    expect(provider.sentMessages[0].body).toContain("*pula*");
    await askCuratorInterview(sdb, provider, { askKey: "2026-10-05" });
    expect(provider.sentMessages).toHaveLength(1);
    expect(await askCuratorInterview(sdb, provider, { askKey: "2026-10-06" })).toEqual({ skipped: "aberta" });
  });

  it("\"Perguntar agora\" recusa com pergunta aberta e diz o que falta", async () => {
    const [user] = await db.insert(schema.users).values({ id: "0518420b-c0fd-488a-9eb5-90b1e3bedcd4", email: "dona@trive.test", fullName: "Dona", role: "owner" }).returning();
    expect(await requestCuratorInterviewNow(sdb, { userId: user.id })).toEqual({ ok: false, reason: "nada_a_perguntar" });
    await askToday();
    expect(await requestCuratorInterviewNow(sdb, { userId: user.id })).toEqual({ ok: false, reason: "aberta" });
  });

  it("sem as mensagens da entrevista, não pergunta nem gasta a peça", async () => {
    await db.delete(schema.waTemplates).where(eq(schema.waTemplates.key, "owner_interview_saved"));
    await createTestVariant(db, { name: "Longo Dunas" });
    expect(await askCuratorInterview(sdb, provider, { askKey: "2026-10-05" })).toEqual({ skipped: "sem_template" });
    expect(await interviews()).toHaveLength(0);
    expect(await interviewProblems(sdb)).toContain("sem_template");
  });

  it("sem telefone da dona, a entrevista vira 'não saiu' e não segura a próxima", async () => {
    await db.delete(schema.settings).where(eq(schema.settings.key, "owner_whatsapp_phone"));
    await createTestVariant(db, { name: "Longo Dunas" });
    expect(await askCuratorInterview(sdb, provider, { askKey: "2026-10-05" })).toEqual({ skipped: "sem_telefone_dono" });
    expect((await interviews())[0].status).toBe("failed");
  });
});

async function draftNow(assistant = new FakeSalesAssistant()) {
  const events = await outboxOf("curator.interview_draft");
  const latest = events.sort((a, b) => Number((b.payload as { answerCount: number }).answerCount) - Number((a.payload as { answerCount: number }).answerCount))[0];
  return { result: await draftCuratorInterview(sdb, provider, assistant, latest.payload as { interviewId: string; answerCount: number }), assistant };
}

async function decideLast() {
  const events = await outboxOf("curator.interview_decide");
  const last = events.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[events.length - 1];
  return { payload: last.payload as never, result: await decideCuratorInterview(sdb, provider, storage, last.payload as never) };
}

describe("a resposta da dona", () => {
  it("um áudio → transcrição → rascunho → \"ok voz\": nota e áudio na peça, página revalidada", async () => {
    const { productId } = await askToday();
    expect((await audio("MSG-A1")).action).toBe("transcribe_queued");
    expect((await interviews())[0].pendingAnswerIds).toHaveLength(1);

    expect(await transcribe("MSG-A1", "trouxe porque é fresquinho, perfeito pro almoço do Círio")).toMatchObject({ route: "interview_answer" });
    const [drafting] = await interviews();
    expect(drafting).toMatchObject({ status: "drafting", answerCount: 1, pendingAnswerIds: [], transcript: "trouxe porque é fresquinho, perfeito pro almoço do Círio" });

    const { result, assistant } = await draftNow();
    expect(result).toEqual({ sent: true, usedModel: true });
    expect(assistant.extractions[0].system).toContain("Longo Dunas");
    expect(assistant.extractions[0].maxTokens).toBe(3000);
    expect(lastBodies().some((body) => body.includes("*Nota da curadora*") && body.includes("fresquinho") && body.includes("inteiro como você mandou"))).toBe(true);

    expect((await text("MSG-OK", "ok voz")).action).toBe("interview_queued");
    provider.setMediaFixture("https://cdn/MSG-A1.ogg", Buffer.from("OggS voz"), "audio/ogg");
    const { payload, result: decided } = await decideLast();
    expect(decided).toEqual({ done: "aprovada", voice: "salva" });

    const [product] = await db.select().from(schema.products).where(eq(schema.products.id, productId));
    expect(product.curatorNote).toBe("trouxe porque é fresquinho, perfeito pro almoço do Círio");
    expect(product.curatorAudioPath).toMatch(/\.ogg$/);
    expect((await interviews())[0]).toMatchObject({ status: "approved", decidedByMessage: expect.any(String) });
    expect((await outboxOf("store.revalidate")).map((event) => event.payload)).toEqual([{ paths: ["/produto/dunas-m"] }]);
    const confirmations = lastBodies().filter((body) => body.includes("✅ Nota salva em Longo Dunas") && body.includes("voz da curadora"));
    expect(confirmations).toHaveLength(1);

    // Retry da decisão (a confirmação podia ter falhado): reenvia, sem duplicar nem mexer na peça.
    expect(await decideCuratorInterview(sdb, provider, storage, payload)).toEqual({ done: "aprovada" });
    expect(lastBodies().filter((body) => body.includes("✅ Nota salva em Longo Dunas"))).toHaveLength(1);
  });

  it("dois áudios seguidos: somam na mesma fala, o rascunho espera o segundo e a voz não sai de um só", async () => {
    const { productId } = await askToday();
    await audio("MSG-A1");
    await audio("MSG-A2");
    expect((await interviews())[0].pendingAnswerIds).toHaveLength(2);

    await transcribe("MSG-A1", "trouxe porque é fresca");
    expect((await draftNow()).result).toEqual({ skipped: "esperando_audio" });

    await transcribe("MSG-A2", "e combina com rasteirinha");
    const [row] = await interviews();
    expect(row).toMatchObject({ answerCount: 2, pendingAnswerIds: [], transcript: "trouxe porque é fresca\ne combina com rasteirinha" });
    expect((await draftNow()).result).toEqual({ sent: true, usedModel: true });

    await text("MSG-OK", "ok voz");
    expect((await decideLast()).result).toEqual({ done: "aprovada", voice: "varios" });
    const [product] = await db.select().from(schema.products).where(eq(schema.products.id, productId));
    expect(product.curatorNote).toBe("trouxe porque é fresca\ne combina com rasteirinha");
    expect(product.curatorAudioPath).toBeNull();
  });

  it("áudio chegando enquanto o rascunho é escrito também soma (não vai para o Ateliê)", async () => {
    await askToday();
    await audio("MSG-A1");
    await transcribe("MSG-A1", "é de linho");
    expect((await audio("MSG-A2")).action).toBe("transcribe_queued");
    expect(await transcribe("MSG-A2", "e não amassa")).toMatchObject({ route: "interview_answer" });
    expect((await interviews())[0]).toMatchObject({ answerCount: 2 });
    expect(await outboxOf("wa.atelier_help")).toHaveLength(0);
  });

  it("\"resposta:\" por texto, \"corrige:\" reescreve, \"nova:\" salva do jeito dela e repete o texto", async () => {
    const { productId } = await askToday();
    expect((await text("MSG-T1", "Resposta: é linho, super fresco")).action).toBe("interview_queued");
    await draftNow();
    expect((await text("MSG-C1", "corrige: é linho puro")).action).toBe("interview_queued");
    expect((await interviews())[0]).toMatchObject({ status: "drafting", answerCount: 2 });
    expect((await interviews())[0].transcript).toContain("Correção da dona para o rascunho: é linho puro");
    await draftNow();
    await text("MSG-N1", "nova: Linho puro — a peça mais fresca da edição.");
    expect((await decideLast()).result).toEqual({ done: "nova" });
    const [product] = await db.select().from(schema.products).where(eq(schema.products.id, productId));
    expect(product.curatorNote).toBe("Linho puro — a peça mais fresca da edição.");
    expect(lastBodies().some((body) => body.includes('Salvei do jeito que você escreveu: "Linho puro — a peça mais fresca da edição."'))).toBe(true);
  });

  it("\"ok voz\" numa resposta escrita guarda só o texto e diz por quê", async () => {
    await askToday();
    await text("MSG-T1", "resposta: trouxe pela cor");
    await draftNow();
    await text("MSG-OK", "ok voz");
    expect((await decideLast()).result).toEqual({ done: "aprovada", voice: "escrito" });
    expect(lastBodies().some((body) => body.includes("A resposta foi escrita"))).toBe(true);
  });

  it("\"pula\" fecha a entrevista sem mexer na peça", async () => {
    await askToday();
    await text("MSG-P", "pula");
    expect((await decideLast()).result).toEqual({ done: "pulada" });
    expect((await interviews())[0].status).toBe("skipped");
  });

  it("áudio que não deu para ouvir: sai dos pendentes, a dona recebe o aviso e a pergunta segue aberta", async () => {
    await askToday();
    await audio("MSG-A2");
    expect(await transcribe("MSG-A2", new Error("fora"))).toMatchObject({ route: "interview_answer" });
    expect((await decideLast()).result).toEqual({ done: "avisada" });
    expect((await interviews())[0]).toMatchObject({ status: "asked", pendingAnswerIds: [] });
    expect(lastBodies().some((body) => body.includes("Não consegui ouvir"))).toBe(true);
  });

  it("\"sim\", \"pode\" e texto solto da dona continuam indo à Lia (ela testa como cliente)", async () => {
    await askToday();
    await text("MSG-T1", "resposta: é fresca");
    await draftNow();
    for (const [id, body] of [["MSG-S", "sim"], ["MSG-P2", "pode"], ["MSG-Q", "tem esse vestido no M?"]]) {
      expect((await text(id, body)).action).toBe("bot_queued");
    }
    expect(await outboxOf("curator.interview_decide")).toHaveLength(0);
    expect((await interviews())[0].status).toBe("draft_sent");
  });

  it("lote de fotos do Ateliê aberto ganha: o áudio é recado da peça nova", async () => {
    await askToday();
    await send({ ...base("MSG-F1"), image: { imageUrl: "https://cdn/MSG-F1.jpg", mimeType: "image/jpeg" } });
    expect((await audio("MSG-A3")).action).toBe("transcribe_queued");
    expect((await interviews())[0].pendingAnswerIds).toEqual([]);
    expect(await transcribe("MSG-A3", "chegou o cropped canelado")).toMatchObject({ route: "atelier_queued" });
    expect((await interviews())[0].status).toBe("asked");
  });

  it("entrevista vencida (mais de 14 h): o áudio volta ao caminho de sempre e o painel mostra sem resposta", async () => {
    await askToday();
    await db.update(schema.curatorInterviews).set({ askedAt: new Date(Date.now() - 15 * 3600_000) });
    await audio("MSG-A4");
    expect((await interviews())[0].pendingAnswerIds).toEqual([]);
    expect(await outboxTypes()).not.toContain("curator.interview_draft");
  });
});

describe("segunda rodada da revisão", () => {
  it("o áudio que não deu para ouvir destrava o rascunho do que já foi ouvido (mesmo depois de o rascunho ter esperado por ele)", async () => {
    await askToday();
    await audio("MSG-A1");
    await audio("MSG-A2");
    await transcribe("MSG-A1", "é de linho");
    expect((await draftNow()).result).toEqual({ skipped: "esperando_audio" });
    await transcribe("MSG-A2", new Error("fora"));
    const drafts = (await outboxOf("curator.interview_draft")).filter((event) => event.status !== "done");
    expect(drafts.length).toBeGreaterThan(0);
    const pending = drafts[drafts.length - 1];
    expect(await draftCuratorInterview(sdb, provider, new FakeSalesAssistant(), pending.payload as never)).toEqual({ sent: true, usedModel: true });
  });

  it("\"ok\" sobre o rascunho que ela tem na mão vale mesmo com um áudio novo sendo somado", async () => {
    const { productId } = await askToday();
    await text("MSG-T1", "resposta: é fresca");
    await draftNow();
    await audio("MSG-A5");
    await transcribe("MSG-A5", "e não amassa");
    expect((await interviews())[0].status).toBe("drafting");
    expect((await text("MSG-OK", "ok")).action).toBe("interview_queued");
    expect((await decideLast()).result).toEqual({ done: "aprovada" });
    const [product] = await db.select().from(schema.products).where(eq(schema.products.id, productId));
    expect(product.curatorNote).toBe("é fresca");
    expect((await draftNow()).result).toEqual({ skipped: "ja_decidida" });
  });

  it("Z-API fora na última tentativa: a pergunta vira 'não saiu' e não captura os áudios dela", async () => {
    await createTestVariant(db, { sku: "DUNAS-M", name: "Longo Dunas" });
    provider.simulateDisconnect();
    await expect(askCuratorInterview(sdb, provider, { askKey: "2026-10-05", attempt: 3 })).rejects.toThrow();
    expect((await interviews())[0].status).toBe("failed");
  });

  it("o reenvio da confirmação repete a linha da voz", async () => {
    await askToday();
    await audio("MSG-A1");
    await audio("MSG-A2");
    await transcribe("MSG-A1", "é de linho");
    await transcribe("MSG-A2", "e não amassa");
    await draftNow();
    expect(lastBodies().some((body) => body.includes("guarda só o texto"))).toBe(true);
    await text("MSG-OK", "ok voz");
    const { payload } = await decideLast();
    const before = lastBodies().find((body) => body.includes("✅ Nota salva"));
    expect(before).toContain("mais de um áudio");
    await decideCuratorInterview(sdb, provider, storage, payload);
    const after = lastBodies().filter((body) => body.includes("✅ Nota salva"));
    expect(after).toHaveLength(1);
    expect(after[0]).toContain("mais de um áudio");
  });

  it("um áudio + correção: \"ok voz\" guarda só o texto e explica o motivo certo", async () => {
    await askToday();
    await audio("MSG-A1");
    await transcribe("MSG-A1", "é de viscose");
    await draftNow();
    await text("MSG-C1", "corrige: é linho");
    await draftNow();
    await text("MSG-OK", "ok voz");
    expect((await decideLast()).result).toEqual({ done: "aprovada", voice: "misto" });
    expect(lastBodies().some((body) => body.includes("uma parte escrita ou uma correção"))).toBe(true);
  });

  it("\"pula\" antes de a transcrição voltar: o áudio segue o caminho de sempre, não some", async () => {
    await askToday();
    await audio("MSG-A1");
    await text("MSG-P", "pula");
    await decideLast();
    expect(await transcribe("MSG-A1", "chegou o cropped novo")).not.toMatchObject({ route: "interview_answer" });
    expect((await interviews())[0].pendingAnswerIds).toEqual([]);
  });

  it("resposta que só fala de preço: a dona recebe o porquê, não o silêncio", async () => {
    await askToday();
    await text("MSG-T1", "resposta: custa 89 reais.");
    const assistant = new FakeSalesAssistant();
    assistant.enqueueExtraction(new Error("fora do ar"));
    expect((await draftNow(assistant)).result).toEqual({ skipped: "sem_fala" });
    expect((await interviews())[0].status).toBe("failed");
    expect(lastBodies().some((body) => body.includes("a resposta falava só de preço"))).toBe(true);
  });
});
