// Adapter do ensaio: o client real da FASHN com fetch fake (POST /run, GET
// /status até completar, saída em base64 ou URL, chave, créditos, erros sem
// vazar corpo, prazo) e o fake roteirizável que devolve a foto com faixa FAKE.
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getImageStudio, isImageStudioConfigured, StudioUnavailableError } from "@/adapters/image-studio";
import { FakeImageStudio } from "@/adapters/image-studio/fake";
import { FASHN_MODELS, FashnImageStudio } from "@/adapters/image-studio/fashn";

const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const GARMENT = { data: Buffer.from("peca"), mimeType: "image/jpeg" as const };
const MODEL = { data: Buffer.from("modela"), mimeType: "image/png" as const };

type Call = { url: string; init: { method?: string; headers?: Record<string, string>; body?: string } | undefined };

/** Servidor FASHN de mentira: /run devolve id, /status segue o roteiro, o CDN devolve bytes. */
function fashnServer(options: { statuses?: unknown[]; runStatus?: number; runBody?: unknown; cdnStatus?: number } = {}) {
  const calls: Call[] = [];
  const statuses = [...(options.statuses ?? [{ status: "completed", output: [`data:image/jpeg;base64,${JPEG_BYTES.toString("base64")}`] }])];
  const fetchImpl = async (url: string, init?: Call["init"]): Promise<Response> => {
    calls.push({ url, init });
    if (url.endsWith("/run")) {
      return new Response(JSON.stringify(options.runBody ?? { id: "job-1" }), { status: options.runStatus ?? 200 });
    }
    if (url.includes("/status/")) {
      const next = statuses.length > 1 ? statuses.shift() : statuses[0];
      return new Response(JSON.stringify(next), { status: 200 });
    }
    return new Response(new Uint8Array(JPEG_BYTES), { status: options.cdnStatus ?? 200 });
  };
  return { calls, fetchImpl };
}

/** A promessa tem de falhar com StudioUnavailableError; devolve o erro para inspeção. */
async function failureOf(promise: Promise<unknown>): Promise<StudioUnavailableError> {
  return promise.then(
    () => {
      throw new Error("esperava StudioUnavailableError");
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(StudioUnavailableError);
      return error as StudioUnavailableError;
    },
  );
}

function client(server: ReturnType<typeof fashnServer>, clock?: { now: number }) {
  return new FashnImageStudio({
    fetchImpl: server.fetchImpl,
    sleep: async () => {
      if (clock) clock.now += 1_500;
    },
    now: () => clock?.now ?? 1_000,
  });
}

describe("FashnImageStudio (client real com fetch fake)", () => {
  beforeEach(() => {
    vi.stubEnv("FASHN_API_KEY", "fashn-teste");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("econômica: tryon-v1.6 com a peça esticada (flat-lay), espera completar e devolve a imagem com o custo da tabela", async () => {
    const server = fashnServer({
      statuses: [
        { status: "in_queue" },
        { status: "processing" },
        { status: "completed", output: [`data:image/jpeg;base64,${JPEG_BYTES.toString("base64")}`] },
      ],
    });
    const clock = { now: 10_000 };
    const images = await client(server, clock).generateOnModel({
      garment: GARMENT,
      model: MODEL,
      category: "one-pieces",
      scenePrompt: "varanda",
      count: 1,
      quality: "economica",
      seed: 7,
    });
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({ vendor: "fashn", vendorModel: FASHN_MODELS.tryonLight, creditsUsed: 1, usdCents: 8, seed: 7, mimeType: "image/jpeg" });
    expect(images[0]?.data.equals(JPEG_BYTES)).toBe(true);
    expect(images[0]?.elapsedMs).toBe(4_500);

    expect(server.calls[0]?.url).toBe("https://api.fashn.ai/v1/run");
    expect(server.calls[0]?.init?.headers?.Authorization).toBe("Bearer fashn-teste");
    const body = JSON.parse(server.calls[0]?.init?.body ?? "{}") as { model_name: string; inputs: Record<string, unknown> };
    expect(body.model_name).toBe("tryon-v1.6");
    expect(body.inputs).toMatchObject({
      category: "one-pieces",
      garment_photo_type: "flat-lay",
      mode: "balanced",
      segmentation_free: true,
      seed: 7,
      num_samples: 1,
      output_format: "jpeg",
      return_base64: true,
    });
    expect(body.inputs.garment_image).toBe(`data:image/jpeg;base64,${GARMENT.data.toString("base64")}`);
    expect(body.inputs.model_image).toBe(`data:image/png;base64,${MODEL.data.toString("base64")}`);
    // O econômico não manda prompt de cena: mantém a cena da foto-base.
    expect(body.inputs.prompt).toBeUndefined();
    expect(server.calls.filter((call) => call.url.includes("/status/job-1"))).toHaveLength(3);
  });

  it("alta: tryon-max em 2K com o prompt da cena e 3 créditos por imagem; saída por URL do CDN é baixada", async () => {
    const server = fashnServer({ statuses: [{ status: "completed", output: ["https://cdn.fashn.ai/out/1.jpg", "https://cdn.fashn.ai/out/2.jpg"] }] });
    const images = await client(server).generateOnModel({
      garment: GARMENT,
      model: MODEL,
      category: "tops",
      scenePrompt: "Keep the same person",
      count: 2,
      quality: "alta",
    });
    expect(images).toHaveLength(2);
    expect(images.map((image) => image.creditsUsed)).toEqual([3, 3]);
    expect(images[0]?.usdCents).toBe(23);
    expect(images[1]?.data.equals(JPEG_BYTES)).toBe(true);
    const body = JSON.parse(server.calls[0]?.init?.body ?? "{}") as { model_name: string; inputs: Record<string, unknown> };
    expect(body.model_name).toBe("tryon-max");
    expect(body.inputs).toMatchObject({ prompt: "Keep the same person", resolution: "2k", generation_mode: "balanced", num_images: 2, seed: 42 });
    expect(server.calls.filter((call) => call.url.startsWith("https://cdn.fashn.ai/"))).toHaveLength(2);
  });

  it("foto-base: model-create com o prompt, a proporção e a resolução da qualidade", async () => {
    const server = fashnServer();
    const images = await client(server).createModelPhoto({ prompt: "a woman", aspectRatio: "3:4", count: 2, quality: "alta", seed: 3 });
    // A resposta de mentira tem uma saída só; devolve o que veio, com o custo da tabela.
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({ vendorModel: "model-create", creditsUsed: 4, usdCents: 30, seed: 3 });
    const body = JSON.parse(server.calls[0]?.init?.body ?? "{}") as { model_name: string; inputs: Record<string, unknown> };
    expect(body.model_name).toBe("model-create");
    expect(body.inputs).toMatchObject({ prompt: "a woman", aspect_ratio: "3:4", resolution: "2k", generation_mode: "quality", num_images: 2, seed: 3 });
    const cheap = fashnServer();
    await client(cheap).createModelPhoto({ prompt: "a woman", aspectRatio: "9:16", count: 9, quality: "economica" });
    const cheapBody = JSON.parse(cheap.calls[0]?.init?.body ?? "{}") as { inputs: Record<string, unknown> };
    expect(cheapBody.inputs).toMatchObject({ resolution: "1k", generation_mode: "balanced", num_images: 4 });
  });

  it("sem chave, HTTP de erro e recusa viram StudioUnavailableError com motivo — e sem o corpo", async () => {
    const input = { garment: GARMENT, model: MODEL, category: "auto" as const, scenePrompt: "", count: 1, quality: "economica" as const };
    const reasonOf = async (studio: FashnImageStudio) =>
      studio
        .generateOnModel(input)
        .then(() => "ok")
        .catch((error: unknown) => (error as StudioUnavailableError).reason);

    vi.stubEnv("FASHN_API_KEY", "   ");
    expect(await reasonOf(client(fashnServer()))).toBe("no_key");
    vi.stubEnv("FASHN_API_KEY", "fashn-teste");
    expect(await reasonOf(client(fashnServer({ runStatus: 401, runBody: { error: "segredo" } })))).toBe("no_key");
    expect(await reasonOf(client(fashnServer({ runStatus: 402 })))).toBe("no_credits");
    expect(await reasonOf(client(fashnServer({ runStatus: 429 })))).toBe("rate_limited");
    expect(await reasonOf(client(fashnServer({ runStatus: 422 })))).toBe("rejected");
    expect(await reasonOf(client(fashnServer({ runStatus: 503 })))).toBe("unavailable");
    expect(await reasonOf(client(fashnServer({ runBody: { nope: 1 } })))).toBe("invalid_response");
    expect(await reasonOf(client(fashnServer({ statuses: [{ status: "failed", error: { name: "ContentModerationError", message: "corpo" } }] })))).toBe("rejected");
    expect(await reasonOf(client(fashnServer({ statuses: [{ status: "completed", output: [] }] })))).toBe("invalid_response");
    expect(await reasonOf(client(fashnServer({ statuses: [{ status: "completed", output: ["ftp://x"] }] })))).toBe("invalid_response");
    expect(await reasonOf(client(fashnServer({ statuses: [{ status: "completed", output: ["https://cdn.fashn.ai/x.jpg"] }], cdnStatus: 404 })))).toBe("unavailable");

    const error = await failureOf(client(fashnServer({ runStatus: 401, runBody: { error: "segredo do corpo" } })).generateOnModel(input));
    expect(error.message).toContain("401");
    expect(error.message).not.toContain("segredo");
    expect(error.status).toBe(401);
    expect(error.retryable).toBe(false);
    const failed = await failureOf(
      client(fashnServer({ statuses: [{ status: "failed", error: { name: "ContentModerationError", message: "corpo" } }] })).generateOnModel(input),
    );
    expect(failed.message).toContain("ContentModerationError");
    expect(failed.message).not.toContain("corpo");
    expect(new StudioUnavailableError("x", "rate_limited").retryable).toBe(true);
    expect(new StudioUnavailableError("x", "timeout").retryable).toBe(true);
    expect(new StudioUnavailableError("x", "no_credits").retryable).toBe(false);
  });

  it("uma consulta de status que falha de passagem não abandona o pedido; três seguidas, sim", async () => {
    const input = { garment: GARMENT, model: MODEL, category: "auto" as const, scenePrompt: "", count: 1, quality: "economica" as const };
    const flaky = fashnServer({ statuses: [{ status: "completed", output: [`data:image/jpeg;base64,${JPEG_BYTES.toString("base64")}`] }] });
    let statusCalls = 0;
    const fetchImpl = async (url: string, init?: Call["init"]) => {
      if (url.includes("/status/")) {
        statusCalls += 1;
        if (statusCalls <= 2) return new Response("{}", { status: 503 });
      }
      return flaky.fetchImpl(url, init);
    };
    const studio = new FashnImageStudio({ fetchImpl, sleep: async () => {} });
    expect(await studio.generateOnModel(input)).toHaveLength(1);
    expect(statusCalls).toBe(3);

    const dead = new FashnImageStudio({
      fetchImpl: async (url: string) => (url.endsWith("/run") ? new Response(JSON.stringify({ id: "j" })) : new Response("{}", { status: 503 })),
      sleep: async () => {},
    });
    await expect(dead.generateOnModel(input)).rejects.toMatchObject({ reason: "unavailable" });
    // Recusa (4xx) na consulta não é passageira: desiste na hora.
    const rejected = new FashnImageStudio({
      fetchImpl: async (url: string) => (url.endsWith("/run") ? new Response(JSON.stringify({ id: "j" })) : new Response("{}", { status: 404 })),
      sleep: async () => {},
    });
    await expect(rejected.generateOnModel(input)).rejects.toMatchObject({ reason: "rejected" });
  });

  it("rede caída é network; prazo do chamador e teto da espera são timeout", async () => {
    const down = new FashnImageStudio({
      fetchImpl: async () => {
        throw new Error("ECONNRESET");
      },
      sleep: async () => {},
    });
    const input = { garment: GARMENT, model: MODEL, category: "auto" as const, scenePrompt: "", count: 1, quality: "economica" as const };
    await expect(down.generateOnModel(input)).rejects.toMatchObject({ reason: "network" });

    // O prazo do handler: o sinal aborta enquanto o pedido ainda processa.
    const controller = new AbortController();
    const slow = fashnServer({ statuses: [{ status: "processing" }] });
    const studio = new FashnImageStudio({
      fetchImpl: slow.fetchImpl,
      sleep: async () => controller.abort(),
      now: () => 0,
    });
    await expect(studio.generateOnModel({ ...input, signal: controller.signal })).rejects.toMatchObject({ reason: "timeout" });

    // Sem sinal, o teto interno de espera (90 s) encerra.
    const clock = { now: 0 };
    const forever = fashnServer({ statuses: [{ status: "processing" }] });
    await expect(client(forever, clock).generateOnModel(input)).rejects.toMatchObject({ reason: "timeout" });
    expect(clock.now).toBeGreaterThanOrEqual(90_000);
  });
});

describe("FakeImageStudio + seleção por ADAPTER_MODE", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("devolve a própria foto com a faixa FAKE, N vezes, com custo da tabela; grava as chamadas; falha sob roteiro", async () => {
    const fake = new FakeImageStudio();
    const garment = await sharp({ create: { width: 400, height: 600, channels: 3, background: { r: 200, g: 50, b: 50 } } }).jpeg().toBuffer();
    const images = await fake.generateOnModel({
      garment: { data: garment, mimeType: "image/jpeg" },
      model: MODEL,
      category: "tops",
      scenePrompt: "",
      count: 3,
      quality: "economica",
    });
    expect(images).toHaveLength(3);
    expect(images.map((image) => image.seed)).toEqual([42, 43, 44]);
    expect(images[0]).toMatchObject({ vendor: "fake", vendorModel: "fake-tryon", creditsUsed: 1, usdCents: 8 });
    const meta = await sharp(images[0]!.data).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.width).toBe(400);
    expect(meta.height).toBe(600);
    // A faixa vermelha muda o rodapé: a imagem não é idêntica à original.
    expect(images[0]!.data.equals(garment)).toBe(false);
    expect(fake.generations).toHaveLength(1);

    const photos = await fake.createModelPhoto({ prompt: "x", aspectRatio: "9:16", count: 2, quality: "alta" });
    expect(photos).toHaveLength(2);
    expect(photos[0]).toMatchObject({ vendorModel: "fake-model-create", creditsUsed: 4, usdCents: 30 });
    expect((await sharp(photos[0]!.data).metadata()).height).toBe(1920);
    expect(fake.modelPhotos).toHaveLength(1);

    fake.failNext();
    await expect(fake.createModelPhoto({ prompt: "x", aspectRatio: "3:4", count: 1, quality: "economica" })).rejects.toBeInstanceOf(StudioUnavailableError);
    // Peça que não é imagem: o fake recusa como o real recusaria, com o mesmo erro.
    await expect(
      fake.generateOnModel({ garment: { data: Buffer.from("nao-e-imagem"), mimeType: "image/jpeg" }, model: MODEL, category: "auto", scenePrompt: "", count: 1, quality: "economica" }),
    ).rejects.toMatchObject({ reason: "rejected" });
    fake.reset();
    expect(fake.generations).toHaveLength(0);
    expect(fake.modelPhotos).toHaveLength(0);
  });

  it("em modo fake está sempre configurado e devolve o fake; em real depende da chave", () => {
    vi.stubEnv("ADAPTER_MODE", "fake");
    expect(isImageStudioConfigured()).toBe(true);
    expect(getImageStudio()).toBeInstanceOf(FakeImageStudio);
    vi.stubEnv("ADAPTER_MODE", "real");
    vi.stubEnv("FASHN_API_KEY", "");
    expect(isImageStudioConfigured()).toBe(false);
    vi.stubEnv("FASHN_API_KEY", "fashn-x");
    expect(isImageStudioConfigured()).toBe(true);
  });
});
