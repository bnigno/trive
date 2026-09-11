// Mídia recebida no webhook (áudio, foto, figurinha…) deixa de sumir: vira
// uma inbound com marcador em português, entra no fluxo normal (bot ou
// forward) e, no caso da foto, guarda a URL para o painel. E o caderninho da
// vendedora acompanha o telefone quando a conversa anterior foi encerrada.
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { INBOUND_MEDIA_MARKERS, processZapiInbound } from "@/services/wa-inbound";
import { createTestDb, type TestDb } from "../helpers/db";

const SECRET = "segredo-webhook-zapi";
const PHONE_E164 = "+5511999990000";
const PHONE_ZAPI = "5511999990000";

function base(messageId: string) {
  return {
    type: "ReceivedCallback",
    instanceId: "instancia-x",
    messageId,
    phone: PHONE_ZAPI,
    fromMe: false,
    isGroup: false,
    senderName: "Ana Cliente",
    momment: Date.now(),
    status: "RECEIVED",
  };
}

describe("processZapiInbound → mídia recebida", () => {
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
    ]);
  });

  afterEach(async () => {
    await close();
    vi.unstubAllEnvs();
    if (originalSecret === undefined) delete process.env.ZAPI_WEBHOOK_SECRET;
    else process.env.ZAPI_WEBHOOK_SECRET = originalSecret;
  });

  it("áudio vira inbound kind audio com URL e vai para a fila de transcrição", async () => {
    const result = await processZapiInbound(sdb, {
      providedSecret: SECRET,
      body: {
        ...base("MSG-AUDIO"),
        audio: { audioUrl: "https://cdn/x.ogg", mimeType: "audio/ogg; codecs=opus", seconds: 12 },
      },
    });
    expect(result.action).toBe("transcribe_queued");

    const [message] = await db.select().from(schema.waMessages);
    expect(message.direction).toBe("inbound");
    expect(message.kind).toBe("audio");
    expect(message.body).toBe(INBOUND_MEDIA_MARKERS.audio);
    expect(message.mediaUrl).toBe("https://cdn/x.ogg");
    expect(message.mediaMeta).toEqual({
      mimeType: "audio/ogg; codecs=opus",
      seconds: 12,
      transcript: { status: "pending" },
    });

    const events = await db.select().from(schema.outboxEvents);
    expect(events.map((event) => event.eventType)).toEqual(["wa.transcribe"]);
    expect(events[0]?.dedupeKey).toBe("wa.transcribe:MSG-AUDIO");
    expect(events[0]?.payload).toEqual({ waMessageId: message.id });
  });

  it("com a vendedora sem ouvir (bot_media_enabled=false), o áudio segue como marcador para o turno", async () => {
    await db.insert(schema.settings).values({ key: "bot_media_enabled", value: false });
    const result = await processZapiInbound(sdb, {
      providedSecret: SECRET,
      body: { ...base("MSG-AUDIO-2"), audio: { audioUrl: "https://cdn/y.ogg", mimeType: "audio/ogg" } },
    });
    expect(result.action).toBe("bot_queued");

    const [message] = await db.select().from(schema.waMessages);
    expect(message.kind).toBe("audio");
    expect(message.body).toBe(INBOUND_MEDIA_MARKERS.audio);
    expect(message.mediaMeta).toEqual({ mimeType: "audio/ogg" });

    const events = await db.select().from(schema.outboxEvents);
    expect(events.map((event) => event.eventType)).toEqual(["wa.bot_turn"]);
  });

  it("reentrega do webhook de áudio não duplica a transcrição na fila", async () => {
    const body = { ...base("MSG-AUDIO-3"), audio: { audioUrl: "https://cdn/z.ogg" } };
    await processZapiInbound(sdb, { providedSecret: SECRET, body });
    const again = await processZapiInbound(sdb, { providedSecret: SECRET, body });
    expect(again.action).toBe("duplicate");
    const events = await db.select().from(schema.outboxEvents);
    expect(events).toHaveLength(1);
  });

  it("foto vira inbound kind image com URL e legenda", async () => {
    const result = await processZapiInbound(sdb, {
      providedSecret: SECRET,
      body: {
        ...base("MSG-FOTO"),
        image: {
          imageUrl: "https://cdn/foto.jpg",
          caption: "tem igual a essa?",
          mimeType: "image/jpeg",
          width: 1080,
          height: 1350,
        },
      },
    });
    expect(result.action).toBe("bot_queued");
    const [message] = await db.select().from(schema.waMessages);
    expect(message.kind).toBe("image");
    expect(message.mediaUrl).toBe("https://cdn/foto.jpg");
    expect(message.body).toBe(`${INBOUND_MEDIA_MARKERS.image} tem igual a essa?`);
    expect(message.mediaMeta).toEqual({ mimeType: "image/jpeg", width: 1080, height: 1350 });
  });

  it("figurinha e documento também registram; status puro continua ignorado", async () => {
    const sticker = await processZapiInbound(sdb, {
      providedSecret: SECRET,
      body: { ...base("MSG-STICKER"), sticker: { stickerUrl: "https://cdn/s.webp" } },
    });
    expect(sticker.action).toBe("bot_queued");

    const doc = await processZapiInbound(sdb, {
      providedSecret: SECRET,
      body: { ...base("MSG-DOC"), document: { documentUrl: "https://cdn/d.pdf", fileName: "medidas.pdf" } },
    });
    expect(doc.action).toBe("bot_queued");

    const bodies = (await db.select().from(schema.waMessages)).map((m) => m.body);
    expect(bodies).toContain(INBOUND_MEDIA_MARKERS.sticker);
    expect(bodies).toContain(`${INBOUND_MEDIA_MARKERS.document} medidas.pdf`);

    const status = await processZapiInbound(sdb, {
      providedSecret: SECRET,
      body: { messageId: "MSG-AUDIO", phone: PHONE_ZAPI, status: "READ", ids: ["MSG-X"] },
    });
    expect(status.action).toBe("status");
  });

  it("guarda o nome do perfil no caderninho e herda as anotações da conversa encerrada", async () => {
    await db.insert(schema.waConversations).values({
      phoneE164: PHONE_E164,
      status: "closed",
      botState: { notes: ["veste M em vestidos"], cart: [{ sku: "X" }] },
    });

    await processZapiInbound(sdb, {
      providedSecret: SECRET,
      body: { ...base("MSG-1"), text: { message: "oi, voltei" } },
    });

    const [nova] = await db
      .select()
      .from(schema.waConversations)
      .where(eq(schema.waConversations.status, "open"));
    expect(nova.botState).toEqual({
      notes: ["veste M em vestidos"],
      displayName: "Ana Cliente",
    });
  });
});
