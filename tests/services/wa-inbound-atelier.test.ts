// O celular da dona no número da maison: foto abre o lote, recado com fotos
// recentes abre a chegada (fila, com respiro), áudio vai transcrever e volta
// para o Ateliê, documento pede a foto; texto solto dela segue o fluxo
// normal — e cliente comum nunca cai no Ateliê.
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeTranscriber } from "@/adapters/transcription/fake";
import { FakeMessagingProvider } from "@/adapters/zapi/fake";
import { INTAKE_GRACE_MS } from "@/core/atelier/batch";
import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { processZapiInbound } from "@/services/wa-inbound";
import { transcribeInboundAudio } from "@/services/wa-transcribe";
import { createTestDb, type TestDb } from "../helpers/db";

const SECRET = "segredo-webhook-zapi";
const OWNER_ZAPI = "5591981037536";
const CLIENT_ZAPI = "5511999990000";

function base(messageId: string, phone = OWNER_ZAPI) {
  return {
    type: "ReceivedCallback",
    instanceId: "instancia-x",
    messageId,
    phone,
    fromMe: false,
    isGroup: false,
    senderName: "Dona",
    momment: Date.now(),
    status: "RECEIVED",
  };
}

const photo = (id: string, extra: Record<string, unknown> = {}, phone = OWNER_ZAPI) => ({
  ...base(id, phone),
  image: { imageUrl: `https://cdn/${id}.jpg`, mimeType: "image/jpeg", ...extra },
});
const text = (id: string, message: string, phone = OWNER_ZAPI) => ({ ...base(id, phone), text: { message } });

describe("processZapiInbound → Ateliê (mensagem do dono)", () => {
  let db: TestDb;
  let sdb: DbOrTx;
  let close: () => Promise<void>;
  const originalSecret = process.env.ZAPI_WEBHOOK_SECRET;

  beforeEach(async () => {
    ({ db, close } = await createTestDb());
    sdb = db as unknown as DbOrTx;
    process.env.ZAPI_WEBHOOK_SECRET = SECRET;
    delete process.env.ZAPI_CLIENT_TOKEN;
    vi.stubEnv("ADAPTER_MODE", "fake");
    await db.insert(schema.settings).values([
      { key: "wa_enabled", value: true },
      { key: "bot_enabled", value: true },
      // Formato livre de propósito: o dono digita como quiser.
      { key: "owner_whatsapp_phone", value: "(91) 98103-7536" },
    ]);
  });

  afterEach(async () => {
    await close();
    vi.unstubAllEnvs();
    if (originalSecret === undefined) delete process.env.ZAPI_WEBHOOK_SECRET;
    else process.env.ZAPI_WEBHOOK_SECRET = originalSecret;
  });

  const send = (body: unknown) => processZapiInbound(sdb, { providedSecret: SECRET, body });
  const outbox = () => db.select().from(schema.outboxEvents);
  const intakes = () => db.select().from(schema.atelierIntakes);

  it("foto sem legenda: fica no lote, sem turno da Lia nem encaminhamento", async () => {
    const result = await send(photo("MSG-F1"));
    expect(result.action).toBe("atelier_photo");
    expect(await outbox()).toHaveLength(0);
    expect(await intakes()).toHaveLength(0);
    const [message] = await db.select().from(schema.waMessages);
    expect(message.kind).toBe("image");
    expect(message.mediaUrl).toBe("https://cdn/MSG-F1.jpg");
  });

  it("duas fotos e o recado: a chegada abre com o recado e a fila espera o respiro", async () => {
    await send(photo("MSG-F1"));
    await send(photo("MSG-F2"));
    const before = Date.now();
    const result = await send(text("MSG-NOTE", "chegou o Longo Dunas da Aurora, custou 120"));
    expect(result.action).toBe("atelier_queued");

    const rows = await intakes();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "queued", note: "chegou o Longo Dunas da Aurora, custou 120", noteKind: "text" });
    const [note] = await db.select().from(schema.waMessages).where(eq(schema.waMessages.zapiMessageId, "MSG-NOTE"));
    expect(rows[0].triggerWaMessageId).toBe(note.id);

    const events = await outbox();
    expect(events.map((event) => event.eventType)).toEqual(["wa.atelier_intake"]);
    expect(events[0].dedupeKey).toBe("wa.atelier:MSG-NOTE");
    expect(events[0].payload).toEqual({ conversationId: rows[0].conversationId, triggerWaMessageId: note.id });
    expect(events[0].nextAttemptAt.getTime()).toBeGreaterThanOrEqual(before + INTAKE_GRACE_MS - 1000);

    // Reentrega do webhook do recado: nada dobra.
    const again = await send(text("MSG-NOTE", "chegou o Longo Dunas da Aurora, custou 120"));
    expect(again.action).toBe("duplicate");
    expect(await intakes()).toHaveLength(1);
    expect(await outbox()).toHaveLength(1);
  });

  it("legenda na foto já é o recado: a chegada abre na hora", async () => {
    await send(photo("MSG-F1"));
    const result = await send(photo("MSG-F2", { caption: "Baby look bella, 3 de cada" }));
    expect(result.action).toBe("atelier_queued");
    const [intake] = await intakes();
    expect(intake).toMatchObject({ note: "Baby look bella, 3 de cada", noteKind: "caption" });
  });

  it("texto solto do dono, sem foto recente, segue o fluxo normal (testar a Lia)", async () => {
    const result = await send(text("MSG-T1", "oi Lia, tem vestido midi?"));
    expect(result.action).toBe("bot_queued");
    expect((await outbox()).map((event) => event.eventType)).toEqual(["wa.bot_turn"]);
    expect(await intakes()).toHaveLength(0);
  });

  it("foto de 16 minutos atrás não conta: o recado vira texto normal", async () => {
    await send(photo("MSG-F1"));
    await db
      .update(schema.waMessages)
      .set({ createdAt: new Date(Date.now() - 16 * 60_000) })
      .where(eq(schema.waMessages.zapiMessageId, "MSG-F1"));
    const result = await send(text("MSG-NOTE", "chegou o vestido"));
    expect(result.action).toBe("bot_queued");
    expect(await intakes()).toHaveLength(0);
  });

  it("recado depois de uma chegada já aberta não reaproveita as mesmas fotos", async () => {
    await send(photo("MSG-F1"));
    await send(text("MSG-NOTE-1", "chegou o vestido"));
    const result = await send(text("MSG-NOTE-2", "esqueci: custou 120"));
    expect(result.action).toBe("bot_queued");
    expect(await intakes()).toHaveLength(1);
  });

  it("foto mandada como documento: orientação ao dono, sem turno da Lia", async () => {
    const result = await send({ ...base("MSG-DOC"), document: { documentUrl: "https://cdn/x.jpg", fileName: "IMG_1.jpg" } });
    expect(result.action).toBe("atelier_help");
    const events = await outbox();
    expect(events.map((event) => event.eventType)).toEqual(["wa.atelier_help"]);
    expect(events[0].payload).toEqual({ reason: "documento", dedupeKey: "wa.atelier_help:MSG-DOC" });
  });

  it("áudio do dono com foto recente: transcreve e a rota volta ao Ateliê com a transcrição", async () => {
    await send(photo("MSG-F1"));
    const result = await send({ ...base("MSG-AUDIO"), audio: { audioUrl: "https://cdn/nota.ogg", mimeType: "audio/ogg", seconds: 8 } });
    expect(result.action).toBe("transcribe_queued");
    expect((await outbox()).map((event) => event.eventType)).toEqual(["wa.transcribe"]);

    const provider = new FakeMessagingProvider();
    provider.setMediaFixture("https://cdn/nota.ogg", Buffer.from("OggS fake"), "audio/ogg");
    const transcriber = new FakeTranscriber();
    transcriber.enqueueText("chegou o cropped canelado da Aurora");
    const [audio] = await db.select().from(schema.waMessages).where(eq(schema.waMessages.zapiMessageId, "MSG-AUDIO"));
    const transcribed = await transcribeInboundAudio(sdb, provider, transcriber, { waMessageId: audio.id, attempt: 0 });
    expect(transcribed).toMatchObject({ transcribed: true, route: "atelier_queued" });

    const [intake] = await intakes();
    expect(intake).toMatchObject({ triggerWaMessageId: audio.id, note: "chegou o cropped canelado da Aurora", noteKind: "audio" });
    expect((await outbox()).map((event) => event.eventType).sort()).toEqual(["wa.atelier_intake", "wa.transcribe"]);
  });

  it("áudio do dono sem foto recente: depois de transcrever, pede as fotos", async () => {
    await send({ ...base("MSG-AUDIO-2"), audio: { audioUrl: "https://cdn/nota2.ogg", mimeType: "audio/ogg" } });
    const provider = new FakeMessagingProvider();
    provider.setMediaFixture("https://cdn/nota2.ogg", Buffer.from("OggS fake"), "audio/ogg");
    const transcriber = new FakeTranscriber();
    const [audio] = await db.select().from(schema.waMessages).where(eq(schema.waMessages.zapiMessageId, "MSG-AUDIO-2"));
    const transcribed = await transcribeInboundAudio(sdb, provider, transcriber, { waMessageId: audio.id, attempt: 0 });
    expect(transcribed).toMatchObject({ route: "atelier_help" });
    const help = (await outbox()).find((event) => event.eventType === "wa.atelier_help");
    expect(help?.payload).toMatchObject({ reason: "sem_fotos" });
    expect(await intakes()).toHaveLength(0);
  });

  it("sem como ouvir (bot_media_enabled=false): o áudio do dono pede o recado por texto", async () => {
    await db.insert(schema.settings).values({ key: "bot_media_enabled", value: false });
    const result = await send({ ...base("MSG-AUDIO-3"), audio: { audioUrl: "https://cdn/nota3.ogg" } });
    expect(result.action).toBe("atelier_help");
    const [event] = await outbox();
    expect(event.payload).toMatchObject({ reason: "audio_sem_transcricao" });
  });

  it("Ateliê desligado: a foto do dono cai no fluxo normal", async () => {
    await db.insert(schema.settings).values({ key: "atelier_enabled", value: false });
    const result = await send(photo("MSG-F1"));
    expect(result.action).toBe("bot_queued");
    expect(await intakes()).toHaveLength(0);
  });

  it("cliente comum com foto e texto nunca cai no Ateliê", async () => {
    await send(photo("MSG-C1", {}, CLIENT_ZAPI));
    const result = await send(text("MSG-C2", "chegou o vestido", CLIENT_ZAPI));
    expect(result.action).toBe("bot_queued");
    expect(await intakes()).toHaveLength(0);
    expect((await outbox()).map((event) => event.eventType)).toEqual(["wa.bot_turn", "wa.bot_turn"]);
  });

  it("conversa da dona encerrada no painel entre a foto e o recado: a chegada acha a foto mesmo assim", async () => {
    await send(photo("MSG-F1"));
    await db.update(schema.waConversations).set({ status: "closed" });
    const result = await send(text("MSG-NOTE", "chegou o vestido"));
    expect(result.action).toBe("atelier_queued");
    const [photoRow] = await db.select().from(schema.waMessages).where(eq(schema.waMessages.zapiMessageId, "MSG-F1"));
    const [intake] = await intakes();
    expect(intake.photoWaMessageIds).toEqual([photoRow.id]);
    expect(await db.select().from(schema.waConversations)).toHaveLength(2);
  });

  it("SAIR do dono com lote aberto continua sendo o comando, não um recado", async () => {
    await send(photo("MSG-F1"));
    const result = await send(text("MSG-SAIR", "SAIR"));
    expect(result.action).toBe("opt_out");
    expect(await intakes()).toHaveLength(0);
  });

  it("a chegada reivindica as fotos ao abrir (ids gravados na linha)", async () => {
    await send(photo("MSG-F1"));
    await send(photo("MSG-F2"));
    await send(text("MSG-NOTE", "chegou o vestido"));
    const [intake] = await intakes();
    const rows = await db.select().from(schema.waMessages).where(eq(schema.waMessages.kind, "image"));
    expect([...intake.photoWaMessageIds].sort()).toEqual(rows.map((row) => row.id).sort());
    expect(intake.photosCount).toBe(2);
  });
});
