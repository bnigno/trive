// A vendedora enxerga: só as fotos pendentes do turno vão anexadas (reduzidas
// a ≤ 1024 px), fotos antigas viram marcador, download que falha não derruba
// o turno, o interruptor desliga tudo e um áudio recém-enfileirado para
// transcrição segura o turno.
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeSalesAssistant } from "@/adapters/assistant/fake";
import { FakeMessagingProvider } from "@/adapters/zapi/fake";
import { INBOUND_MEDIA_MARKERS } from "@/core/whatsapp/media";
import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { runBotTurn } from "@/services/wa-bot";
import { createTestDb, type TestDb } from "../helpers/db";
import { nextMessageStamp } from "../helpers/clock";

const PHONE = "+5511999998888";
const PHOTO_URL = "https://cdn.z-api.example/img/print.jpg";
const OLD_PHOTO_URL = "https://cdn.z-api.example/img/antiga.jpg";

let db: TestDb;
let sdb: DbOrTx;
let close: () => Promise<void>;
let assistant: FakeSalesAssistant;
let provider: FakeMessagingProvider;
let sequence = 0;

async function bigJpeg(): Promise<Buffer> {
  return sharp({ create: { width: 2400, height: 1600, channels: 3, background: "#b08968" } })
    .jpeg()
    .toBuffer();
}

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  sdb = db as unknown as DbOrTx;
  assistant = new FakeSalesAssistant();
  provider = new FakeMessagingProvider();
  provider.setMediaFixture(PHOTO_URL, await bigJpeg(), "image/jpeg");
  provider.setMediaFixture(OLD_PHOTO_URL, await bigJpeg(), "image/jpeg");
  vi.stubEnv("ADAPTER_MODE", "fake");
  await db.insert(schema.settings).values([
    { key: "wa_enabled", value: true },
    { key: "bot_enabled", value: true },
  ]);
  sequence = 0;
});

afterEach(async () => {
  await close();
  vi.unstubAllEnvs();
});

async function createConversation(): Promise<string> {
  const [conversation] = await db
    .insert(schema.waConversations)
    .values({ phoneE164: PHONE, status: "open" })
    .returning({ id: schema.waConversations.id });
  return conversation.id;
}

async function addInbound(
  conversationId: string,
  body: string,
  opts: { kind?: "text" | "image" | "audio"; mediaUrl?: string; mediaMeta?: unknown; ageMs?: number } = {},
): Promise<string> {
  sequence += 1;
  const [message] = await db
    .insert(schema.waMessages)
    .values({
      conversationId,
      direction: "inbound",
      kind: opts.kind ?? "text",
      zapiMessageId: `MSG-IN-${sequence}-${Math.random().toString(36).slice(2, 8)}`,
      body,
      status: "delivered",
      deliveredAt: new Date(),
      ...(opts.mediaUrl ? { mediaUrl: opts.mediaUrl } : {}),
      ...(opts.mediaMeta !== undefined ? { mediaMeta: opts.mediaMeta } : {}),
      createdAt: opts.ageMs !== undefined ? new Date(Date.now() - opts.ageMs) : nextMessageStamp(),
    })
    .returning({ id: schema.waMessages.id });
  return message.id;
}

/** `answering` = a inbound que esta resposta respondeu (o dedupe real da Lia); sem ela, um envio sem âncora. */
async function addOutbound(conversationId: string, body: string, answering?: string): Promise<void> {
  sequence += 1;
  await db.insert(schema.waMessages).values({
    conversationId,
    direction: "outbound",
    body,
    status: "sent",
    dedupeKey: answering ? `wa.bot_reply:${answering}` : `wa.bot:${conversationId}:${sequence}`,
    createdAt: nextMessageStamp(),
  });
}

function lastUserMessage() {
  const input = assistant.inputs.at(-1);
  const users = input?.history.filter((message) => message.role === "user") ?? [];
  return users.at(-1);
}

describe("runBotTurn com fotos e áudios", () => {
  it("foto pendente vai anexada, reduzida a ≤ 1024 px, e o texto avisa o modelo", async () => {
    const conversationId = await createConversation();
    await addInbound(conversationId, `${INBOUND_MEDIA_MARKERS.image} tem parecida?`, {
      kind: "image",
      mediaUrl: PHOTO_URL,
      mediaMeta: { mimeType: "image/jpeg", width: 2400, height: 1600 },
    });

    const result = await runBotTurn(sdb, assistant, provider, { conversationId });
    expect(result).toMatchObject({ handedOff: false });

    const user = lastUserMessage();
    expect(user?.text).toBe(`${INBOUND_MEDIA_MARKERS.image} tem parecida? (a foto está anexada nesta mensagem)`);
    expect(user?.images).toHaveLength(1);
    expect(user?.images?.[0]?.mediaType).toBe("image/jpeg");
    const meta = await sharp(Buffer.from(user?.images?.[0]?.base64 ?? "", "base64")).metadata();
    expect(meta.width).toBe(1024);
    expect(meta.height).toBe(683);

    // A resposta fake confirma que a foto chegou; o audit guarda só contagens.
    const [reply] = await db
      .select({ body: schema.waMessages.body })
      .from(schema.waMessages)
      .where(eq(schema.waMessages.direction, "outbound"));
    expect(reply.body).toContain("[+1 foto(s)]");
    const [audit] = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "wa.bot_turn"));
    expect(audit.after).toMatchObject({ media: { images: 1, audios: 0 } });
    expect(JSON.stringify(audit.after)).not.toContain("base64");
  });

  it("a impressão digital da foto do turno fica em media_meta (16 hex) — a foto não; o bloco de imagem vai só com mediaType e base64", async () => {
    const conversationId = await createConversation();
    const photo = await addInbound(conversationId, INBOUND_MEDIA_MARKERS.image, {
      kind: "image",
      mediaUrl: PHOTO_URL,
      mediaMeta: { mimeType: "image/jpeg", width: 2400, height: 1600 },
    });
    await runBotTurn(sdb, assistant, provider, { conversationId });

    const [row] = await db.select({ mediaMeta: schema.waMessages.mediaMeta }).from(schema.waMessages).where(eq(schema.waMessages.id, photo));
    expect(row.mediaMeta).toMatchObject({ mimeType: "image/jpeg", width: 2400, height: 1600, phash: expect.stringMatching(/^[0-9a-f]{16}$/) });
    expect(JSON.stringify(row.mediaMeta)).not.toContain("base64");
    expect(Object.keys(lastUserMessage()?.images?.[0] ?? {}).sort()).toEqual(["base64", "mediaType"]);

    // Segundo turno com a mesma foto (agora antiga): o hash gravado não é reescrito.
    const [before] = await db.select({ mediaMeta: schema.waMessages.mediaMeta }).from(schema.waMessages).where(eq(schema.waMessages.id, photo));
    await addInbound(conversationId, "é essa aí, tem no M?");
    await runBotTurn(sdb, assistant, provider, { conversationId });
    const [after] = await db.select({ mediaMeta: schema.waMessages.mediaMeta }).from(schema.waMessages).where(eq(schema.waMessages.id, photo));
    expect(after.mediaMeta).toEqual(before.mediaMeta);
  });

  it("foto antiga (antes da última resposta) não é baixada e vira marcador", async () => {
    const conversationId = await createConversation();
    const photo = await addInbound(conversationId, INBOUND_MEDIA_MARKERS.image, { kind: "image", mediaUrl: OLD_PHOTO_URL });
    await addOutbound(conversationId, "Que linda! Vi aqui…", photo);
    await addInbound(conversationId, "e em outra cor?");

    await runBotTurn(sdb, assistant, provider, { conversationId });

    const history = assistant.inputs.at(-1)?.history ?? [];
    const oldPhoto = history.find((message) => message.text.startsWith(INBOUND_MEDIA_MARKERS.image));
    expect(oldPhoto?.text).toBe(
      `${INBOUND_MEDIA_MARKERS.image} (foto antiga, não anexada — não descreva o que havia nela)`,
    );
    expect(oldPhoto?.images).toBeUndefined();
    expect(lastUserMessage()?.images).toBeUndefined();
  });

  it("download que falha não derruba o turno: a foto vira 'não foi possível abrir'", async () => {
    const conversationId = await createConversation();
    await addInbound(conversationId, INBOUND_MEDIA_MARKERS.image, {
      kind: "image",
      mediaUrl: "https://cdn.z-api.example/img/expirada.jpg",
    });

    const result = await runBotTurn(sdb, assistant, provider, { conversationId });
    expect(result).toMatchObject({ handedOff: false });
    expect(lastUserMessage()?.text).toBe(
      `${INBOUND_MEDIA_MARKERS.image} (não foi possível abrir a foto — peça para ela descrever a peça ou reenviar)`,
    );
    expect(lastUserMessage()?.images).toBeUndefined();
  });

  it("com bot_media_enabled=false nenhuma foto é anexada", async () => {
    await db.insert(schema.settings).values({ key: "bot_media_enabled", value: false });
    const conversationId = await createConversation();
    await addInbound(conversationId, INBOUND_MEDIA_MARKERS.image, { kind: "image", mediaUrl: PHOTO_URL });

    await runBotTurn(sdb, assistant, provider, { conversationId });
    expect(lastUserMessage()?.images).toBeUndefined();
    expect(lastUserMessage()?.text).toContain("não foi possível abrir a foto");
  });

  it("no máximo 3 fotos por turno, as mais recentes", async () => {
    const conversationId = await createConversation();
    for (let index = 0; index < 4; index += 1) {
      const url = `${PHOTO_URL}?n=${index}`;
      provider.setMediaFixture(url, await bigJpeg(), "image/jpeg");
      await addInbound(conversationId, INBOUND_MEDIA_MARKERS.image, { kind: "image", mediaUrl: url });
    }
    await runBotTurn(sdb, assistant, provider, { conversationId });
    const users = assistant.inputs.at(-1)?.history.filter((message) => message.role === "user") ?? [];
    expect(users.map((message) => message.images?.length ?? 0)).toEqual([0, 1, 1, 1]);
  });

  it("áudio recém-enfileirado para transcrição segura o turno; passado o prazo, entra como marcador", async () => {
    const conversationId = await createConversation();
    await addInbound(conversationId, INBOUND_MEDIA_MARKERS.audio, {
      kind: "audio",
      mediaUrl: "https://cdn.z-api.example/a.ogg",
      mediaMeta: { transcript: { status: "pending" } },
      ageMs: 10_000,
    });
    expect(await runBotTurn(sdb, assistant, provider, { conversationId })).toEqual({
      skipped: "aguardando_transcricao",
    });
    expect(assistant.inputs).toHaveLength(0);

    await db
      .update(schema.waMessages)
      .set({ createdAt: new Date(Date.now() - 5 * 60_000) })
      .where(eq(schema.waMessages.conversationId, conversationId));
    const result = await runBotTurn(sdb, assistant, provider, { conversationId });
    expect(result).toMatchObject({ handedOff: false });
    expect(lastUserMessage()?.text).toBe(`${INBOUND_MEDIA_MARKERS.audio} (não foi possível transcrever)`);
  });

  it("áudio transcrito entra como fala da cliente", async () => {
    const conversationId = await createConversation();
    await addInbound(conversationId, "quero o vestido dunas no M", {
      kind: "audio",
      mediaUrl: "https://cdn.z-api.example/a.ogg",
      mediaMeta: { transcript: { status: "done", chars: 27 } },
    });
    await runBotTurn(sdb, assistant, provider, { conversationId });
    expect(lastUserMessage()?.text).toBe("[áudio da cliente, transcrição automática] quero o vestido dunas no M");
    const [audit] = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "wa.bot_turn"));
    expect(audit.after).toMatchObject({ media: { images: 0, audios: 1 } });
  });
});
