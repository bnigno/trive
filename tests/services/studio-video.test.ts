// "A peça se mexe" no estúdio, ponta a ponta com PGlite e fakes: o pedido
// valida antes de gastar (ligado, chave, foto ainda na peça, um vídeo por foto
// em andamento, teto de vídeos do dia, saldo) e grava vídeo + evento juntos;
// o handler envia UMA vez, grava o id do pedido, acompanha em rodadas com
// hora marcada e nunca pede de novo o que a FASHN pode ter aceitado; buscar
// de novo é pelo id; descartar apaga o arquivo; o custo entra na conta.
import { asc, eq } from "drizzle-orm";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StudioUnavailableError } from "@/adapters/image-studio";
import { FakeImageStudio } from "@/adapters/image-studio/fake";
import { FakeFileStorage } from "@/adapters/storage/fake";
import { VIDEO_TIMING } from "@/core/studio/video";
import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { addProductImage, type ServiceDb } from "@/services/catalog";
import { chooseStudioCandidate, summarizeStudioCosts } from "@/services/studio";
import {
  countStudioVideosToday,
  discardStudioVideo,
  listStudioVideoPanel,
  refetchStudioVideo,
  requestStudioVideo,
  STUDIO_VIDEO_EVENT,
  studioVideoStoragePath,
} from "@/services/studio-video";
import { generateStudioVideo, markStudioVideoGaveUp } from "@/services/studio-video-generate";
import { createTestDb, FIXED_USER_ID, type TestDb } from "../helpers/db";

vi.mock("@/inngest/client", () => ({ inngest: { send: async () => ({ ids: [] }) } }));

const NOW = new Date("2026-09-25T13:00:00Z");

let db: TestDb;
let sdb: DbOrTx;
let close: () => Promise<void>;
let studio: FakeImageStudio;
let storage: FakeFileStorage;
let clock: Date;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  sdb = db as unknown as DbOrTx;
  studio = new FakeImageStudio();
  storage = new FakeFileStorage();
  clock = NOW;
  vi.stubEnv("ADAPTER_MODE", "fake");
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await db.insert(schema.settings).values([
    { key: "ai_photos_enabled", value: true },
    { key: "ai_video_enabled", value: true },
    { key: "ai_video_daily_limit", value: 2 },
  ]);
});

afterEach(async () => {
  await close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function photo(color: string): Promise<Buffer> {
  return sharp({ create: { width: 600, height: 800, channels: 3, background: color } }).jpeg().toBuffer();
}

async function seedProduct(pieceType = "vestido"): Promise<string> {
  const [product] = await db
    .insert(schema.products)
    .values({ name: "Vestido Amora", slug: `vestido-amora-${Math.random().toString(36).slice(2, 7)}`, status: "active", attributesSchema: ["cor", "tamanho"], pieceType })
    .returning({ id: schema.products.id });
  await db.insert(schema.productVariants).values({ productId: product.id, sku: `AMO-${Math.random().toString(36).slice(2, 6).toUpperCase()}`, attributes: { cor: "Vinho", tamanho: "M" } });
  await addProductImage(db as unknown as ServiceDb, storage, { productId: product.id, data: await photo("#8a2b3a"), contentType: "image/jpeg", color: "Vinho", userId: FIXED_USER_ID });
  return product.id;
}

/** Uma foto no corpo já escolhida (virou foto da peça): é dela que sai o vídeo. */
async function seedChosenCandidate(productId: string, input: { choose?: boolean } = {}): Promise<string> {
  const [request] = await db
    .insert(schema.studioRequests)
    .values({ productId, color: "Vinho", sceneKey: "estudio", modelKey: "modelo_a", sizeKey: "M", quality: "alta", optionsWanted: 1, optionsDone: 1, status: "done" })
    .returning({ id: schema.studioRequests.id });
  const path = `studio/products/${productId}/${request!.id}-1-0.jpg`;
  await storage.upload({ path, data: await photo("#7a2432"), contentType: "image/jpeg" });
  const [candidate] = await db
    .insert(schema.studioCandidates)
    .values({ requestId: request!.id, optionNo: 1, storagePath: path, passed: true, status: "candidate", vendor: "fake", vendorModel: "fake-tryon", usdCents: 23, createdAt: NOW })
    .returning({ id: schema.studioCandidates.id });
  if (input.choose !== false) await chooseStudioCandidate(sdb, storage, { candidateId: candidate!.id, userId: FIXED_USER_ID });
  return candidate!.id;
}

const request = (candidateId: string) => requestStudioVideo(sdb, { studio, configured: true }, { candidateId, userId: FIXED_USER_ID }, clock);
const run = (videoId: string) => generateStudioVideo(sdb, { studio, storage }, { videoId }, { now: () => clock });
const videoRow = async (id: string) => (await db.select().from(schema.studioVideos).where(eq(schema.studioVideos.id, id)))[0]!;
const videoEvents = () => db.select().from(schema.outboxEvents).where(eq(schema.outboxEvents.eventType, STUDIO_VIDEO_EVENT)).orderBy(asc(schema.outboxEvents.createdAt));
const audits = (action: string) => db.select().from(schema.auditLog).where(eq(schema.auditLog.action, action));

describe("requestStudioVideo — valida antes de gastar", () => {
  it("grava o vídeo na fila, o evento de envio e o registro, com o movimento que proíbe mudar a peça", async () => {
    const productId = await seedProduct();
    const candidateId = await seedChosenCandidate(productId);
    const created = await request(candidateId);
    expect(created).toEqual({ videoId: expect.any(String), credits: 6, usdCents: 45 });

    const video = await videoRow(created.videoId);
    expect(video).toMatchObject({ productId, candidateId, status: "queued", durationSeconds: 5, resolution: "1080p", credits: 6, usdCents: 0, color: "Vinho", requestedBy: FIXED_USER_ID });
    expect(video.prompt).toContain("Keep the garment exactly as in the image");
    expect(video.sourceStoragePath).toMatch(/^studio\/products\/.+\.jpg$/);
    const events = await videoEvents();
    expect(events.map((event) => event.dedupeKey)).toEqual([`${STUDIO_VIDEO_EVENT}:${created.videoId}:submit`]);
    expect(events[0]!.payload).toEqual({ videoId: created.videoId });
    expect(await audits("studio.video_request")).toHaveLength(1);
  });

  it("desligado, sem chave, foto que não está na peça, peça apagada e vídeo em andamento recusam com o motivo", async () => {
    const productId = await seedProduct();
    const candidateId = await seedChosenCandidate(productId);

    await db.update(schema.settings).set({ value: false }).where(eq(schema.settings.key, "ai_video_enabled"));
    await expect(request(candidateId)).rejects.toMatchObject({ code: "video_desligado" });
    await db.update(schema.settings).set({ value: true }).where(eq(schema.settings.key, "ai_video_enabled"));

    await expect(requestStudioVideo(sdb, { studio, configured: false }, { candidateId, userId: FIXED_USER_ID }, clock)).rejects.toMatchObject({ code: "sem_chave" });

    // Candidata não escolhida, ou escolhida mas tirada da galeria (a foto saiu da peça).
    await expect(request(await seedChosenCandidate(productId, { choose: false }))).rejects.toMatchObject({ code: "foto_fora_da_peca" });
    const removed = await seedChosenCandidate(productId);
    const [chosen] = await db.select().from(schema.studioCandidates).where(eq(schema.studioCandidates.id, removed));
    await db.delete(schema.productImages).where(eq(schema.productImages.id, chosen!.chosenImageId!));
    await expect(request(removed)).rejects.toMatchObject({ code: "foto_fora_da_peca" });

    const deletedProduct = await seedProduct();
    const orphan = await seedChosenCandidate(deletedProduct);
    await db.update(schema.products).set({ deletedAt: NOW }).where(eq(schema.products.id, deletedProduct));
    await expect(request(orphan)).rejects.toMatchObject({ code: "nao_encontrado" });

    await request(candidateId);
    await expect(request(candidateId)).rejects.toMatchObject({ code: "video_em_andamento" });
    expect(await videoEvents()).toHaveLength(1);
  });

  it("o banco é o árbitro do clique duplo: um só vídeo em andamento por foto", async () => {
    const candidateId = await seedChosenCandidate(await seedProduct());
    const results = await Promise.allSettled([request(candidateId), request(candidateId)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await db.select().from(schema.studioVideos)).toHaveLength(1);
  });

  it("teto de vídeos do dia (falha sem cobrança não conta) e saldo da FASHN", async () => {
    const productId = await seedProduct();
    await db.update(schema.settings).set({ value: 1 }).where(eq(schema.settings.key, "ai_video_daily_limit"));
    const first = await request(await seedChosenCandidate(productId));
    // Falhou sem cobrança (recusa na entrada): libera o teto.
    studio.failNext(new StudioUnavailableError("sem crédito", "no_credits", 402));
    expect(await run(first.videoId)).toEqual({ outcome: "failed", reason: "no_credits" });
    expect(await countStudioVideosToday(sdb, clock)).toBe(0);

    const second = await request(await seedChosenCandidate(productId));
    expect(await countStudioVideosToday(sdb, clock)).toBe(1);
    await expect(request(await seedChosenCandidate(productId))).rejects.toMatchObject({ code: "teto_do_dia" });
    await run(second.videoId);

    // Dia seguinte (São Paulo): o teto libera; o saldo da FASHN ainda pode barrar.
    clock = new Date(NOW.getTime() + 24 * 3_600_000);
    studio.balance = 5;
    await expect(request(await seedChosenCandidate(productId))).rejects.toMatchObject({ code: "sem_saldo" });
    studio.balance = 6;
    expect(await request(await seedChosenCandidate(productId))).toMatchObject({ credits: 6 });
  });
});

describe("generateStudioVideo — envia uma vez, acompanha pelo id", () => {
  it("o fake termina na hora: MP4 guardado como vídeo, pronto, custo da tabela e o id do pedido", async () => {
    const productId = await seedProduct();
    const { videoId } = await request(await seedChosenCandidate(productId));
    const result = await run(videoId);
    const path = studioVideoStoragePath({ productId, videoId });
    expect(result).toEqual({ outcome: "done", storagePath: path, usdCents: 45 });

    const video = await videoRow(videoId);
    expect(video).toMatchObject({ status: "done", storagePath: path, credits: 6, usdCents: 45, vendor: "fake", vendorModel: "fake-image-to-video", errorDetail: null });
    expect(video.vendorJobId).toMatch(/^fake-video-1-/);
    expect(video.bytes).toBeGreaterThan(0);
    expect(video.submittedAt).toEqual(NOW);
    const file = await storage.download(path);
    expect(file.contentType).toBe("video/mp4");
    expect(file.data.subarray(4, 8).toString("latin1")).toBe("ftyp");
    expect(studio.animations[0]!.prompt).toContain("Keep the garment exactly as in the image");
    expect(await audits("studio.video_submit")).toHaveLength(1);
    expect(await audits("studio.video")).toHaveLength(1);

    // Evento repetido (retry, replay): nada muda, nada é pedido de novo.
    expect(await run(videoId)).toEqual({ outcome: "skipped", reason: "video_encerrado" });
    expect(studio.animations).toHaveLength(1);
  });

  it("aceito e ainda fazendo: grava o id, agenda a 1ª espera para 4 min depois; a rodada retoma pelo id (sem pedir de novo)", async () => {
    const { videoId } = await request(await seedChosenCandidate(await seedProduct()));
    studio.failAfterSubmitNext();
    const polling = await run(videoId);
    const submitted = await videoRow(videoId);
    expect(submitted.status).toBe("processing");
    expect(submitted.vendorJobId).toMatch(/^fake-video-1-/);
    expect(submitted.giveUpAt).toEqual(new Date(NOW.getTime() + VIDEO_TIMING.giveUpAfterMs));
    expect(polling).toEqual({ outcome: "polling", vendorJobId: submitted.vendorJobId, nextPollAt: new Date(NOW.getTime() + 240_000), polls: 1 });
    const events = await videoEvents();
    expect(events.map((event) => event.dedupeKey)).toEqual([`${STUDIO_VIDEO_EVENT}:${videoId}:submit`, `${STUDIO_VIDEO_EVENT}:${videoId}:poll:1`]);
    expect(events[1]!.nextAttemptAt).toEqual(new Date(NOW.getTime() + 240_000));

    // A rodada: retoma o MESMO pedido.
    clock = new Date(NOW.getTime() + 266_000);
    expect(await run(videoId)).toMatchObject({ outcome: "done" });
    expect(studio.animations).toHaveLength(2);
    expect(studio.animations[1]!.resumeJobId).toBe(submitted.vendorJobId);
    expect(studio.animations[1]!.onSubmitted).toBeUndefined();
    const done = await videoRow(videoId);
    expect(done).toMatchObject({ status: "done", vendorJobId: submitted.vendorJobId, elapsedMs: 266_000 });
  });

  it("rodadas seguintes a cada ~20 s; passou dos 30 min: 'demorou demais', o id fica e dá para buscar de novo sem pagar", async () => {
    const { videoId } = await request(await seedChosenCandidate(await seedProduct()));
    studio.failAfterSubmitNext();
    await run(videoId);
    clock = new Date(NOW.getTime() + 300_000);
    studio.failAfterSubmitNext();
    expect(await run(videoId)).toMatchObject({ outcome: "polling", polls: 2, nextPollAt: new Date(clock.getTime() + 20_000) });
    expect((await videoEvents()).map((event) => event.dedupeKey).at(-1)).toBe(`${STUDIO_VIDEO_EVENT}:${videoId}:poll:2`);

    clock = new Date(NOW.getTime() + VIDEO_TIMING.giveUpAfterMs - 5_000);
    studio.failAfterSubmitNext();
    expect(await run(videoId)).toEqual({ outcome: "failed", reason: "demorou_demais" });
    const failed = await videoRow(videoId);
    expect(failed).toMatchObject({ status: "failed", usdCents: 45 });
    expect(failed.errorDetail).toMatch(/^demorou_demais:/);
    expect(failed.vendorJobId).toMatch(/^fake-video-1-/);

    const panel = await listStudioVideoPanel(sdb, failed.productId, clock);
    expect(panel.videos[0]!.canRefetch).toBe(true);
    await refetchStudioVideo(sdb, { videoId, userId: FIXED_USER_ID }, clock);
    const refetching = await videoRow(videoId);
    expect(refetching).toMatchObject({ status: "processing", errorDetail: null, polls: 3 });
    expect((await videoEvents()).map((event) => event.dedupeKey).at(-1)).toBe(`${STUDIO_VIDEO_EVENT}:${videoId}:poll:3`);
    expect(await audits("studio.video_refetch")).toHaveLength(1);
    expect(await run(videoId)).toMatchObject({ outcome: "done" });
    // Nenhum pedido novo em toda a história: só o envio e as retomadas.
    expect(studio.animations.filter((call) => call.resumeJobId === undefined)).toHaveLength(1);
  });

  it("recusa na entrada (402/400) fecha sem cobrança; 429 na entrada volta à fila e relança", async () => {
    const productId = await seedProduct();
    const refused = await request(await seedChosenCandidate(productId));
    studio.failNext(new StudioUnavailableError("sem crédito", "no_credits", 402));
    expect(await run(refused.videoId)).toEqual({ outcome: "failed", reason: "no_credits" });
    expect(await videoRow(refused.videoId)).toMatchObject({ status: "failed", usdCents: 0, vendorJobId: null });

    const busy = await request(await seedChosenCandidate(productId));
    studio.failNext(new StudioUnavailableError("muitas chamadas", "rate_limited", 429));
    await expect(run(busy.videoId)).rejects.toMatchObject({ reason: "rate_limited" });
    expect(await videoRow(busy.videoId)).toMatchObject({ status: "queued", vendorJobId: null });
    // A fila tenta de novo: agora vai.
    expect(await run(busy.videoId)).toMatchObject({ outcome: "done" });
  });

  it("a resposta do envio não chegou (rede): 'envio incerto', custo estimado, e NUNCA pede de novo", async () => {
    const { videoId } = await request(await seedChosenCandidate(await seedProduct()));
    studio.failNext(new StudioUnavailableError("sem conexão", "network"));
    expect(await run(videoId)).toEqual({ outcome: "failed", reason: "envio_incerto" });
    expect(await videoRow(videoId)).toMatchObject({ status: "failed", usdCents: 45 });
    expect(await run(videoId)).toEqual({ outcome: "skipped", reason: "video_encerrado" });
    expect(studio.animations).toHaveLength(1);
  });

  it("vídeo parado em 'enviando' sem id (a invocação caiu no meio): 'envio incerto' sem chamar a FASHN", async () => {
    const { videoId } = await request(await seedChosenCandidate(await seedProduct()));
    await db.update(schema.studioVideos).set({ status: "submitting" }).where(eq(schema.studioVideos.id, videoId));
    expect(await run(videoId)).toEqual({ outcome: "failed", reason: "envio_incerto" });
    expect(studio.animations).toHaveLength(0);
  });

  it("depois de aceito: 'failed' no status fecha sem cobrança; 404 = o pedido sumiu", async () => {
    const productId = await seedProduct();
    const failed = await request(await seedChosenCandidate(productId));
    studio.failAfterSubmitNext(new StudioUnavailableError("recusou (ContentModerationError)", "rejected"));
    expect(await run(failed.videoId)).toEqual({ outcome: "failed", reason: "rejected" });
    expect(await videoRow(failed.videoId)).toMatchObject({ status: "failed", usdCents: 0 });

    const gone = await request(await seedChosenCandidate(productId));
    studio.failAfterSubmitNext(new StudioUnavailableError("HTTP 404 (NotFound)", "rejected", 404));
    expect(await run(gone.videoId)).toEqual({ outcome: "failed", reason: "pedido_sumiu" });
    expect((await videoRow(gone.videoId)).errorDetail).toMatch(/^pedido_sumiu:/);
  });

  it("desligado com o vídeo ainda na fila: não envia; peça apagada: não envia", async () => {
    const productId = await seedProduct();
    const queued = await request(await seedChosenCandidate(productId));
    await db.update(schema.settings).set({ value: false }).where(eq(schema.settings.key, "ai_video_enabled"));
    expect(await run(queued.videoId)).toEqual({ outcome: "failed", reason: "video_desligado" });
    await db.update(schema.settings).set({ value: true }).where(eq(schema.settings.key, "ai_video_enabled"));

    const orphan = await request(await seedChosenCandidate(productId));
    await db.update(schema.products).set({ deletedAt: NOW }).where(eq(schema.products.id, productId));
    expect(await run(orphan.videoId)).toEqual({ outcome: "failed", reason: "peca_nao_encontrada" });
    expect(studio.animations).toHaveLength(0);
  });

  it("pronto mas o Storage recusou o MP4: relança (a fila retoma pelo id); na última tentativa vira 'não salvou', buscável", async () => {
    const { videoId } = await request(await seedChosenCandidate(await seedProduct()));
    storage.rejectedContentTypes.add("video/mp4");
    await expect(run(videoId)).rejects.toThrow(/video\/mp4/);
    const pending = await videoRow(videoId);
    expect(pending.status).toBe("processing");
    expect(pending.vendorJobId).toMatch(/^fake-video-1-/);

    await markStudioVideoGaveUp(sdb, { videoId, error: new Error("mime type video/mp4 is not supported") }, clock);
    const gaveUp = await videoRow(videoId);
    expect(gaveUp).toMatchObject({ status: "failed", usdCents: 45 });
    expect(gaveUp.errorDetail).toMatch(/^nao_salvou:/);
    const panel = await listStudioVideoPanel(sdb, gaveUp.productId, clock);
    expect(panel.videos[0]!.canRefetch).toBe(true);

    storage.rejectedContentTypes.delete("video/mp4");
    await refetchStudioVideo(sdb, { videoId, userId: FIXED_USER_ID }, clock);
    expect(await run(videoId)).toMatchObject({ outcome: "done" });
    expect(studio.animations.filter((call) => call.resumeJobId === undefined)).toHaveLength(1);
  });
});

describe("descartar, painel e custo", () => {
  it("descartar tira da lista e apaga o arquivo; em andamento não descarta; o custo fica no histórico", async () => {
    const productId = await seedProduct();
    const candidateId = await seedChosenCandidate(productId);
    const { videoId } = await request(candidateId);

    let panel = await listStudioVideoPanel(sdb, productId, clock);
    expect(panel.inFlight).toBe(true);
    expect(panel.sources.map((source) => source.candidateId)).toEqual([candidateId]);
    expect(panel.estimate).toEqual({ credits: 6, usdCents: 45, brlCents: 248 });
    await expect(discardStudioVideo(sdb, storage, { videoId, userId: FIXED_USER_ID })).rejects.toMatchObject({ code: "video_em_andamento" });

    await run(videoId);
    const path = studioVideoStoragePath({ productId, videoId });
    await discardStudioVideo(sdb, storage, { videoId, userId: FIXED_USER_ID });
    await expect(storage.download(path)).rejects.toThrow();
    expect(await videoRow(videoId)).toMatchObject({ status: "discarded", usdCents: 45 });
    panel = await listStudioVideoPanel(sdb, productId, clock);
    expect(panel.videos).toHaveLength(0);
    expect(panel.inFlight).toBe(false);
    // Descartar de novo não faz nada; descartado conta no teto (foi pago).
    await discardStudioVideo(sdb, storage, { videoId, userId: FIXED_USER_ID });
    expect(await countStudioVideosToday(sdb, clock)).toBe(1);
    expect(await audits("studio.video_discard")).toHaveLength(1);

    const summary = await summarizeStudioCosts(sdb, { from: new Date(NOW.getTime() - 3_600_000), to: new Date(NOW.getTime() + 3_600_000) });
    expect(summary).toEqual({ images: 1, videos: 1, usdCents: 23 + 45 });
  });

  it("buscar de novo só quando dá: pronto, sem id ou ainda andando recusam", async () => {
    const { videoId } = await request(await seedChosenCandidate(await seedProduct()));
    await expect(refetchStudioVideo(sdb, { videoId, userId: FIXED_USER_ID }, clock)).rejects.toMatchObject({ code: "nao_da_para_buscar" });
    await run(videoId);
    await expect(refetchStudioVideo(sdb, { videoId, userId: FIXED_USER_ID }, clock)).rejects.toMatchObject({ code: "nao_da_para_buscar" });
  });
});
