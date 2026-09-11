// Cartão editorial no serviço: chave determinística, cache (a mesma vitrine
// nunca é desenhada duas vezes), fotos baixadas do Storage (md, senão full),
// JPEG publicado em cards/<aa>/<chave>.jpg e validação dos limites.
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeFileStorage } from "@/adapters/storage/fake";
import { FakeMessagingProvider } from "@/adapters/zapi/fake";
import type { CardData } from "@/core/cards/types";
import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import {
  botCardKey,
  botCardStoragePath,
  cardMessageDedupeKey,
  findCachedBotCard,
  isBotCardsEnabled,
  publishBotCard,
  renderAndSendBotCard,
  type PublishBotCardInput,
} from "@/services/bot-cards";
import { createTestDb, type TestDb } from "../helpers/db";

let db: TestDb;
let sdb: DbOrTx;
let close: () => Promise<void>;
let storage: FakeFileStorage;

async function webp(color: string, width = 900, height = 1200): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: color } }).webp().toBuffer();
}

const render = vi.fn(async (data: CardData) => {
  // PNG pequeno; o que importa é que chegou o CardData montado.
  const items =
    data.kind === "catalog"
      ? data.items
      : data.kind === "look"
        ? [data.hero, ...data.complements]
        : [data.hero];
  expect(items.every((item) => item.imageDataUrl.startsWith("data:image/jpeg;base64,"))).toBe(true);
  return sharp({ create: { width: 108, height: 135, channels: 3, background: "#faf7f0" } }).png().toBuffer();
});

const input: PublishBotCardInput = {
  kind: "catalog",
  storeName: "TRIVÉ",
  eyebrow: "A VITRINE DE HOJE",
  title: "Duas peças para você",
  items: [
    { slug: "longo-dunas", name: "LONGO DUNAS", priceLabel: "R$ 309,00", imagePath: "products/a/1-full.webp" },
    { slug: "bolsa-tote", name: "Bolsa Tote", priceLabel: "R$ 129,00", imagePath: "products/b/1-full.webp" },
  ],
};

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  sdb = db as unknown as DbOrTx;
  storage = new FakeFileStorage();
  render.mockClear();
  await storage.upload({ path: "products/a/1-md.webp", data: await webp("#b08968"), contentType: "image/webp" });
  await storage.upload({ path: "products/b/1-full.webp", data: await webp("#7a6a58", 1600, 1600), contentType: "image/webp" });
});

afterEach(async () => {
  await close();
});

describe("botCardKey", () => {
  it("é estável e muda com peça, foto, preço ou título", () => {
    const key = botCardKey(input);
    expect(key).toMatch(/^[0-9a-f]{40}$/);
    expect(botCardKey({ ...input })).toBe(key);
    expect(botCardKey({ ...input, items: [input.items[1], input.items[0]] })).not.toBe(key);
    expect(
      botCardKey({ ...input, items: [{ ...input.items[0], priceLabel: "R$ 279,00" }, input.items[1]] }),
    ).not.toBe(key);
    expect(botCardKey({ ...input, title: "Outro" })).not.toBe(key);
    expect(botCardStoragePath(key)).toBe(`cards/${key.slice(0, 2)}/${key}.jpg`);
  });
});

describe("publishBotCard", () => {
  it("desenha uma vez, publica o JPEG e registra; a segunda chamada vem do cache sem render", async () => {
    const first = await publishBotCard(sdb, storage, render, input);
    expect(first.cached).toBe(false);
    expect(first.path).toBe(botCardStoragePath(first.key));
    expect(first.url).toBe(`memory://${first.path}`);
    expect(render).toHaveBeenCalledTimes(1);
    const file = await storage.download(first.path);
    expect(file.contentType).toBe("image/jpeg");
    expect((await sharp(file.data).metadata()).format).toBe("jpeg");

    const rows = await db.select().from(schema.botCards);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: first.key, kind: "catalog", productSlugs: ["longo-dunas", "bolsa-tote"] });

    const second = await publishBotCard(sdb, storage, render, input);
    expect(second).toMatchObject({ key: first.key, url: first.url, cached: true, renderMs: 0 });
    expect(render).toHaveBeenCalledTimes(1);
  });

  it("prefere a rendição -md e cai na -full quando ela não existe; corta em 3:4 no tamanho da moldura", async () => {
    let captured: CardData | undefined;
    const spy = vi.fn(async (data: CardData) => {
      captured = data;
      return render(data);
    });
    await publishBotCard(sdb, storage, spy, input);
    expect(captured?.kind).toBe("catalog");
    const items = captured?.kind === "catalog" ? captured.items : [];
    const meta = await sharp(Buffer.from(items[1].imageDataUrl.split(",")[1], "base64")).metadata();
    // Moldura de 2 peças = 440×587 → foto embutida em 2× (880×1174).
    expect(meta.width).toBe(880);
    expect(meta.height).toBe(1174);
  });

  it("foto inexistente no Storage falha (quem chama trata como 'sem cartão')", async () => {
    await expect(
      publishBotCard(sdb, storage, render, {
        ...input,
        items: [input.items[0], { ...input.items[1], imagePath: "products/x/nada-full.webp" }],
      }),
    ).rejects.toThrow();
    expect(await db.select().from(schema.botCards)).toHaveLength(0);
  });

  it("valida os limites: catálogo até 3, look com peça + 1 ou 2", async () => {
    await expect(publishBotCard(sdb, storage, render, { ...input, items: [] })).rejects.toThrow(/sem peças/);
    await expect(
      publishBotCard(sdb, storage, render, { ...input, items: [...input.items, ...input.items] }),
    ).rejects.toThrow(/até 3/);
    await expect(
      publishBotCard(sdb, storage, render, { ...input, kind: "look", items: [input.items[0]] }),
    ).rejects.toThrow(/1 ou 2 complementos/);
    const look = await publishBotCard(sdb, storage, render, { ...input, kind: "look", title: "Um look com LONGO DUNAS" });
    expect(look.cached).toBe(false);
  });

  it("post e story mostram UMA peça (duas é erro) e cada um vira seu próprio cartão", async () => {
    await expect(
      publishBotCard(sdb, storage, render, { ...input, kind: "post" }),
    ).rejects.toThrow(/UMA peça/);

    const uma = { ...input, items: [input.items[0]] };
    const post = await publishBotCard(sdb, storage, render, { ...uma, kind: "post" });
    const story = await publishBotCard(sdb, storage, render, { ...uma, kind: "story" });
    expect(post.cached).toBe(false);
    expect(story.cached).toBe(false);
    expect(post.key).not.toBe(story.key);
    const rows = await db.select().from(schema.botCards);
    expect(rows.map((row) => row.kind).sort()).toContain("post");
    expect(rows.map((row) => row.kind).sort()).toContain("story");
  });

  it("isBotCardsEnabled: ausente = ligado, false desliga", async () => {
    expect(await isBotCardsEnabled(sdb)).toBe(true);
    await db.insert(schema.settings).values({ key: "bot_cards_enabled", value: false });
    expect(await isBotCardsEnabled(sdb)).toBe(false);
  });
});

describe("renderAndSendBotCard (handler wa.card_render)", () => {
  const PHONE = "+5511999990000";
  const INBOUND_ID = "00000000-0000-4000-8000-00000000feed";

  it("desenha, publica e manda a imagem com legenda; a reentrega não duplica", async () => {
    await db.insert(schema.settings).values({ key: "wa_enabled", value: true });
    const [conversation] = await db
      .insert(schema.waConversations)
      .values({ phoneE164: PHONE, status: "open" })
      .returning({ id: schema.waConversations.id });
    const provider = new FakeMessagingProvider();
    const payload = {
      conversationId: conversation.id,
      phoneE164: PHONE,
      customerId: null,
      lastInboundId: INBOUND_ID,
      caption: "Vitrine: LONGO DUNAS · Bolsa Tote",
      request: { ...input, kind: input.kind as "catalog" | "look" },
    };

    const first = await renderAndSendBotCard(sdb, provider, storage, render, payload);
    expect("skipped" in first).toBe(false);
    expect(first.cardUrl).toMatch(/^memory:\/\/cards\//);
    expect(provider.sentImages).toHaveLength(1);
    expect(provider.sentImages[0]).toMatchObject({ toE164: PHONE, caption: "Vitrine: LONGO DUNAS · Bolsa Tote" });
    expect(await findCachedBotCard(sdb, storage, input)).not.toBeNull();

    const again = await renderAndSendBotCard(sdb, provider, storage, render, payload);
    expect(again).toMatchObject({ skipped: "ja_enviado" });
    expect(provider.sentImages).toHaveLength(1);
    expect(render).toHaveBeenCalledTimes(1);

    const [message] = await db.select().from(schema.waMessages);
    expect(message.dedupeKey).toBe(cardMessageDedupeKey(INBOUND_ID));
    expect(message.kind).toBe("image");
  });
});
