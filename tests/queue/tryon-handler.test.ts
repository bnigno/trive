// "Me vê com ela" — a fila da prévia (wa.tryon) com as dependências fake:
// checa a foto antes de gastar, pede à FASHN UMA vez (o id fica gravado e a
// retomada é sempre por ele), passa pelos dois portões e envia a prévia
// EMBUTIDA — nada vai ao Storage, nada fica na conversa além da legenda.
// Cada caminho de falha avisa a cliente (com dedupe) antes de encerrar.
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AssistantUnavailableError } from "@/adapters/assistant";
import { FakeSalesAssistant, FAKE_TRYON_GARMENT_JSON } from "@/adapters/assistant/fake";
import { StudioUnavailableError } from "@/adapters/image-studio";
import { FakeImageStudio } from "@/adapters/image-studio/fake";
import { FakeFileStorage } from "@/adapters/storage/fake";
import { FakeMessagingProvider } from "@/adapters/zapi/fake";
import { HandlerOutOfTimeError } from "@/core/queue/handler-errors";
import { buildCustomerTryOnPrompt } from "@/core/studio/prompts";
import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { outboxHandlers } from "@/queue/handlers";
import { runTryOn } from "@/queue/handlers/tryon";
import { TRYON_EVENT } from "@/services/tryon";
import { createTestDb, type TestDb } from "../helpers/db";

vi.mock("@/inngest/client", () => ({ inngest: { send: async () => ({ ids: [] }) } }));

const NOW = new Date("2026-10-13T15:00:00Z");
const PHONE = "+5591988887777";
const OWNER = "+5591999990000";
const PHOTO_URL = "https://zapi.example/media/foto-dela.jpg";
const GARMENT_FULL = "products/amora/foto-full.webp";
const GARMENT_MD = "products/amora/foto-md.webp";

let db: TestDb;
let close: () => Promise<void>;
let studio: FakeImageStudio;
let assistant: FakeSalesAssistant;
let provider: FakeMessagingProvider;
let storage: FakeFileStorage;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  studio = new FakeImageStudio();
  assistant = new FakeSalesAssistant();
  provider = new FakeMessagingProvider();
  storage = new FakeFileStorage();
  vi.stubEnv("ADAPTER_MODE", "fake");
  vi.spyOn(console, "info").mockImplementation(() => {});
  await db.insert(schema.settings).values([
    { key: "wa_enabled", value: true },
    { key: "tryon_enabled", value: true },
    { key: "tryon_per_customer_daily", value: 2 },
    { key: "tryon_daily_total", value: 20 },
    { key: "owner_whatsapp_phone", value: OWNER },
  ]);
});

afterEach(async () => {
  await close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const sdb = () => db as unknown as DbOrTx;
const deps = () => ({ db: sdb(), studio, assistant, provider, storage, now: () => NOW });
const event = (requestId: string, attempts = 0, deadlineAt?: Date) => ({
  id: "evt-1",
  eventType: TRYON_EVENT,
  payload: { requestId },
  attempts,
  ...(deadlineAt ? { deadlineAt } : {}),
});

async function jpeg(color: string, width = 600, height = 800): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: color } }).jpeg().toBuffer();
}

/** Vestido com foto real, a conversa da Ana, a foto dela e um pedido de prévia no estado pedido. */
async function seed(input: { status?: string; vendorJobId?: string | null; pieceType?: string; attempts?: number; photo?: boolean } = {}) {
  const [product] = await db
    .insert(schema.products)
    .values({ name: "VESTIDO AMORA", slug: "vestido-amora", status: "active", pieceType: input.pieceType ?? "vestido" })
    .returning({ id: schema.products.id });
  await db.insert(schema.productImages).values({ productId: product!.id, storagePath: GARMENT_FULL, origin: "upload", color: null, sortOrder: 0 });
  await storage.upload({ path: GARMENT_MD, data: await jpeg("#7a2432"), contentType: "image/webp" });
  const [conversation] = await db.insert(schema.waConversations).values({ phoneE164: PHONE }).returning({ id: schema.waConversations.id });
  const [photo] = await db
    .insert(schema.waMessages)
    .values({ conversationId: conversation!.id, direction: "inbound", kind: "image", body: "", mediaUrl: PHOTO_URL, status: "delivered", createdAt: new Date(NOW.getTime() - 60_000) })
    .returning({ id: schema.waMessages.id });
  if (input.photo !== false) provider.setMediaFixture(PHOTO_URL, await jpeg("#b08968", 900, 1600), "image/jpeg");
  const [request] = await db
    .insert(schema.tryonRequests)
    .values({
      conversationId: conversation!.id,
      phoneE164: PHONE,
      productId: product!.id,
      photoWaMessageId: photo!.id,
      status: input.status ?? "queued",
      vendorJobId: input.vendorJobId ?? null,
      attempts: input.attempts ?? 0,
      acceptedAt: NOW,
      queuedAt: NOW,
      ...(input.status === "processing" || input.status === "submitting" ? { submittedAt: NOW } : {}),
    })
    .returning();
  return { requestId: request!.id, productId: product!.id, conversationId: conversation!.id };
}

async function requestRow(requestId: string) {
  const [row] = await db.select().from(schema.tryonRequests).where(eq(schema.tryonRequests.id, requestId));
  return row!;
}

async function outbound() {
  return db.select().from(schema.waMessages).where(eq(schema.waMessages.direction, "outbound"));
}

/** Os avisos à cliente saem PELA FILA (wa.send), na mesma transação do estado final. */
async function notices(requestId: string): Promise<string[]> {
  const events = await db.select().from(schema.outboxEvents).where(eq(schema.outboxEvents.eventType, "wa.send"));
  return events
    .filter((row) => row.dedupeKey?.startsWith(`wa.bot_tryon:${requestId}:`))
    .map((row) => (row.payload as { body: string }).body);
}

describe("wa.tryon — o caminho feliz", () => {
  it("o evento está registrado na fila", () => {
    expect(outboxHandlers[TRYON_EVENT]).toBeTypeOf("function");
  });

  it("checa a foto, pede à FASHN uma vez, passa nos portões e envia a prévia EMBUTIDA, sem guardar nada", async () => {
    const { requestId } = await seed();
    const upload = vi.spyOn(storage, "upload");

    const result = await runTryOn(deps(), event(requestId));

    expect(result).toEqual({ outcome: "sent", credits: 3, usdCents: expect.any(Number) });
    // Uma geração só, na qualidade alta, com o comando "mesma pessoa, mesmo corpo" e a foto dela (não a da modelo).
    expect(studio.generations).toHaveLength(1);
    expect(studio.generations[0]).toMatchObject({ quality: "alta", count: 1, scenePrompt: buildCustomerTryOnPrompt(), seed: 2_001 });
    expect(studio.generations[0]!.onSubmitted).toBeTypeOf("function");
    // Checagem da foto + portão da peça + portão da pessoa.
    expect(assistant.extractions).toHaveLength(3);
    expect(assistant.extractions[0]!.images).toHaveLength(1);
    expect(assistant.extractions.slice(1).map((call) => call.images.length)).toEqual([2, 2]);

    // A prévia sai embutida, com a legenda de IA, e a conversa guarda só a legenda.
    expect(provider.sentImages).toHaveLength(1);
    expect(provider.sentImages[0]!.imageUrl).toBeUndefined();
    expect(provider.sentImages[0]!.imageBase64?.mimeType).toBe("image/jpeg");
    expect(provider.sentImages[0]!.caption).toContain("prévia feita com IA");
    const [image] = await outbound();
    expect(image).toMatchObject({ kind: "image", mediaUrl: null, dedupeKey: `wa.bot_tryon:${requestId}:previa` });
    expect(upload).not.toHaveBeenCalled();

    const row = await requestRow(requestId);
    expect(row).toMatchObject({ status: "sent", attempts: 1, credits: 3, sentAt: NOW, failureReason: null });
    expect(row.vendorJobId).toMatch(/^fake-tryon-/);
    expect(row.usdCents).toBeGreaterThanOrEqual(23);
    // Da checagem, só o veredito; do julgamento, a peça e os dois "sim" da pessoa (nada do corpo dela).
    expect(row.photoCheck).toEqual({ ok: true });
    expect(row.verdict).toMatchObject({ vendorJobId: row.vendorJobId, passed: true, garment: { mesma_peca: true }, person: { corpo_preservado: true } });
    expect(JSON.stringify(row.verdict)).not.toMatch(/diferencas_no_corpo|peca_na_previa|artefatos/);

    // Rodar de novo (a fila repetiu) não faz nada.
    expect(await runTryOn(deps(), event(requestId))).toEqual({ outcome: "skipped", reason: "pedido_fora_da_fila" });
    expect(studio.generations).toHaveLength(1);
  });

  it("a FASHN aceitou e a espera caiu: retoma PELO ID na mesma invocação, sem pedir (nem pagar) de novo", async () => {
    const { requestId } = await seed();
    studio.failAfterSubmitNext();
    const result = await runTryOn(deps(), event(requestId));
    expect(result).toMatchObject({ outcome: "sent", credits: 3 });
    expect(studio.generations).toHaveLength(2);
    const row = await requestRow(requestId);
    expect(studio.generations[0]!.resumeJobId).toBeUndefined();
    expect(studio.generations[1]!.resumeJobId).toBe(row.vendorJobId);
  });
});

describe("wa.tryon — o envio pelo WhatsApp caiu depois de aprovada", () => {
  it("a fila repete: retoma pelo id e manda SEM julgar de novo (outra opinião poderia pagar outra prévia)", async () => {
    const { requestId } = await seed();
    const send = vi.spyOn(provider, "sendImage").mockRejectedValueOnce(new Error("Z-API fora do ar"));
    await expect(runTryOn(deps(), event(requestId, 0))).rejects.toThrow(/Z-API fora do ar/);
    const halfway = await requestRow(requestId);
    expect(halfway.status).toBe("processing");
    expect(halfway.verdict).toMatchObject({ vendorJobId: halfway.vendorJobId, garment: { mesma_peca: true } });
    expect(assistant.extractions).toHaveLength(3);

    expect(await runTryOn(deps(), event(requestId, 1))).toMatchObject({ outcome: "sent", credits: 3 });
    expect(assistant.extractions).toHaveLength(3);
    expect(studio.generations).toHaveLength(2);
    expect(studio.generations[1]!.resumeJobId).toBe(halfway.vendorJobId);
    expect(send).toHaveBeenCalledTimes(2);
    // Uma mensagem só na conversa (a mesma linha foi retomada).
    expect((await outbound()).filter((message) => message.kind === "image")).toHaveLength(1);
  });

  it("sem tempo para os portões depois que a imagem chegou: devolve a linha (sem contar tentativa) e a próxima retoma pelo id", async () => {
    const { requestId } = await seed({ status: "processing", attempts: 1 });
    // Um pedido que a FASHN conhece: gerado antes, pelo fake, com o id gravado na linha.
    const garment = { data: await jpeg("#7a2432"), mimeType: "image/jpeg" as const };
    let jobId = "";
    await studio.generateOnModel({ garment, model: garment, category: "auto", scenePrompt: "", count: 1, quality: "alta", onSubmitted: (id) => (jobId = id) });
    await db.update(schema.tryonRequests).set({ vendorJobId: jobId }).where(eq(schema.tryonRequests.id, requestId));
    let tick = NOW.getTime();
    const slowClock = () => new Date((tick += 4_000));
    await expect(runTryOn({ ...deps(), now: slowClock }, event(requestId, 0, new Date(NOW.getTime() + 18_000)))).rejects.toBeInstanceOf(HandlerOutOfTimeError);
    expect((await requestRow(requestId)).status).toBe("processing");
    expect(assistant.extractions).toHaveLength(0);
    expect(await runTryOn(deps(), event(requestId, 0))).toMatchObject({ outcome: "sent" });
  });
});

describe("wa.tryon — a foto não serve: dica e fim, nada cobrado", () => {
  it("duas pessoas na foto: pede outra foto, não chama a FASHN", async () => {
    const { requestId } = await seed();
    assistant.enqueueExtraction({ pessoas: 2, foto_de_pessoa_real: true, adulta: true, sem_roupa: false, corpo_visivel: "ate_joelhos", parte_de_baixo: "roupa" });
    expect(await runTryOn(deps(), event(requestId))).toEqual({ outcome: "photo_rejected", problem: "mais_de_uma_pessoa" });
    expect(studio.generations).toHaveLength(0);
    expect(await notices(requestId)).toEqual([expect.stringContaining("uma foto só sua")]);
    expect(await requestRow(requestId)).toMatchObject({ status: "photo_rejected", failureReason: "mais_de_uma_pessoa", credits: 0, photoCheck: { ok: false, problem: "mais_de_uma_pessoa" } });
    // Nada do que a visão viu (idade, roupa) vai para a auditoria — só o problema.
    const [rejected] = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "tryon.photo_rejected"));
    expect(rejected!.after).toEqual({ from: "queued", problem: "mais_de_uma_pessoa" });
  });

  it("blusa sobre biquíni: pede foto vestida da cintura para baixo", async () => {
    const { requestId } = await seed({ pieceType: "blusa" });
    assistant.enqueueExtraction({ pessoas: 1, foto_de_pessoa_real: true, adulta: true, sem_roupa: false, corpo_visivel: "ate_joelhos", parte_de_baixo: "roupa_de_banho_ou_intima" });
    expect(await runTryOn(deps(), event(requestId))).toEqual({ outcome: "photo_rejected", problem: "parte_de_baixo" });
    expect((await notices(requestId))[0]).toContain("vestida da cintura pra baixo");
  });
});

describe("wa.tryon — recusa do modelo e julgamento fora do formato", () => {
  it("o modelo recusa ler a foto dela (segurança): foto recusada com o texto neutro, sem repetir nem chamar a FASHN", async () => {
    const { requestId } = await seed();
    assistant.enqueueExtraction(new AssistantUnavailableError("O modelo recusou ler estas fotos.", { reason: "recusa" }));
    expect(await runTryOn(deps(), event(requestId))).toEqual({ outcome: "photo_rejected", problem: "nao_pode" });
    expect(studio.generations).toHaveLength(0);
    expect((await notices(requestId))[0]).toContain("não consigo usar");
  });

  it("o modelo recusa julgar a prévia: encerra sem mandar e sem pagar outra", async () => {
    const { requestId } = await seed();
    assistant.enqueueExtraction(undefined);
    assistant.enqueueExtraction(new AssistantUnavailableError("O modelo recusou ler estas fotos.", { reason: "recusa" }));
    expect(await runTryOn(deps(), event(requestId))).toEqual({ outcome: "failed", reason: "visao_recusou" });
    expect((await notices(requestId))[0]).not.toMatch(/manda|outra foto/i);
    expect(studio.generations).toHaveLength(1);
    expect(provider.sentImages).toHaveLength(0);
    expect(await requestRow(requestId)).toMatchObject({ credits: 3 });
  });

  it("julgamento fora do formato: NÃO paga outra prévia — relança, e a próxima rodada julga de novo pelo mesmo pedido", async () => {
    const { requestId } = await seed();
    assistant.enqueueExtraction(undefined);
    assistant.enqueueExtraction({ ...FAKE_TRYON_GARMENT_JSON, artefatos: [""] });
    await expect(runTryOn(deps(), event(requestId, 0))).rejects.toThrow(/fora do formato/);
    expect(await requestRow(requestId)).toMatchObject({ status: "processing", attempts: 1 });
    // O gasto da visão que não serviu fica registrado.
    expect((await requestRow(requestId)).usdCents).toBeGreaterThan(0);
    expect(await runTryOn(deps(), event(requestId, 1))).toMatchObject({ outcome: "sent", credits: 3 });
    expect(studio.generations.filter((call) => call.resumeJobId === undefined)).toHaveLength(1);
  });
});

describe("wa.tryon — os portões", () => {
  it("a 1ª prévia saiu infiel: tenta UMA vez mais, com outra semente, e manda a fiel", async () => {
    const { requestId } = await seed();
    assistant.enqueueExtraction(undefined); // checagem da foto: padrão (serve)
    assistant.enqueueExtraction({ ...FAKE_TRYON_GARMENT_JSON, corte_ok: false, nota: 4 }); // peça: decote diferente
    const result = await runTryOn(deps(), event(requestId));
    expect(result).toMatchObject({ outcome: "sent", credits: 6 });
    expect(studio.generations.map((call) => call.seed)).toEqual([2_001, 2_002]);
    expect(await requestRow(requestId)).toMatchObject({ status: "sent", attempts: 2, credits: 6 });
    expect(provider.sentImages).toHaveLength(1);
  });

  it("infiel duas vezes: não manda imagem nenhuma e diz a verdade à cliente", async () => {
    const { requestId } = await seed();
    const bad = { ...FAKE_TRYON_GARMENT_JSON, corte_ok: false, nota: 4 };
    assistant.enqueueExtraction(undefined);
    assistant.enqueueExtraction(bad);
    assistant.enqueueExtraction(undefined);
    assistant.enqueueExtraction(bad);
    expect(await runTryOn(deps(), event(requestId))).toEqual({ outcome: "failed", reason: "nao_ficou_fiel" });
    expect(provider.sentImages).toHaveLength(0);
    expect(await notices(requestId)).toEqual([expect.stringContaining("não ficou fiel à peça")]);
    expect(await requestRow(requestId)).toMatchObject({ status: "failed", failureReason: "nao_ficou_fiel", attempts: 2, credits: 6 });
  });

  it("ela disse 'Agora não' (ou SAIR) DURANTE a 1ª tentativa: lido do banco, a prévia infiel NÃO ganha segunda tentativa paga", async () => {
    const { requestId } = await seed();
    await db.update(schema.tryonRequests).set({ acceptedAt: new Date(NOW.getTime() - 60_000) }).where(eq(schema.tryonRequests.id, requestId));
    assistant.enqueueExtraction(undefined);
    assistant.enqueueExtraction({ ...FAKE_TRYON_GARMENT_JSON, corte_ok: false, nota: 4 });
    // O webhook carimba a recusa enquanto o portão julga (o estado segue "fazendo").
    const original = assistant.extractFromPhotos.bind(assistant);
    let calls = 0;
    vi.spyOn(assistant, "extractFromPhotos").mockImplementation(async (input) => {
      calls += 1;
      const call = calls;
      // Chama o fake na ordem (os roteiros são consumidos na ordem das chamadas) e só depois carimba.
      const result = original(input);
      if (call === 2) {
        await result;
        await db.update(schema.tryonRequests).set({ declinedAt: NOW }).where(eq(schema.tryonRequests.id, requestId));
      }
      return result;
    });
    expect(await runTryOn(deps(), event(requestId))).toEqual({ outcome: "failed", reason: "cliente_desistiu" });
    expect(studio.generations).toHaveLength(1);
    expect(provider.sentImages).toHaveLength(0);
    expect(await notices(requestId)).toEqual([expect.stringContaining("preferi não te mandar")]);
  });

  it("corpo mudou na prévia: reprova como peça infiel", async () => {
    const { requestId } = await seed({ attempts: 1 });
    assistant.enqueueExtraction(undefined);
    assistant.enqueueExtraction(undefined);
    assistant.enqueueExtraction({ mesma_pessoa: true, diferencas_no_corpo: ["cintura afinada"], corpo_preservado: false, artefatos: [] });
    expect(await runTryOn(deps(), event(requestId))).toEqual({ outcome: "failed", reason: "nao_ficou_fiel" });
    expect(provider.sentImages).toHaveLength(0);
  });
});

describe("wa.tryon — a regra de ouro: o que a FASHN pode ter aceitado nunca é pedido de novo", () => {
  it("'enviando' sem id (o envio caiu no meio): encerra como envio incerto e NÃO chama a FASHN", async () => {
    const { requestId } = await seed({ status: "submitting", attempts: 1 });
    expect(await runTryOn(deps(), event(requestId))).toEqual({ outcome: "failed", reason: "envio_incerto" });
    expect(studio.generations).toHaveLength(0);
    expect(await requestRow(requestId)).toMatchObject({ credits: 3, failureReason: "envio_incerto" });
    expect((await requestRow(requestId)).usdCents).toBeGreaterThan(0);
    expect(await notices(requestId)).toEqual([expect.stringContaining("Não consegui fazer a sua prévia agora")]);
  });

  it("'fazendo' com um id que a FASHN não conhece mais: encerra sem pedir de novo", async () => {
    const { requestId } = await seed({ status: "processing", vendorJobId: "job-sumido", attempts: 1 });
    expect(await runTryOn(deps(), event(requestId))).toEqual({ outcome: "failed", reason: "indisponivel" });
    expect(studio.generations).toHaveLength(1);
    expect(studio.generations[0]!.resumeJobId).toBe("job-sumido");
  });

  it("429 na entrada: nada cobrado, volta à fila e relança", async () => {
    const { requestId } = await seed();
    studio.failNext(new StudioUnavailableError("muitas chamadas", "rate_limited", 429));
    await expect(runTryOn(deps(), event(requestId, 1))).rejects.toMatchObject({ reason: "rate_limited" });
    expect(await requestRow(requestId)).toMatchObject({ status: "queued", attempts: 0 });
    expect(provider.sentMessages).toHaveLength(0);
  });

  it("sem crédito na FASHN: avisa a cliente E a dona (uma vez por dia)", async () => {
    const { requestId } = await seed();
    studio.failNext(new StudioUnavailableError("sem crédito", "no_credits", 402));
    expect(await runTryOn(deps(), event(requestId))).toEqual({ outcome: "failed", reason: "sem_creditos" });
    expect(await notices(requestId)).toEqual([expect.stringContaining("Não consegui fazer a sua prévia agora")]);
    expect(provider.sentMessages.find((message) => message.toE164 === OWNER)?.body).toContain("créditos da FASHN acabaram");
    // Nenhum crédito da FASHN; o gasto registrado é só o da checagem da foto.
    const row = await requestRow(requestId);
    expect(row).toMatchObject({ status: "failed", failureReason: "sem_creditos", credits: 0 });
    expect(row.usdCents).toBeLessThan(10);
  });
});

describe("wa.tryon — tempo, interruptor e desistência", () => {
  it("pouco tempo na invocação: devolve a linha sem contar tentativa e sem gastar nada", async () => {
    const { requestId } = await seed();
    await expect(runTryOn(deps(), event(requestId, 3, new Date(NOW.getTime() + 5_000)))).rejects.toBeInstanceOf(HandlerOutOfTimeError);
    expect(await requestRow(requestId)).toMatchObject({ status: "queued", attempts: 0 });
    expect(studio.generations).toHaveLength(0);
    expect(assistant.extractions).toHaveLength(0);
  });

  it("desligado depois do pedido: avisa e encerra sem gastar", async () => {
    const { requestId } = await seed();
    await db.update(schema.settings).set({ value: false }).where(eq(schema.settings.key, "tryon_enabled"));
    expect(await runTryOn(deps(), event(requestId))).toEqual({ outcome: "failed", reason: "desligado" });
    expect(studio.generations).toHaveLength(0);
  });

  it("a foto não abre (URL da Z-API expirou): relança; na última tentativa encerra e avisa a cliente", async () => {
    const { requestId } = await seed({ photo: false });
    await expect(runTryOn(deps(), event(requestId, 1))).rejects.toThrow(/sem fixture/);
    expect((await requestRow(requestId)).status).toBe("queued");
    await expect(runTryOn(deps(), event(requestId, 3))).rejects.toThrow(/sem fixture/);
    expect(await requestRow(requestId)).toMatchObject({ status: "failed", failureReason: "indisponivel" });
    expect(await notices(requestId)).toEqual([expect.stringContaining("Não consegui fazer a sua prévia agora")]);
    expect(studio.generations).toHaveLength(0);
  });

  it("o WhatsApp fora do ar na última tentativa não prende o pedido: o estado final grava e o aviso fica na fila", async () => {
    const { requestId } = await seed();
    vi.spyOn(provider, "sendImage").mockRejectedValue(new Error("Z-API fora do ar"));
    for (const attempt of [0, 1, 2]) await expect(runTryOn(deps(), event(requestId, attempt))).rejects.toThrow(/Z-API/);
    await expect(runTryOn(deps(), event(requestId, 3))).rejects.toThrow(/Z-API/);
    expect(await requestRow(requestId)).toMatchObject({ status: "failed", failureReason: "demorou_demais", credits: 3 });
    expect(await notices(requestId)).toEqual([expect.stringContaining("Não consegui fazer a sua prévia agora")]);
  });
});
