// identificar_peca_na_foto ponta a ponta com PGlite e fakes: a impressão
// digital acha a peça sem chamar o modelo; sem acerto, a comparação visual
// com candidatas (fake do assistente) responde "provavelmente"; interruptor,
// falta de foto, foto de turno anterior, prazo estourado, ensaio e o que
// fica gravado em media_meta.
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeSalesAssistant } from "@/adapters/assistant/fake";
import { FakeFileStorage } from "@/adapters/storage/fake";
import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { imagePhash } from "@/services/image-fingerprint";
import { findProductsByPhotoHash, listIndexedPhotos } from "@/services/photo-match";
import { buildToolExecutor } from "@/services/wa-bot";
import { createTestDb, type TestDb } from "../helpers/db";

const PHONE = "+5511999990000";
const NOW = new Date("2026-09-20T17:31:45Z");

let db: TestDb;
let sdb: DbOrTx;
let close: () => Promise<void>;
let assistant: FakeSalesAssistant;
let storage: FakeFileStorage;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  sdb = db as unknown as DbOrTx;
  assistant = new FakeSalesAssistant();
  storage = new FakeFileStorage();
  vi.stubEnv("ADAPTER_MODE", "fake");
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  await close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/**
 * Uma "foto" sintética por peça: mosaico 6 × 8 de tons de cinza sorteados por
 * `seed` (gerador determinístico). Mosaicos de seeds diferentes ficam a ~32
 * bits um do outro, como fotos reais de peças diferentes; o mesmo mosaico
 * reencodado/menor fica a poucos bits.
 */
function scene(seed: number, width = 1200, height = 1600): string {
  let state = seed * 2654435761 + 12345;
  const next = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
  const cols = 6;
  const rows = 8;
  const tiles: string[] = [];
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      const gray = Math.round(40 + next() * 200).toString(16).padStart(2, "0");
      tiles.push(`<rect x="${(x * width) / cols}" y="${(y * height) / rows}" width="${width / cols + 1}" height="${height / rows + 1}" fill="#${gray}${gray}${gray}"/>`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${tiles.join("")}</svg>`;
}

async function webp(svg: string, width?: number): Promise<Buffer> {
  const image = sharp(Buffer.from(svg));
  return (width ? image.resize(width) : image).webp().toBuffer();
}

/** Peça pública com uma foto no Storage (full + thumb) e a impressão digital gravada, como addProductImage faria. */
async function seedProduct(input: { name: string; slug: string; seed: number; color?: string; status?: "active" | "archived"; phash?: string | null }): Promise<{ productId: string; phash: string }> {
  const [product] = await db
    .insert(schema.products)
    .values({ name: input.name, slug: input.slug, status: input.status ?? "active", attributesSchema: ["cor", "tamanho"] })
    .returning({ id: schema.products.id });
  const [variant] = await db
    .insert(schema.productVariants)
    .values({ productId: product.id, sku: `${input.slug.toUpperCase()}-M`, attributes: { cor: input.color ?? "Preto", tamanho: "M" }, costCents: 100 })
    .returning({ id: schema.productVariants.id });
  await db.insert(schema.stockLevels).values({ productVariantId: variant.id, onHand: 5, reserved: 0 });
  await db.insert(schema.priceVersions).values({ productVariantId: variant.id, versionNumber: 1, status: "active", priceCents: 5999, origin: "initial", breakdown: {}, costSnapshotCents: 100, computedMarginRate: "0.3000", activatedAt: NOW });
  const full = await webp(scene(input.seed));
  const path = `products/${product.id}/foto-full.webp`;
  await storage.upload({ path, data: full, contentType: "image/webp" });
  await storage.upload({ path: path.replace("-full.webp", "-thumb.webp"), data: await webp(scene(input.seed), 400), contentType: "image/webp" });
  const phash = (await imagePhash(full))!;
  await db.insert(schema.productImages).values({ productId: product.id, storagePath: path, color: input.color ?? "Preto", sortOrder: 0, phash: input.phash === undefined ? phash : input.phash });
  return { productId: product.id, phash };
}

async function seedConversationWithPhoto(): Promise<{ conversationId: string; waMessageId: string }> {
  const [conversation] = await db.insert(schema.waConversations).values({ phoneE164: PHONE, status: "open" }).returning({ id: schema.waConversations.id });
  const [message] = await db
    .insert(schema.waMessages)
    .values({ conversationId: conversation.id, direction: "inbound", kind: "image", body: "[a cliente enviou uma foto]", mediaUrl: "https://zapi.example/foto.jpg", mediaMeta: { mimeType: "image/jpeg", width: 1086, height: 1448 }, status: "delivered", zapiMessageId: `IMG-${Math.random().toString(36).slice(2, 8)}` })
    .returning({ id: schema.waMessages.id });
  return { conversationId: conversation.id, waMessageId: message.id };
}

/** A foto da cliente como o turno a entrega: a mesma cena reencodada em JPEG menor (o que ela repassou do Instagram). */
async function customerPhoto(seed: number): Promise<{ image: { mediaType: "image/jpeg"; base64: string }; phash: string }> {
  const jpeg = await sharp(Buffer.from(scene(seed))).resize(1086).jpeg({ quality: 75 }).toBuffer();
  return { image: { mediaType: "image/jpeg", base64: jpeg.toString("base64") }, phash: (await imagePhash(jpeg))! };
}

function executorFor(conversationId: string, opts: { recentImages?: Parameters<typeof buildToolExecutor>[1]["recentImages"]; dryRun?: boolean; withVision?: boolean; deadlineAt?: Date; copilot?: boolean } = {}) {
  return buildToolExecutor(sdb, {
    conversationId,
    phoneE164: PHONE,
    customerId: null,
    lastInboundId: "00000000-0000-4000-8000-00000000feed",
    now: NOW,
    ...(opts.recentImages ? { recentImages: opts.recentImages } : {}),
    ...(opts.dryRun ? { dryRun: true } : {}),
    ...(opts.copilot ? { copilot: true } : {}),
    ...(opts.withVision === false ? {} : { photoMatch: { assistant, storage, deadlineAt: opts.deadlineAt ?? new Date(NOW.getTime() + 30_000) } }),
  });
}

async function mediaMetaOf(waMessageId: string): Promise<Record<string, unknown>> {
  const [row] = await db.select({ mediaMeta: schema.waMessages.mediaMeta }).from(schema.waMessages).where(eq(schema.waMessages.id, waMessageId));
  return (row?.mediaMeta ?? {}) as Record<string, unknown>;
}

describe("índice de impressões digitais", () => {
  it("só peças públicas com phash entram; a foto repassada bate na peça certa e em nenhuma outra", async () => {
    await seedProduct({ name: "Blusa Maelle", slug: "blusa-maelle", seed: 1, color: "Preto/marshmellow" });
    await seedProduct({ name: "Vestido Alba", slug: "vestido-alba", seed: 2 });
    await seedProduct({ name: "Blusa Belle (antiga)", slug: "blusa-belle", seed: 1, status: "archived" });
    await seedProduct({ name: "Sem hash", slug: "sem-hash", seed: 3, phash: null });
    expect((await listIndexedPhotos(sdb)).map((p) => p.slug).sort()).toEqual(["blusa-maelle", "vestido-alba"]);

    const { phash } = await customerPhoto(1);
    const ranked = await findProductsByPhotoHash(sdb, phash);
    expect(ranked.map((m) => [m.slug, m.tier])).toEqual([["blusa-maelle", "exact"]]);
    expect(ranked[0].distance).toBeLessThanOrEqual(3);
    expect(ranked[0].colors).toEqual(["Preto/marshmellow"]);
    expect(await findProductsByPhotoHash(sdb, "não-é-hex")).toEqual([]);
  });
});

describe("identificar_peca_na_foto", () => {
  it("camada 1: a foto da loja repassada é reconhecida pelo hash, sem chamar o modelo; media_meta guarda o reconhecimento (nunca a foto)", async () => {
    await seedProduct({ name: "Blusa Maelle", slug: "blusa-maelle", seed: 1, color: "Preto/marshmellow" });
    await seedProduct({ name: "Vestido Alba", slug: "vestido-alba", seed: 2 });
    const { conversationId, waMessageId } = await seedConversationWithPhoto();
    const photo = await customerPhoto(1);
    const executor = executorFor(conversationId, { recentImages: [{ waMessageId, mediaUrl: "https://zapi.example/foto.jpg", phash: photo.phash, image: photo.image }] });

    const result = await executor("identificar_peca_na_foto", { categoria: "blusa", cor: "preto" });
    expect(result.ok).toBe(true);
    expect(result.text).toContain("Reconheci na foto: Blusa Maelle (slug blusa-maelle; fotos nas cores Preto/marshmellow)");
    expect(result.text).toContain("[reconhecimento exato]");
    expect(assistant.extractions).toHaveLength(0);

    const meta = await mediaMetaOf(waMessageId);
    expect(meta).toMatchObject({ mimeType: "image/jpeg", width: 1086, reconhecido: { slugs: ["blusa-maelle"], nomes: ["Blusa Maelle"], camada: "hash" } });
    expect(JSON.stringify(meta)).not.toContain("base64");
  });

  it("camada 2: hash não bate → o modelo compara com as candidatas (foto + miniaturas) e responde 'provavelmente'; recebe o bot_model e um signal", async () => {
    await seedProduct({ name: "Blusa Maelle", slug: "blusa-maelle", seed: 1 });
    await seedProduct({ name: "Blusa Aurélie", slug: "blusa-aurelie", seed: 2 });
    await db.insert(schema.settings).values({ key: "bot_model", value: "claude-haiku-4-5" });
    const { conversationId, waMessageId } = await seedConversationWithPhoto();
    // Uma foto que não é nenhuma do catálogo (cena 4: outro enquadramento).
    const photo = await customerPhoto(4);
    assistant.enqueueExtraction({ matches: [{ slug: "blusa-maelle", confidence: 0.9, color: "preto" }, { slug: "blusa-aurelie", confidence: 0.2, color: null }] });
    const executor = executorFor(conversationId, { recentImages: [{ waMessageId, mediaUrl: "https://zapi.example/foto.jpg", phash: photo.phash, image: photo.image }] });

    const result = await executor("identificar_peca_na_foto", { categoria: "blusa" });
    expect(result.ok).toBe(true);
    expect(result.text).toContain("Provavelmente é Blusa Maelle (slug blusa-maelle; na cor preto)");
    expect(result.text).toContain("[reconhecimento provável]");

    expect(assistant.extractions).toHaveLength(1);
    const sent = assistant.extractions[0];
    expect(sent.model).toBe("claude-haiku-4-5");
    expect(sent.images).toHaveLength(3);
    expect(sent.images[0]).toEqual(photo.image);
    expect(sent.images[1].mediaType).toBe("image/webp");
    expect(sent.userText).toContain("Imagem 2: ");
    expect(sent.userText).toMatch(/blusa-maelle — Blusa Maelle|blusa-aurelie — Blusa Aurélie/);
    expect(sent.jsonSchema).toMatchObject({ type: "object" });
    expect(sent.signal).toBeInstanceOf(AbortSignal);
    expect(sent.signal?.aborted).toBe(false);
    expect(await mediaMetaOf(waMessageId)).toMatchObject({ reconhecido: { slugs: ["blusa-maelle"], camada: "visao", confianca: 0.9 } });
  });

  it("modelo diz que nenhuma é a mesma → ok false com o caminho das parecidas; sem bot_model usa o padrão", async () => {
    await seedProduct({ name: "Blusa Maelle", slug: "blusa-maelle", seed: 1 });
    const { conversationId, waMessageId } = await seedConversationWithPhoto();
    const photo = await customerPhoto(4);
    const executor = executorFor(conversationId, { recentImages: [{ waMessageId, mediaUrl: "https://zapi.example/foto.jpg", phash: photo.phash, image: photo.image }] });
    const result = await executor("identificar_peca_na_foto", {});
    expect(result.ok).toBe(false);
    expect(result.text).toContain("Não reconheci nenhuma peça do catálogo");
    expect(result.text).toContain("listar_produtos (categoria + cor)");
    expect(assistant.extractions[0].model).toBe("claude-sonnet-5");
    expect(await mediaMetaOf(waMessageId)).not.toHaveProperty("reconhecido");
  });

  it("interruptor desligado: ok false sem tocar no índice nem no modelo", async () => {
    await db.insert(schema.settings).values({ key: "bot_photo_match_enabled", value: false });
    await seedProduct({ name: "Blusa Maelle", slug: "blusa-maelle", seed: 1 });
    const { conversationId, waMessageId } = await seedConversationWithPhoto();
    const photo = await customerPhoto(1);
    const executor = executorFor(conversationId, { recentImages: [{ waMessageId, mediaUrl: "https://zapi.example/foto.jpg", phash: photo.phash, image: photo.image }] });
    const result = await executor("identificar_peca_na_foto", {});
    expect(result.ok).toBe(false);
    expect(result.text).toContain("está desligado");
    expect(assistant.extractions).toHaveLength(0);
  });

  it("sem foto recente pede a foto; índice fora da faixa avisa quantas há", async () => {
    const { conversationId, waMessageId } = await seedConversationWithPhoto();
    expect(await executorFor(conversationId).call(null, "identificar_peca_na_foto", {})).toMatchObject({ ok: false, text: expect.stringContaining("Não há foto recente") });
    const photo = await customerPhoto(1);
    const executor = executorFor(conversationId, { recentImages: [{ waMessageId, mediaUrl: "u", phash: photo.phash, image: photo.image }, { waMessageId, mediaUrl: "v", phash: photo.phash, image: photo.image }] });
    expect(await executor("identificar_peca_na_foto", { foto: 3 })).toMatchObject({ ok: false, text: "Ela mandou 2 fotos recentes: passe foto entre 1 e 2." });
  });

  it("várias peças públicas com a mesma foto → 'mais de uma peça'; peça arquivada com a mesma foto não conta", async () => {
    await seedProduct({ name: "Vestido Dafne", slug: "vestido-dafne", seed: 5 });
    await seedProduct({ name: "Vestido Serena", slug: "vestido-serena", seed: 5 });
    await seedProduct({ name: "Vestido Velho", slug: "vestido-velho", seed: 5, status: "archived" });
    const { conversationId, waMessageId } = await seedConversationWithPhoto();
    const photo = await customerPhoto(5);
    const result = await executorFor(conversationId, { recentImages: [{ waMessageId, mediaUrl: "u", phash: photo.phash, image: photo.image }] })("identificar_peca_na_foto", {});
    expect(result.ok).toBe(true);
    expect(result.text).toContain("Reconheci mais de uma peça na foto");
    expect(result.text).toContain("Vestido Dafne");
    expect(result.text).toContain("Vestido Serena");
    expect(result.text).not.toContain("Vestido Velho");
  });

  it("foto de turno anterior (só o hash, sem bytes): camada 1 funciona; sem acerto, a visão não roda e o texto explica", async () => {
    await seedProduct({ name: "Blusa Maelle", slug: "blusa-maelle", seed: 1 });
    const { conversationId, waMessageId } = await seedConversationWithPhoto();
    const same = await customerPhoto(1);
    const hit = await executorFor(conversationId, { recentImages: [{ waMessageId, mediaUrl: "u", phash: same.phash }] })("identificar_peca_na_foto", {});
    expect(hit.ok).toBe(true);
    expect(hit.text).toContain("Blusa Maelle");

    const other = await customerPhoto(4);
    const miss = await executorFor(conversationId, { recentImages: [{ waMessageId, mediaUrl: "u", phash: other.phash }] })("identificar_peca_na_foto", {});
    expect(miss.ok).toBe(false);
    expect(miss.text).toContain("[foto de um turno anterior");
    expect(assistant.extractions).toHaveLength(0);
  });

  it("prazo do turno quase no fim: pula a comparação visual e diz por quê; sem as dependências (ensaio antigo) idem, sem marcador", async () => {
    await seedProduct({ name: "Blusa Maelle", slug: "blusa-maelle", seed: 1 });
    const { conversationId, waMessageId } = await seedConversationWithPhoto();
    const photo = await customerPhoto(4);
    const late = await executorFor(conversationId, { recentImages: [{ waMessageId, mediaUrl: "u", phash: photo.phash, image: photo.image }], deadlineAt: new Date(NOW.getTime() + 3_000) })("identificar_peca_na_foto", {});
    expect(late.ok).toBe(false);
    expect(late.text).toContain("[sem tempo para a comparação visual neste turno]");
    const noDeps = await executorFor(conversationId, { recentImages: [{ waMessageId, mediaUrl: "u", phash: photo.phash, image: photo.image }], withVision: false })("identificar_peca_na_foto", {});
    expect(noDeps.ok).toBe(false);
    expect(noDeps.text).not.toContain("[");
    expect(assistant.extractions).toHaveLength(0);
  });

  it("modelo fora do ar ou resposta torta: ok false com o aviso de falha, sem derrubar o turno", async () => {
    await seedProduct({ name: "Blusa Maelle", slug: "blusa-maelle", seed: 1 });
    const { conversationId, waMessageId } = await seedConversationWithPhoto();
    const photo = await customerPhoto(4);
    const recentImages = [{ waMessageId, mediaUrl: "u", phash: photo.phash, image: photo.image }];
    assistant.enqueueExtraction(new Error("boom"));
    const down = await executorFor(conversationId, { recentImages })("identificar_peca_na_foto", {});
    expect(down).toMatchObject({ ok: false, text: expect.stringContaining("[a comparação visual falhou agora]") });
    assistant.enqueueExtraction({ nada: true });
    const torta = await executorFor(conversationId, { recentImages })("identificar_peca_na_foto", {});
    expect(torta).toMatchObject({ ok: false, text: expect.stringContaining("[a comparação visual falhou agora]") });
  });

  it("ensaio (dryRun): reconhece, mas não grava media_meta; copiloto roda normal", async () => {
    await seedProduct({ name: "Blusa Maelle", slug: "blusa-maelle", seed: 1 });
    const { conversationId, waMessageId } = await seedConversationWithPhoto();
    const photo = await customerPhoto(1);
    const recentImages = [{ waMessageId, mediaUrl: "u", phash: photo.phash, image: photo.image }];
    const rehearsal = await executorFor(conversationId, { recentImages, dryRun: true })("identificar_peca_na_foto", {});
    expect(rehearsal.ok).toBe(true);
    expect(await mediaMetaOf(waMessageId)).not.toHaveProperty("reconhecido");
    const copilot = await executorFor(conversationId, { recentImages, copilot: true })("identificar_peca_na_foto", {});
    expect(copilot.ok).toBe(true);
    expect(copilot.text).toContain("Blusa Maelle");
  });
});
