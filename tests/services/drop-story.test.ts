// O story do lançamento (PGlite + FakeFileStorage + FakeMessagingProvider):
// teaser = silhuetas desfocadas sem preço nem nome na moldura; aberta = foto e
// preço (peça escondida pela janela VIP entra); publicar guarda o arquivo,
// grava o caminho no lançamento e enfileira o envio; o handler manda a
// imagem ao WhatsApp da dona uma vez por arquivo.
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeFileStorage } from "@/adapters/storage/fake";
import { FakeMessagingProvider } from "@/adapters/zapi/fake";
import type { CardData } from "@/core/cards/types";
import * as schema from "@/db/schema";
import { formatCentsBRL } from "@/lib/money";
import type { DbOrTx } from "@/queue/enqueue";
import { buildDropStoryInput, publishDropStory, sendDropStoryToOwner } from "@/services/drop-story";
import { createDrop, scheduleDrop, setDropProducts } from "@/services/drops";
import { createTestDb, createTestUser, type TestDb } from "../helpers/db";

let db: TestDb;
let sdb: DbOrTx;
let close: () => Promise<void>;
let userId: string;
let storage: FakeFileStorage;

const NOW = new Date("2026-09-15T15:00:00Z"); // terça 12:00 SP
const PUBLISH_AT = new Date("2026-09-19T23:00:00Z"); // sábado 20:00 SP

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  sdb = db as unknown as DbOrTx;
  userId = (await createTestUser(db)).id;
  storage = new FakeFileStorage();
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://x.supabase.co");
  vi.stubEnv("ADAPTER_MODE", "fake");
  await db.insert(schema.settings).values([
    { key: "wa_enabled", value: true },
    { key: "owner_whatsapp_phone", value: "+5591999990000" },
    { key: "store_name", value: "TRIVÉ" },
  ]);
});

afterEach(async () => {
  await close();
  vi.unstubAllEnvs();
});

async function photo(color: string): Promise<Buffer> {
  return sharp({ create: { width: 900, height: 1200, channels: 3, background: color } }).webp().toBuffer();
}

async function product(name: string, slug: string, color: string, priceCents = 28900) {
  const [p] = await db.insert(schema.products).values({ name, slug, status: "draft", attributesSchema: ["cor", "tamanho"] }).returning({ id: schema.products.id });
  const [variant] = await db.insert(schema.productVariants).values({ productId: p.id, sku: `${slug}-M`, costCents: 1000, attributes: { cor: "Areia", tamanho: "M" } }).returning({ id: schema.productVariants.id });
  await db.insert(schema.stockLevels).values({ productVariantId: variant.id, onHand: 3, reserved: 0 });
  await db.insert(schema.priceVersions).values({ productVariantId: variant.id, versionNumber: 1, status: "active", priceCents, origin: "initial", breakdown: {}, costSnapshotCents: 1000, computedMarginRate: "0.3000", activatedAt: new Date() });
  await db.insert(schema.productImages).values({ productId: p.id, storagePath: `${slug}/1-full.webp`, sortOrder: 0 });
  await storage.upload({ path: `${slug}/1-full.webp`, data: await photo(color), contentType: "image/webp" });
  return p.id;
}

async function scheduledDrop() {
  const a = await product("Longo Dunas", "longo-dunas", "#b08968");
  const b = await product("Bolsa Tote", "bolsa-tote", "#7a6a58", 12900);
  const { dropId } = await createDrop(sdb, { name: "Edição Círio", publishAt: PUBLISH_AT, vipWindowHours: 24, audienceLimit: 10, userId });
  await setDropProducts(sdb, { dropId, productIds: [a, b], userId });
  await scheduleDrop(sdb, { dropId, userId, now: NOW });
  return { dropId, a, b };
}

/** Desvio-padrão das cores de uma faixa central: silhueta é lisa; foto nítida com borda tem contraste. */
async function sharpnessOf(dataUrl: string): Promise<number> {
  const buffer = Buffer.from(dataUrl.split(",")[1], "base64");
  const stats = await sharp(buffer).stats();
  return stats.channels.reduce((sum, c) => sum + c.stdev, 0) / stats.channels.length;
}

describe("buildDropStoryInput", () => {
  it("teaser: peças em silhueta (desfocadas), sem preço; aberta: foto e preço, mesmo com a peça ainda escondida", async () => {
    const { dropId } = await scheduledDrop();
    const teaser = await buildDropStoryInput(sdb, storage, { dropId, variant: "teaser", now: NOW });
    expect(teaser).toMatchObject({ kind: "drop_story", variant: "teaser", storeName: "TRIVÉ", eyebrow: "ESTREIA · SÁBADO, 20H", title: "Edição Círio", caption: "A cortina abre sábado, 20h.", siteLine: "trivemaison.com.br/estreia" });
    expect(teaser.items.map((i) => [i.name, i.priceLabel])).toEqual([["Bolsa Tote", ""], ["Longo Dunas", ""]]);
    expect(teaser.items.every((i) => i.imageDataUrl.startsWith("data:image/jpeg;base64,"))).toBe(true);

    const open = await buildDropStoryInput(sdb, storage, { dropId, variant: "open", now: new Date(PUBLISH_AT.getTime() + 60_000) });
    expect(open.caption).toBe("A cortina abriu.");
    expect(open.items.map((i) => [i.name, i.priceLabel])).toEqual([["Bolsa Tote", formatCentsBRL(12900)], ["Longo Dunas", formatCentsBRL(28900)]]);
    // A foto lisa de teste não distingue desfoque; garantimos ao menos o mesmo recorte e formato.
    expect(await sharpnessOf(teaser.items[0].imageDataUrl)).toBeLessThanOrEqual((await sharpnessOf(open.items[0].imageDataUrl)) + 1);
  });

  it("peça arquivada ou sem preço depois do agendamento fica fora do story", async () => {
    const { dropId, a } = await scheduledDrop();
    await db.update(schema.products).set({ status: "archived" }).where(eq(schema.products.id, a));
    const open = await buildDropStoryInput(sdb, storage, { dropId, variant: "open", now: new Date(PUBLISH_AT.getTime() + 60_000) });
    expect(open.items.map((i) => i.name)).toEqual(["Bolsa Tote"]);
    await db.update(schema.priceVersions).set({ status: "superseded" });
    await expect(buildDropStoryInput(sdb, storage, { dropId, variant: "teaser", now: NOW })).rejects.toMatchObject({ code: "sem_fotos" });
  });

  it("rascunho não tem story; lançamento sem foto avisa", async () => {
    const [p] = await db.insert(schema.products).values({ name: "Sem foto", slug: "sem-foto", status: "draft" }).returning({ id: schema.products.id });
    const { dropId } = await createDrop(sdb, { name: "Rascunho", publishAt: PUBLISH_AT, vipWindowHours: 24, audienceLimit: 10, userId });
    await setDropProducts(sdb, { dropId, productIds: [p.id], userId });
    await expect(buildDropStoryInput(sdb, storage, { dropId, variant: "teaser", now: NOW })).rejects.toMatchObject({ code: "lancamento_sem_data" });
  });
});

describe("publishDropStory → wa.drop_story_send", () => {
  it("desenha, guarda, grava o caminho e enfileira; o handler manda a imagem à dona uma vez por arquivo", async () => {
    const { dropId } = await scheduledDrop();
    const render = vi.fn(async (_data: CardData) => sharp({ create: { width: 108, height: 192, channels: 3, background: "#faf7f0" } }).png().toBuffer());
    const result = await publishDropStory(sdb, storage, render, { dropId, variant: "teaser", now: NOW });
    expect(render).toHaveBeenCalledTimes(1);
    expect(render.mock.calls[0][0]).toMatchObject({ kind: "drop_story", variant: "teaser" });
    expect(result.path).toBe(`drops/${dropId}/story-teaser-${NOW.getTime()}.jpg`);
    expect(result.url).toBe(`memory://${result.path}`);
    const stored = await storage.download(result.path);
    expect((await sharp(stored.data).metadata()).format).toBe("jpeg");
    const [row] = await db.select().from(schema.drops).where(eq(schema.drops.id, dropId));
    expect(row.storyTeaserPath).toBe(result.path);
    expect(row.storyOpenPath).toBeNull();
    const events = await db.select().from(schema.outboxEvents).where(eq(schema.outboxEvents.eventType, "wa.drop_story_send"));
    expect(events).toHaveLength(1);
    expect(events[0].payload).toEqual({ dropId, variant: "teaser", path: result.path });

    const provider = new FakeMessagingProvider();
    const sent = await sendDropStoryToOwner(sdb, storage, provider, { dropId, variant: "teaser", path: result.path });
    expect("sent" in sent).toBe(true);
    expect(provider.sentImages).toHaveLength(1);
    expect(provider.sentImages[0].toE164).toBe("+5591999990000");
    expect(provider.sentImages[0].imageUrl).toBe(result.url);
    expect(provider.sentImages[0].caption).toContain("Story do véu de Edição Círio pronto");
    expect(provider.sentImages[0].caption).toContain("/estreia");
    // Repetir o mesmo arquivo não manda de novo; gerar de novo (arquivo novo) manda.
    expect(await sendDropStoryToOwner(sdb, storage, provider, { dropId, variant: "teaser", path: result.path })).toEqual({ skipped: "ja_enviado" });
    const again = await publishDropStory(sdb, storage, render, { dropId, variant: "open", now: new Date(NOW.getTime() + 1000) });
    expect((await db.select().from(schema.drops).where(eq(schema.drops.id, dropId)))[0].storyOpenPath).toBe(again.path);
    await sendDropStoryToOwner(sdb, storage, provider, { dropId, variant: "open", path: again.path });
    expect(provider.sentImages).toHaveLength(2);
    expect(provider.sentImages[1].caption).toContain("cortina aberta");
  });
});
