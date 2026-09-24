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
    expect(provider.sentMessages[0].body).toContain("Por que você escolheu trazer Longo Dunas para a loja?");
    expect(provider.sentMessages[0].body).toContain("*pula*");
    await askCuratorInterview(sdb, provider, { askKey: "2026-10-05" });
    expect(provider.sentMessages).toHaveLength(1);
    expect(await askCuratorInterview(sdb, provider, { askKey: "2026-10-06" })).toEqual({ skipped: "aberta" });
  });

  it("\"Perguntar agora\" recusa com pergunta aberta", async () => {
    await askToday();
    const [user] = await db.insert(schema.users).values({ id: "0518420b-c0fd-488a-9eb5-90b1e3bedcd4", email: "dona@trive.test", fullName: "Dona", role: "owner" }).returning();
    expect(await requestCuratorInterviewNow(sdb, { userId: user.id })).toEqual({ ok: false, reason: "aberta" });
  });

  it("sem telefone da dona, a entrevista vira 'não saiu' e não segura a próxima", async () => {
    await db.delete(schema.settings).where(eq(schema.settings.key, "owner_whatsapp_phone"));
    await createTestVariant(db, { name: "Longo Dunas" });
    expect(await askCuratorInterview(sdb, provider, { askKey: "2026-10-05" })).toEqual({ skipped: "sem_telefone_dono" });
    expect((await interviews())[0].status).toBe("failed");
  });
});

describe("a resposta da dona", () => {
  it("áudio → transcrição → rascunho → \"ok voz\": nota e áudio na peça", async () => {
    const { productId } = await askToday();
    expect((await audio("MSG-A1")).action).toBe("transcribe_queued");
    expect((await interviews())[0].answerWaMessageId).not.toBeNull();

    expect(await transcribe("MSG-A1", "trouxe porque é fresquinho, perfeito pro almoço do Círio")).toMatchObject({ route: "interview_answer" });
    const [drafting] = await interviews();
    expect(drafting).toMatchObject({ status: "drafting", transcript: "trouxe porque é fresquinho, perfeito pro almoço do Círio" });
    const [draftEvent] = await outboxOf("curator.interview_draft");
    expect(draftEvent).toBeDefined();

    const assistant = new FakeSalesAssistant();
    expect(await draftCuratorInterview(sdb, provider, assistant, draftEvent.payload as { interviewId: string; answerKey: string })).toEqual({
      sent: true,
      usedModel: true,
    });
    expect(assistant.extractions[0].system).toContain("Longo Dunas");
    expect(lastBodies().some((body) => body.includes("*Nota da curadora*") && body.includes("fresquinho") && body.includes("*Legendas*"))).toBe(true);
    expect((await interviews())[0].status).toBe("draft_sent");

    expect((await text("MSG-OK", "ok voz")).action).toBe("interview_queued");
    const [decide] = await outboxOf("curator.interview_decide");
    provider.setMediaFixture("https://cdn/MSG-A1.ogg", Buffer.from("OggS voz"), "audio/ogg");
    expect(await decideCuratorInterview(sdb, provider, storage, decide.payload as never)).toEqual({ done: "aprovada", voice: "salva" });

    const [product] = await db.select().from(schema.products).where(eq(schema.products.id, productId));
    expect(product.curatorNote).toBe("trouxe porque é fresquinho, perfeito pro almoço do Círio");
    expect(product.curatorAudioPath).toMatch(/\.ogg$/);
    expect(product.curatorAudioMime).toBe("audio/ogg");
    expect((await interviews())[0].status).toBe("approved");
    expect(lastBodies().some((body) => body.includes("✅ Nota salva em Longo Dunas") && body.includes("voz da curadora"))).toBe(true);

    // Reentrega da decisão: nada muda.
    expect(await decideCuratorInterview(sdb, provider, storage, decide.payload as never)).toEqual({ skipped: "ja_decidida" });
  });

  it("\"resposta:\" por texto, depois \"corrige:\": a nota é a dela, sem áudio", async () => {
    const { productId } = await askToday();
    expect((await text("MSG-T1", "Resposta: é linho, super fresco")).action).toBe("interview_queued");
    const [draftEvent] = await outboxOf("curator.interview_draft");
    await draftCuratorInterview(sdb, provider, new FakeSalesAssistant(), draftEvent.payload as never);
    await text("MSG-C1", "corrige: Linho puro — a peça mais fresca da edição.");
    const [decide] = await outboxOf("curator.interview_decide");
    expect(await decideCuratorInterview(sdb, provider, storage, decide.payload as never)).toEqual({ done: "corrigida" });
    const [product] = await db.select().from(schema.products).where(eq(schema.products.id, productId));
    expect(product.curatorNote).toBe("Linho puro — a peça mais fresca da edição.");
    expect(product.curatorAudioPath).toBeNull();
  });

  it("\"ok voz\" numa resposta escrita guarda só o texto e diz por quê", async () => {
    await askToday();
    await text("MSG-T1", "resposta: trouxe pela cor");
    const [draftEvent] = await outboxOf("curator.interview_draft");
    await draftCuratorInterview(sdb, provider, new FakeSalesAssistant(), draftEvent.payload as never);
    await text("MSG-OK", "ok voz");
    const [decide] = await outboxOf("curator.interview_decide");
    expect(await decideCuratorInterview(sdb, provider, storage, decide.payload as never)).toEqual({ done: "aprovada", voice: "escrito" });
    expect(lastBodies().some((body) => body.includes("a resposta foi escrita"))).toBe(true);
  });

  it("\"pula\" fecha a entrevista sem mexer na peça", async () => {
    await askToday();
    await text("MSG-P", "pula");
    const [decide] = await outboxOf("curator.interview_decide");
    expect(await decideCuratorInterview(sdb, provider, storage, decide.payload as never)).toEqual({ done: "pulada" });
    expect((await interviews())[0].status).toBe("skipped");
  });

  it("áudio que não deu para ouvir: a dona recebe o aviso e a pergunta segue aberta", async () => {
    await askToday();
    await audio("MSG-A2");
    expect(await transcribe("MSG-A2", new Error("fora"))).toMatchObject({ route: "interview_answer" });
    const [decide] = await outboxOf("curator.interview_decide");
    expect(await decideCuratorInterview(sdb, provider, storage, decide.payload as never)).toEqual({ done: "avisada" });
    expect((await interviews())[0].status).toBe("asked");
    expect(lastBodies().some((body) => body.includes("Não consegui ouvir"))).toBe(true);
  });

  it("texto solto da dona continua indo à Lia (ela testa como cliente)", async () => {
    await askToday();
    const result = await text("MSG-Q", "tem esse vestido no M?");
    expect(result.action).toBe("bot_queued");
    expect(await outboxOf("curator.interview_decide")).toHaveLength(0);
    expect((await interviews())[0].status).toBe("asked");
  });

  it("lote de fotos do Ateliê aberto ganha: o áudio é recado da peça nova", async () => {
    await askToday();
    await send({ ...base("MSG-F1"), image: { imageUrl: "https://cdn/MSG-F1.jpg", mimeType: "image/jpeg" } });
    expect((await audio("MSG-A3")).action).toBe("transcribe_queued");
    expect((await interviews())[0].answerWaMessageId).toBeNull();
    expect(await transcribe("MSG-A3", "chegou o cropped canelado")).toMatchObject({ route: "atelier_queued" });
    expect((await interviews())[0].status).toBe("asked");
  });

  it("entrevista vencida (mais de 8 h): o áudio volta ao caminho de sempre", async () => {
    await askToday();
    await db.update(schema.curatorInterviews).set({ askedAt: new Date(Date.now() - 9 * 3600_000) });
    await audio("MSG-A4");
    expect((await interviews())[0].answerWaMessageId).toBeNull();
    expect(await outboxTypes()).not.toContain("curator.interview_draft");
  });
});
