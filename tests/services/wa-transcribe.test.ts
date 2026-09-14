// A vendedora ouve: o áudio da cliente é baixado, transcrito e vira o texto
// da própria mensagem; a rota (turno da vendedora ou dono) sai na mesma
// transação. Falha do vendor relança até a última tentativa; áudio longo,
// vazio ou já processado não chamam o vendor à toa.
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeTranscriber } from "@/adapters/transcription/fake";
import { FakeMessagingProvider } from "@/adapters/zapi/fake";
import { INBOUND_MEDIA_MARKERS } from "@/core/whatsapp/media";
import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";

const kicks: unknown[] = [];
vi.mock("@/inngest/client", () => ({ inngest: { send: async (event: unknown) => { kicks.push(event); return { ids: [] }; } } }));

const { transcribeInboundAudio } = await import("@/services/wa-transcribe");
import { createTestCustomer, createTestDb, type TestDb } from "../helpers/db";

const PHONE = "+5511999990000";
const AUDIO_URL = "https://cdn.z-api.example/audio/abc.ogg";

let db: TestDb;
let sdb: DbOrTx;
let close: () => Promise<void>;
let provider: FakeMessagingProvider;
let transcriber: FakeTranscriber;

beforeEach(async () => {
  kicks.length = 0;
  ({ db, close } = await createTestDb());
  sdb = db as unknown as DbOrTx;
  provider = new FakeMessagingProvider();
  provider.setMediaFixture(AUDIO_URL, Buffer.from("OggS fake"), "audio/ogg");
  transcriber = new FakeTranscriber();
  vi.stubEnv("ADAPTER_MODE", "fake");
  await db.insert(schema.settings).values([
    { key: "wa_enabled", value: true },
    { key: "bot_enabled", value: true },
  ]);
});

afterEach(async () => {
  await close();
  vi.unstubAllEnvs();
});

async function seedAudio(
  opts: { seconds?: number; transcript?: { status: "pending" | "done" }; customerId?: string; status?: string } = {},
): Promise<{ conversationId: string; messageId: string }> {
  const [conversation] = await db
    .insert(schema.waConversations)
    .values({
      phoneE164: PHONE,
      status: opts.status ?? "open",
      ...(opts.customerId ? { customerId: opts.customerId } : {}),
    })
    .returning({ id: schema.waConversations.id });
  const [message] = await db
    .insert(schema.waMessages)
    .values({
      conversationId: conversation.id,
      direction: "inbound",
      kind: "audio",
      zapiMessageId: "MSG-AUDIO-1",
      body: INBOUND_MEDIA_MARKERS.audio,
      status: "delivered",
      deliveredAt: new Date(),
      mediaUrl: AUDIO_URL,
      mediaMeta: {
        mimeType: "audio/ogg; codecs=opus",
        ...(opts.seconds !== undefined ? { seconds: opts.seconds } : {}),
        transcript: opts.transcript ?? { status: "pending" },
      },
    })
    .returning({ id: schema.waMessages.id });
  return { conversationId: conversation.id, messageId: message.id };
}

async function loadMessage(id: string) {
  const [row] = await db.select().from(schema.waMessages).where(eq(schema.waMessages.id, id));
  return row;
}

describe("transcribeInboundAudio", () => {
  it("grava a transcrição como corpo, marca done e enfileira o turno da vendedora", async () => {
    const { conversationId, messageId } = await seedAudio({ seconds: 14 });
    transcriber.enqueueText("  oi, quero o  vestido dunas\nno M ");

    const result = await transcribeInboundAudio(sdb, provider, transcriber, { waMessageId: messageId, attempt: 0 });
    expect(result).toMatchObject({ transcribed: true, route: "bot_queued", chars: 30 });

    const message = await loadMessage(messageId);
    expect(message.body).toBe("oi, quero o vestido dunas no M");
    expect(message.mediaMeta).toMatchObject({
      mimeType: "audio/ogg; codecs=opus",
      seconds: 14,
      transcript: { status: "done", model: "fake-transcribe", chars: 30 },
    });
    expect(transcriber.calls[0]?.mimeType).toBe("audio/ogg; codecs=opus");
    expect(transcriber.calls[0]?.languageHint).toBe("pt");

    const events = await db.select().from(schema.outboxEvents);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: "wa.bot_turn",
      dedupeKey: "wa.bot_turn:MSG-AUDIO-1",
      payload: { conversationId },
    });
    // O kick do turno sai depois do commit, sem id.
    expect(kicks).toEqual([{ name: "outbox/event.enqueued", data: {} }]);

    // O audit guarda medidas, nunca o texto.
    const [audit] = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "wa.transcribe"));
    expect(audit.entityId).toBe(messageId);
    expect(audit.after).toMatchObject({ status: "done", chars: 30, route: "bot_queued", seconds: 14 });
    expect(JSON.stringify(audit.after)).not.toContain("dunas");
  });

  it("com a vendedora desligada, encaminha ao dono com o trecho entre aspas e o nome da cliente", async () => {
    await db.update(schema.settings).set({ value: false }).where(eq(schema.settings.key, "bot_enabled"));
    const customerId = await createTestCustomer(db, "Ana Cliente");
    const { messageId } = await seedAudio({ customerId });
    transcriber.enqueueText("tem o colar em dourado?");

    const result = await transcribeInboundAudio(sdb, provider, transcriber, { waMessageId: messageId, attempt: 0 });
    expect(result).toMatchObject({ transcribed: true, route: "forwarded" });

    const [event] = await db.select().from(schema.outboxEvents);
    expect(event.eventType).toBe("wa.owner_forward");
    expect(event.dedupeKey).toBe("wa.fwd:MSG-AUDIO-1");
    expect(event.payload).toEqual({
      phoneE164: PHONE,
      body: '🎤 (áudio) "tem o colar em dourado?"',
      customerName: "Ana Cliente",
    });
  });

  it("falha do vendor relança enquanto há tentativas e nada é gravado", async () => {
    const { messageId } = await seedAudio();
    transcriber.failNext();

    await expect(
      transcribeInboundAudio(sdb, provider, transcriber, { waMessageId: messageId, attempt: 0 }),
    ).rejects.toThrow(/fora do ar/);

    const message = await loadMessage(messageId);
    expect(message.body).toBe(INBOUND_MEDIA_MARKERS.audio);
    expect(message.mediaMeta).toMatchObject({ transcript: { status: "pending" } });
    expect(await db.select().from(schema.outboxEvents)).toHaveLength(0);
  });

  it("na última tentativa, grava o marcador 'não foi possível transcrever' e a conversa segue", async () => {
    const { messageId } = await seedAudio();
    transcriber.failNext();

    const result = await transcribeInboundAudio(sdb, provider, transcriber, { waMessageId: messageId, attempt: 2 });
    expect(result).toEqual({ fallback: "falhou", route: "bot_queued" });

    const message = await loadMessage(messageId);
    expect(message.body).toBe(`${INBOUND_MEDIA_MARKERS.audio} (não foi possível transcrever)`);
    expect(message.mediaMeta).toMatchObject({ transcript: { status: "failed", reason: "falhou" } });
    const events = await db.select().from(schema.outboxEvents);
    expect(events.map((event) => event.eventType)).toEqual(["wa.bot_turn"]);
  });

  it("download que falha na última tentativa também cai no marcador", async () => {
    provider.reset();
    const { messageId } = await seedAudio();
    const result = await transcribeInboundAudio(sdb, provider, transcriber, { waMessageId: messageId, attempt: 2 });
    expect(result).toEqual({ fallback: "falhou", route: "bot_queued" });
    expect(transcriber.calls).toHaveLength(0);
  });

  it("áudio acima de 5 minutos não chama o vendor e entra como 'longo demais'", async () => {
    const { messageId } = await seedAudio({ seconds: 301 });
    const result = await transcribeInboundAudio(sdb, provider, transcriber, { waMessageId: messageId, attempt: 0 });
    expect(result).toEqual({ fallback: "longo", route: "bot_queued" });
    expect(transcriber.calls).toHaveLength(0);
    const message = await loadMessage(messageId);
    expect(message.body).toBe(`${INBOUND_MEDIA_MARKERS.audio} (áudio longo demais para transcrever)`);
    expect(message.mediaMeta).toMatchObject({ transcript: { status: "skipped", reason: "longo" } });
  });

  it("transcrição vazia (só ruído) vira marcador em vez de mensagem em branco", async () => {
    const { messageId } = await seedAudio();
    transcriber.enqueueText(" ... ");
    const result = await transcribeInboundAudio(sdb, provider, transcriber, { waMessageId: messageId, attempt: 0 });
    expect(result).toEqual({ fallback: "vazio", route: "bot_queued" });
    const message = await loadMessage(messageId);
    expect(message.body).toBe(`${INBOUND_MEDIA_MARKERS.audio} (não foi possível transcrever)`);
  });

  it("mensagem já processada, inexistente ou sem URL é ignorada sem tocar no vendor", async () => {
    const { messageId } = await seedAudio({ transcript: { status: "done" } });
    expect(
      await transcribeInboundAudio(sdb, provider, transcriber, { waMessageId: messageId, attempt: 0 }),
    ).toEqual({ skipped: "ja_processado" });
    expect(
      await transcribeInboundAudio(sdb, provider, transcriber, {
        waMessageId: "00000000-0000-4000-8000-000000000000",
        attempt: 0,
      }),
    ).toEqual({ skipped: "mensagem_inexistente" });
    expect(transcriber.calls).toHaveLength(0);
    expect(await db.select().from(schema.outboxEvents)).toHaveLength(0);
  });
});
