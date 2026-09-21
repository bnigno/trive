// Ensaio "foto no corpo" ponta a ponta com PGlite e fakes: o pedido valida
// antes de gastar (ligado, tipo com ensaio, foto real da cor, foto-base,
// cota) e enfileira um evento por opção; a opção gera, julga, acaba e grava
// (idempotente; reprovada tenta mais uma vez; portão indisponível não
// relança; vendor sem crédito vira falha, vendor instável volta à fila); a
// escolha vira product_images com origin 'ai' depois das reais e fora do
// índice de fotos; fotos-base: gerar, escolher, trocar, descartar; custo.
import { asc, eq, like } from "drizzle-orm";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AssistantUnavailableError } from "@/adapters/assistant";
import { FakeSalesAssistant } from "@/adapters/assistant/fake";
import { StudioUnavailableError } from "@/adapters/image-studio";
import { FakeImageStudio } from "@/adapters/image-studio/fake";
import { FakeFileStorage } from "@/adapters/storage/fake";
import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { addProductImage, type ServiceDb } from "@/services/catalog";
import { listIndexedPhotos } from "@/services/photo-match";
import {
  chooseStudioBasePhoto,
  chooseStudioCandidate,
  countStudioImagesToday,
  discardStudioBasePhoto,
  discardStudioCandidate,
  enqueueStudioBasePhotos,
  estimateStudioRequest,
  generateStudioBasePhotos,
  generateStudioOption,
  getChosenBasePhoto,
  listStudioBasePhotos,
  listStudioRequestsForProduct,
  loadStudioSettings,
  requestStudioPhotos,
  ServiceError,
  STUDIO_OPTION_EVENT,
  summarizeStudioCosts,
} from "@/services/studio";
import { createTestDb, FIXED_USER_ID, type TestDb } from "../helpers/db";

vi.mock("@/inngest/client", () => ({ inngest: { send: async () => ({ ids: [] }) } }));

const NOW = new Date("2026-09-22T13:00:00Z");
const BASE_KEYS = { modelKey: "modelo_a", sceneKey: "sala_clara", sizeKey: "M" } as const;

let db: TestDb;
let sdb: DbOrTx;
let close: () => Promise<void>;
let studio: FakeImageStudio;
let assistant: FakeSalesAssistant;
let storage: FakeFileStorage;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  sdb = db as unknown as DbOrTx;
  studio = new FakeImageStudio();
  assistant = new FakeSalesAssistant();
  storage = new FakeFileStorage();
  vi.stubEnv("ADAPTER_MODE", "fake");
  vi.spyOn(console, "info").mockImplementation(() => {});
  await db.insert(schema.settings).values([
    { key: "ai_photos_enabled", value: true },
    { key: "ai_photos_daily_quota", value: 30 },
    { key: "ai_photos_quality", value: "economica" },
    { key: "ai_photos_default_scene", value: "sala_clara" },
    { key: "ai_photos_default_model", value: "modelo_a" },
    { key: "ai_photos_in_store", value: false },
  ]);
});

afterEach(async () => {
  await close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function photo(color: string, width = 600, height = 800): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: color } }).jpeg().toBuffer();
}

/** Peça publicada com eixo de cor, uma variação e (opcionalmente) uma foto real da cor. */
async function seedProduct(input: { pieceType?: string | null; withPhoto?: boolean; color?: string } = {}): Promise<string> {
  const color = input.color ?? "Areia";
  const [product] = await db
    .insert(schema.products)
    .values({ name: "Vestido Áurea", slug: `vestido-aurea-${Math.random().toString(36).slice(2, 7)}`, status: "active", attributesSchema: ["cor", "tamanho"], pieceType: input.pieceType === undefined ? "vestido" : input.pieceType })
    .returning({ id: schema.products.id });
  await db.insert(schema.productVariants).values({ productId: product.id, sku: `AUR-${Math.random().toString(36).slice(2, 6).toUpperCase()}`, attributes: { cor: color, tamanho: "M" } });
  if (input.withPhoto !== false) {
    await addProductImage(db as unknown as ServiceDb, storage, { productId: product.id, data: await photo("#b08968"), contentType: "image/jpeg", color, userId: FIXED_USER_ID });
  }
  return product.id;
}

async function seedBasePhoto(status: "chosen" | "candidate" = "chosen", keys = BASE_KEYS): Promise<string> {
  const path = `studio/models/${keys.modelKey}/${keys.sceneKey}-${keys.sizeKey}-test.jpg`;
  await storage.upload({ path, data: await photo("#a0a0a0", 900, 1200), contentType: "image/jpeg" });
  const [row] = await db
    .insert(schema.studioBasePhotos)
    .values({ ...keys, storagePath: path, status, vendor: "fake", vendorModel: "fake-model-create", credits: 3, usdCents: 23, createdAt: NOW, chosenAt: status === "chosen" ? NOW : null })
    .returning({ id: schema.studioBasePhotos.id });
  return row!.id;
}

const outbox = (eventType: string) => db.select().from(schema.outboxEvents).where(eq(schema.outboxEvents.eventType, eventType)).orderBy(asc(schema.outboxEvents.createdAt));
const audits = (action: string) => db.select().from(schema.auditLog).where(eq(schema.auditLog.action, action));

async function request(productId: string, options = 3) {
  return requestStudioPhotos(sdb, { productId, color: "Areia", ...BASE_KEYS, quality: "economica", options, userId: FIXED_USER_ID }, NOW);
}

async function runOption(requestId: string, optionNo: number, attempt = 0) {
  return generateStudioOption(sdb, { studio, assistant, storage }, { requestId, optionNo, attempt }, { now: () => NOW });
}

describe("requestStudioPhotos — valida antes de gastar", () => {
  it("desligado, acessório, sem foto real da cor, sem foto-base e cota do dia recusam com o motivo", async () => {
    const productId = await seedProduct();
    await db.update(schema.settings).set({ value: false }).where(eq(schema.settings.key, "ai_photos_enabled"));
    await expect(request(productId)).rejects.toMatchObject({ code: "desligado" });
    await db.update(schema.settings).set({ value: true }).where(eq(schema.settings.key, "ai_photos_enabled"));

    await expect(request(await seedProduct({ pieceType: "brinco" }))).rejects.toMatchObject({ code: "peca_sem_ensaio" });
    await expect(request(await seedProduct({ pieceType: null }))).rejects.toMatchObject({ code: "peca_sem_ensaio" });
    await expect(request(await seedProduct({ withPhoto: false }))).rejects.toMatchObject({ code: "sem_foto_real" });
    // Foto real de OUTRA cor não serve para o ensaio da cor pedida.
    await expect(request(await seedProduct({ color: "Terracota" }))).rejects.toMatchObject({ code: "sem_foto_real" });
    await expect(request(productId)).rejects.toMatchObject({ code: "sem_foto_base" });
    await seedBasePhoto("candidate");
    await expect(request(productId)).rejects.toMatchObject({ code: "sem_foto_base" });
    await seedBasePhoto("chosen");

    await db.update(schema.settings).set({ value: 4 }).where(eq(schema.settings.key, "ai_photos_daily_quota"));
    // As duas fotos-base de hoje já contam: 2 + 3 > 4, mas 2 + 2 cabe.
    await expect(request(productId)).rejects.toMatchObject({ code: "cota_do_dia" });
    expect(await request(productId, 2)).toMatchObject({ requestId: expect.any(String) });
    expect(await outbox(STUDIO_OPTION_EVENT)).toHaveLength(2);
  });

  it("cria o pedido, um evento por opção (dedupe por pedido+opção+tentativa) e o audit com a estimativa", async () => {
    const productId = await seedProduct();
    await seedBasePhoto();
    const created = await request(productId);
    expect(created.eventIds).toHaveLength(3);
    expect(created.estimate.totalUsdCents).toBe(38);
    const events = await outbox(STUDIO_OPTION_EVENT);
    expect(events.map((event) => event.dedupeKey)).toEqual([1, 2, 3].map((n) => `product.ai_photo:${created.requestId}:${n}:0`));
    expect(events[0]?.payload).toEqual({ requestId: created.requestId, optionNo: 1, attempt: 0 });
    expect(events[0]?.aggregateId).toBe(productId);
    const [row] = await db.select().from(schema.studioRequests).where(eq(schema.studioRequests.id, created.requestId));
    expect(row).toMatchObject({ status: "queued", color: "Areia", optionsWanted: 3, optionsDone: 0, quality: "economica", source: "admin", requestedBy: FIXED_USER_ID });
    const [audit] = await audits("studio.request");
    expect(audit?.after).toMatchObject({ productId, color: "Areia", options: 3, estimatedUsdCents: 38 });
    expect(await estimateStudioRequest(sdb)).toMatchObject({ quality: "economica", creditsPerImage: 1 });
    expect(await loadStudioSettings(sdb)).toEqual({ enabled: true, dailyQuota: 30, quality: "economica", defaultScene: "sala_clara", defaultModel: "modelo_a", inStore: false });
  });
});

describe("generateStudioOption — a opção de ponta a ponta", () => {
  it("gera, julga, acaba, guarda e fecha o pedido na última opção; o mesmo evento de novo não duplica", async () => {
    const productId = await seedProduct();
    await seedBasePhoto();
    const { requestId } = await request(productId);

    expect(await runOption(requestId, 1)).toMatchObject({ outcome: "passed", retryEnqueued: false });
    expect(await runOption(requestId, 1)).toEqual({ outcome: "skipped", reason: "ja_processada" });
    expect(await runOption(requestId, 2)).toMatchObject({ outcome: "passed" });
    let [row] = await db.select().from(schema.studioRequests).where(eq(schema.studioRequests.id, requestId));
    expect(row).toMatchObject({ status: "queued", optionsDone: 2 });
    expect(await runOption(requestId, 3)).toMatchObject({ outcome: "passed" });
    [row] = await db.select().from(schema.studioRequests).where(eq(schema.studioRequests.id, requestId));
    // 3 × (8 da geração + 3 do julgamento do fake).
    expect(row).toMatchObject({ status: "done", optionsDone: 3, usdCentsSpent: 33, finishedAt: NOW });

    const candidates = await db.select().from(schema.studioCandidates).where(eq(schema.studioCandidates.requestId, requestId)).orderBy(asc(schema.studioCandidates.optionNo));
    expect(candidates).toHaveLength(3);
    expect(candidates[0]).toMatchObject({ optionNo: 1, attempt: 0, status: "candidate", passed: true, score: 8, vendor: "fake", vendorModel: "fake-tryon", usdCents: 11, seed: 1100 });
    expect(candidates[0]?.storagePath).toBe(`studio/products/${productId}/${requestId}-1-0.jpg`);
    expect(storage.has(candidates[0]!.storagePath!)).toBe(true);
    const meta = await sharp(storage.get(candidates[0]!.storagePath!)!.data).metadata();
    expect(meta.format).toBe("jpeg");
    // O try-on recebeu a foto real da cor (rendição média) e a foto-base escolhida.
    expect(studio.generations).toHaveLength(3);
    expect(studio.generations[0]).toMatchObject({ category: "one-pieces", quality: "economica", count: 1, seed: 1100 });
    expect(studio.generations[0]?.model.mimeType).toBe("image/jpeg");
    // O portão viu duas imagens: a real e a gerada.
    expect(assistant.extractions[0]?.images).toHaveLength(2);
    expect(assistant.extractions[0]?.model).toBe("claude-sonnet-5");
    expect(await audits("studio.generate")).toHaveLength(3);
    expect((await audits("studio.judge"))[0]?.after).toMatchObject({ passed: true, summary: "8/10", estimatedCostUsdCents: 3 });
    // A cota conta as imagens pagas de hoje: 3 candidatas + 1 foto-base.
    expect(await countStudioImagesToday(sdb, NOW)).toBe(4);
    expect(await summarizeStudioCosts(sdb, { from: new Date("2026-09-22T00:00:00Z"), to: new Date("2026-09-23T00:00:00Z") })).toEqual({ images: 4, usdCents: 33 + 23 });
    const [view] = await listStudioRequestsForProduct(sdb, productId);
    expect(view?.candidates).toHaveLength(3);
  });

  it("reprovada pelo portão ganha UMA repetição (evento novo, semente nova); reprovada de novo, encerra a opção", async () => {
    const productId = await seedProduct();
    await seedBasePhoto();
    const { requestId } = await request(productId, 1);
    assistant.enqueueExtraction({ mesma_peca: true, cor_ok: true, estampa_ok: false, corte_ok: true, artefatos: ["mão com seis dedos"], nota: 4 });
    expect(await runOption(requestId, 1)).toMatchObject({ outcome: "rejected", retryEnqueued: true });
    const events = await outbox(STUDIO_OPTION_EVENT);
    expect(events.map((event) => event.dedupeKey)).toEqual([`product.ai_photo:${requestId}:1:0`, `product.ai_photo:${requestId}:1:1`]);
    let [row] = await db.select().from(schema.studioRequests).where(eq(schema.studioRequests.id, requestId));
    expect(row).toMatchObject({ status: "queued", optionsDone: 0, usdCentsSpent: 11 });
    const [rejected] = await db.select().from(schema.studioCandidates).where(eq(schema.studioCandidates.requestId, requestId));
    expect(rejected).toMatchObject({ status: "rejected", passed: false, score: 4 });
    expect((await audits("studio.judge"))[0]?.after).toMatchObject({ passed: false, summary: "4/10 — estampa, mão com seis dedos" });

    assistant.enqueueExtraction({ mesma_peca: false, cor_ok: true, estampa_ok: true, corte_ok: true, artefatos: [], nota: 3 });
    expect(await runOption(requestId, 1, 1)).toMatchObject({ outcome: "rejected", retryEnqueued: false });
    expect(await outbox(STUDIO_OPTION_EVENT)).toHaveLength(2);
    [row] = await db.select().from(schema.studioRequests).where(eq(schema.studioRequests.id, requestId));
    expect(row).toMatchObject({ status: "done", optionsDone: 1, usdCentsSpent: 22 });
    expect(studio.generations.map((generation) => generation.seed)).toEqual([1100, 1101]);
  });

  it("portão indisponível ou fora do formato não relança: a candidata fica 'sem julgamento' para a dona ver", async () => {
    const productId = await seedProduct();
    await seedBasePhoto();
    const { requestId } = await request(productId, 2);
    assistant.enqueueExtraction(new AssistantUnavailableError("API fora do ar", { retryable: true, reason: "instável (529)" }));
    expect(await runOption(requestId, 1)).toMatchObject({ outcome: "unjudged", retryEnqueued: false });
    assistant.enqueueExtraction({ nada: true });
    expect(await runOption(requestId, 2)).toMatchObject({ outcome: "unjudged" });
    const candidates = await db.select().from(schema.studioCandidates).where(eq(schema.studioCandidates.requestId, requestId)).orderBy(asc(schema.studioCandidates.optionNo));
    expect(candidates[0]).toMatchObject({ status: "candidate", passed: false, judgment: null, score: null, errorDetail: "portao_indisponivel: instável (529)", usdCents: 8 });
    expect(candidates[1]).toMatchObject({ status: "candidate", judgment: null, errorDetail: "portao_indisponivel: json_invalido" });
    const [row] = await db.select().from(schema.studioRequests).where(eq(schema.studioRequests.id, requestId));
    expect(row).toMatchObject({ status: "done", optionsDone: 2 });
  });

  it("vendor sem crédito vira candidata 'failed' e o pedido segue; vendor instável relança para a fila tentar de novo", async () => {
    const productId = await seedProduct();
    await seedBasePhoto();
    const { requestId } = await request(productId, 1);
    studio.failNext(new StudioUnavailableError("limite por minuto", "rate_limited", 429));
    await expect(runOption(requestId, 1)).rejects.toMatchObject({ reason: "rate_limited" });
    expect(await db.select().from(schema.studioCandidates)).toHaveLength(0);

    studio.failNext(new StudioUnavailableError("sem créditos", "no_credits", 402));
    expect(await runOption(requestId, 1)).toMatchObject({ outcome: "failed", reason: "no_credits: sem créditos" });
    const [candidate] = await db.select().from(schema.studioCandidates);
    expect(candidate).toMatchObject({ status: "failed", storagePath: null, errorDetail: "no_credits: sem créditos", usdCents: 0 });
    const [row] = await db.select().from(schema.studioRequests).where(eq(schema.studioRequests.id, requestId));
    expect(row).toMatchObject({ status: "done", optionsDone: 1, usdCentsSpent: 0 });
    // Pedido encerrado: evento atrasado não gera mais nada.
    expect(await runOption(requestId, 1, 1)).toEqual({ outcome: "skipped", reason: "pedido_encerrado" });
    expect(await runOption("00000000-0000-4000-8000-000000000099", 1)).toEqual({ outcome: "skipped", reason: "pedido_nao_encontrado" });
  });

  it("a foto-base escolhida ou a peça sumiram depois do pedido: a opção falha com o motivo, sem gastar", async () => {
    const productId = await seedProduct();
    const baseId = await seedBasePhoto();
    const { requestId } = await request(productId, 1);
    await discardStudioBasePhoto(sdb, { id: baseId, userId: FIXED_USER_ID });
    expect(await runOption(requestId, 1)).toMatchObject({ outcome: "failed", reason: "sem_foto_base" });
    expect(studio.generations).toHaveLength(0);

    await seedBasePhoto();
    const other = await seedProduct();
    const second = await request(other, 1);
    await db.update(schema.products).set({ deletedAt: NOW }).where(eq(schema.products.id, other));
    expect(await runOption(second.requestId, 1)).toMatchObject({ outcome: "failed", reason: "peca_nao_encontrada" });
    expect(studio.generations).toHaveLength(0);
  });
});

describe("chooseStudioCandidate — a escolha vira foto da peça", () => {
  it("origin 'ai', pareada à cor, depois das fotos reais, com card_refresh; fora do índice de fotos; idempotente", async () => {
    const productId = await seedProduct();
    await seedBasePhoto();
    const { requestId } = await request(productId, 1);
    await runOption(requestId, 1);
    const [candidate] = await db.select().from(schema.studioCandidates).where(eq(schema.studioCandidates.requestId, requestId));

    const chosen = await chooseStudioCandidate(sdb, storage, { candidateId: candidate!.id, userId: FIXED_USER_ID });
    expect(chosen.productId).toBe(productId);
    const images = await db.select().from(schema.productImages).where(eq(schema.productImages.productId, productId)).orderBy(asc(schema.productImages.sortOrder));
    expect(images).toHaveLength(2);
    expect(images[0]).toMatchObject({ origin: "upload", sortOrder: 0 });
    expect(images[1]).toMatchObject({ id: chosen.imageId, origin: "ai", color: "Areia", sortOrder: 1 });
    expect(images[1]?.phash).toBeTruthy();
    expect(storage.has(images[1]!.storagePath)).toBe(true);
    // O redesenho do post/story/carrossel está na fila (o da foto real, ainda
    // pendente, cobre a nova — addProductImage não duplica).
    const refresh = await db.select().from(schema.outboxEvents).where(like(schema.outboxEvents.dedupeKey, `product.card_refresh:${productId}:%`));
    expect(refresh.length).toBeGreaterThanOrEqual(1);
    expect(refresh.every((event) => event.status === "pending")).toBe(true);
    const [updated] = await db.select().from(schema.studioCandidates).where(eq(schema.studioCandidates.id, candidate!.id));
    expect(updated).toMatchObject({ status: "chosen", chosenImageId: chosen.imageId });
    expect((await audits("studio.choose"))[0]?.after).toMatchObject({ candidateId: candidate!.id, productId, color: "Areia" });
    // A foto de IA não entra na busca por foto da cliente.
    const indexed = await listIndexedPhotos(sdb);
    expect(indexed).toHaveLength(1);
    // Escolher de novo devolve a mesma foto, sem duplicar.
    expect(await chooseStudioCandidate(sdb, storage, { candidateId: candidate!.id, userId: FIXED_USER_ID })).toEqual(chosen);
    expect(await db.select().from(schema.productImages).where(eq(schema.productImages.productId, productId))).toHaveLength(2);
    await expect(discardStudioCandidate(sdb, { candidateId: candidate!.id, userId: FIXED_USER_ID })).rejects.toMatchObject({ code: "ja_escolhida" });
  });

  it("reprovada, descartada ou sem imagem não pode ser escolhida; descartar registra", async () => {
    const productId = await seedProduct();
    await seedBasePhoto();
    const { requestId } = await request(productId, 2);
    assistant.enqueueExtraction({ mesma_peca: true, cor_ok: false, estampa_ok: true, corte_ok: true, artefatos: [], nota: 5 });
    await runOption(requestId, 1);
    await runOption(requestId, 2);
    const candidates = await db.select().from(schema.studioCandidates).where(eq(schema.studioCandidates.requestId, requestId)).orderBy(asc(schema.studioCandidates.optionNo));
    await expect(chooseStudioCandidate(sdb, storage, { candidateId: candidates[0]!.id, userId: FIXED_USER_ID })).rejects.toMatchObject({ code: "candidata_indisponivel" });
    await discardStudioCandidate(sdb, { candidateId: candidates[1]!.id, userId: FIXED_USER_ID });
    await expect(chooseStudioCandidate(sdb, storage, { candidateId: candidates[1]!.id, userId: FIXED_USER_ID })).rejects.toMatchObject({ code: "candidata_indisponivel" });
    expect(await audits("studio.discard")).toHaveLength(1);
    await expect(chooseStudioCandidate(sdb, storage, { candidateId: "00000000-0000-4000-8000-000000000001", userId: FIXED_USER_ID })).rejects.toBeInstanceOf(ServiceError);
  });
});

describe("fotos-base das modelos da casa", () => {
  it("pede pela fila, gera N candidatas no Storage, escolhe uma por modelo × cena × corpo e troca sem perder a anterior", async () => {
    const eventId = await enqueueStudioBasePhotos(sdb, { ...BASE_KEYS, quality: "alta", count: 2, userId: FIXED_USER_ID }, NOW);
    expect(eventId).toBeTruthy();
    const [event] = await outbox("studio.base_photo");
    expect(event?.dedupeKey).toBe(`studio.base_photo:modelo_a:sala_clara:M:${NOW.getTime()}`);

    const result = await generateStudioBasePhotos(sdb, { studio, storage }, event!.payload, { now: () => NOW });
    expect(result).toMatchObject({ outcome: "generated" });
    const ids = (result as { ids: string[] }).ids;
    expect(ids).toHaveLength(2);
    expect(studio.modelPhotos[0]).toMatchObject({ aspectRatio: "3:4", count: 2, quality: "alta" });
    expect(studio.modelPhotos[0]?.prompt).toContain("Brazilian woman");
    const rows = await listStudioBasePhotos(sdb);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ ...BASE_KEYS, status: "candidate", vendor: "fake", credits: 3, usdCents: 23, createdBy: FIXED_USER_ID });
    expect(storage.has(rows[0]!.storagePath)).toBe(true);
    expect((await audits("studio.base_photo"))[0]?.after).toMatchObject({ count: 2, credits: 6, estimatedCostUsdCents: 46 });
    expect(await getChosenBasePhoto(sdb, BASE_KEYS)).toBeNull();

    await chooseStudioBasePhoto(sdb, { id: ids[0]!, userId: FIXED_USER_ID }, NOW);
    expect((await getChosenBasePhoto(sdb, BASE_KEYS))?.id).toBe(ids[0]);
    await chooseStudioBasePhoto(sdb, { id: ids[1]!, userId: FIXED_USER_ID }, NOW);
    expect((await getChosenBasePhoto(sdb, BASE_KEYS))?.id).toBe(ids[1]);
    const [previous] = await db.select().from(schema.studioBasePhotos).where(eq(schema.studioBasePhotos.id, ids[0]!));
    expect(previous).toMatchObject({ status: "candidate", chosenAt: null });
    // Escolher a já escolhida não muda nada; descartar a escolhida deixa o trio sem foto-base.
    await chooseStudioBasePhoto(sdb, { id: ids[1]!, userId: FIXED_USER_ID }, NOW);
    await discardStudioBasePhoto(sdb, { id: ids[1]!, userId: FIXED_USER_ID });
    expect(await getChosenBasePhoto(sdb, BASE_KEYS)).toBeNull();
    expect(await listStudioBasePhotos(sdb)).toHaveLength(1);
    await expect(chooseStudioBasePhoto(sdb, { id: ids[1]!, userId: FIXED_USER_ID }, NOW)).rejects.toMatchObject({ code: "nao_encontrada" });
    expect(await countStudioImagesToday(sdb, NOW)).toBe(2);
  });

  it("vendor sem crédito registra a falha e não relança; instável relança", async () => {
    const payload = { ...BASE_KEYS, quality: "economica", count: 1, userId: null };
    studio.failNext(new StudioUnavailableError("sem créditos", "no_credits", 402));
    expect(await generateStudioBasePhotos(sdb, { studio, storage }, payload, { now: () => NOW })).toEqual({ outcome: "failed", reason: "no_credits" });
    expect((await audits("studio.base_photo"))[0]?.after).toMatchObject({ failed: "no_credits" });
    studio.failNext(new StudioUnavailableError("fora do ar", "unavailable", 503));
    await expect(generateStudioBasePhotos(sdb, { studio, storage }, payload, { now: () => NOW })).rejects.toMatchObject({ reason: "unavailable" });
    expect(await db.select().from(schema.studioBasePhotos)).toHaveLength(0);
  });
});
