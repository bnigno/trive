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
const MODEL = { data: Buffer.from("modelo"), mimeType: "image/png" as const };

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

function client(server: Pick<ReturnType<typeof fashnServer>, "fetchImpl">, clock?: { now: number }) {
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
    expect(images[0]).toMatchObject({ vendorModel: "model-create", creditsUsed: 3, usdCents: 23, seed: 3 });
    const body = JSON.parse(server.calls[0]?.init?.body ?? "{}") as { model_name: string; inputs: Record<string, unknown> };
    expect(body.model_name).toBe("model-create");
    expect(body.inputs).toMatchObject({ prompt: "a woman", aspect_ratio: "3:4", resolution: "2k", generation_mode: "balanced", num_images: 2, seed: 3 });
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
    // A FASHN responde 429 também quando os créditos acabaram: o nome do erro decide.
    expect(await reasonOf(client(fashnServer({ runStatus: 429, runBody: { error: { name: "OutOfCredits", message: "segredo" } } })))).toBe("no_credits");
    expect(await reasonOf(client(fashnServer({ runStatus: 429, runBody: { error: "InsufficientBalance" } })))).toBe("no_credits");
    expect(await reasonOf(client(fashnServer({ runStatus: 429, runBody: { error: { name: "RateLimitExceeded", message: "x" } } })))).toBe("rate_limited");
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
    const credits = await failureOf(client(fashnServer({ runStatus: 429, runBody: { error: { name: "OutOfCredits", message: "segredo do corpo" } } })).generateOnModel(input));
    expect(credits.message).toContain("OutOfCredits");
    expect(credits.message).not.toContain("segredo");
    expect(credits.retryable).toBe(false);
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

/** Começo de um MP4 de verdade: tamanho da caixa + "ftyp" nos bytes 4–7. */
const MP4_BYTES = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom", "latin1"), Buffer.alloc(12)]);
const PHOTO = { data: Buffer.from("foto-no-corpo"), mimeType: "image/jpeg" as const };
const BACK = { data: Buffer.from("costas"), mimeType: "image/png" as const };

/** Servidor FASHN de mentira para vídeo: a saída é a URL do MP4 no CDN deles. */
function videoServer(options: { statuses?: unknown[]; cdnBody?: Uint8Array<ArrayBuffer>; cdnStatus?: number; cdnHeaders?: Record<string, string> } = {}) {
  const calls: Call[] = [];
  const statuses = [...(options.statuses ?? [{ status: "completed", output: ["https://cdn.fashn.ai/job-v/output_0.mp4"] }])];
  const fetchImpl = async (url: string, init?: Call["init"]): Promise<Response> => {
    calls.push({ url, init });
    if (url.endsWith("/run")) return new Response(JSON.stringify({ id: "job-v" }), { status: 200 });
    if (url.includes("/status/")) {
      const next = statuses.length > 1 ? statuses.shift() : statuses[0];
      return new Response(JSON.stringify(next), { status: 200 });
    }
    return new Response(options.cdnBody ?? new Uint8Array(MP4_BYTES), { status: options.cdnStatus ?? 200, headers: options.cdnHeaders });
  };
  return { calls, fetchImpl };
}

describe("FashnImageStudio.animate (a peça se mexe)", () => {
  beforeEach(() => {
    vi.stubEnv("FASHN_API_KEY", "fashn-teste");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("image-to-video com a foto, o prompt, a duração e a resolução; baixa o MP4 e cobra pela tabela", async () => {
    const server = videoServer({
      statuses: [{ status: "in_queue" }, { status: "processing" }, { status: "completed", output: ["https://cdn.fashn.ai/job-v/output_0.mp4"] }],
    });
    const clock = { now: 0 };
    const video = await client(server, clock).animate({
      image: PHOTO,
      prompt: "She turns slightly",
      durationSeconds: 5,
      resolution: "1080p",
    });
    expect(video).toMatchObject({ mimeType: "video/mp4", vendor: "fashn", vendorModel: "image-to-video", creditsUsed: 6, usdCents: 45, elapsedMs: 4_500 });
    expect(video.data.equals(MP4_BYTES)).toBe(true);
    const body = JSON.parse(server.calls[0]?.init?.body ?? "{}") as { model_name: string; inputs: Record<string, unknown> };
    expect(body.model_name).toBe(FASHN_MODELS.imageToVideo);
    expect(body.inputs).toEqual({
      image: `data:image/jpeg;base64,${PHOTO.data.toString("base64")}`,
      prompt: "She turns slightly",
      duration: 5,
      resolution: "1080p",
    });
    expect(server.calls.at(-1)?.url).toBe("https://cdn.fashn.ai/job-v/output_0.mp4");
  });

  it("com a foto das costas manda end_image; 10 s em 720p custa 6", async () => {
    const server = videoServer();
    const video = await client(server).animate({ image: PHOTO, endImage: BACK, prompt: "p", durationSeconds: 10, resolution: "720p" });
    expect(video.creditsUsed).toBe(6);
    const body = JSON.parse(server.calls[0]?.init?.body ?? "{}") as { inputs: Record<string, unknown> };
    expect(body.inputs.end_image).toBe(`data:image/png;base64,${BACK.data.toString("base64")}`);
    expect(body.inputs.duration).toBe(10);
  });

  it("vídeo demora mais que foto: espera além dos 90 s da foto, até o teto de 10 min", async () => {
    const statuses = [...Array.from({ length: 80 }, () => ({ status: "processing" })), { status: "completed", output: ["https://cdn.fashn.ai/v.mp4"] }];
    const clock = { now: 0 };
    const video = await client(videoServer({ statuses }), clock).animate({ image: PHOTO, prompt: "p", durationSeconds: 5, resolution: "480p" });
    expect(video.creditsUsed).toBe(1);
    expect(clock.now).toBeGreaterThan(90_000);

    const forever = { now: 0 };
    await expect(
      client(videoServer({ statuses: [{ status: "processing" }] }), forever).animate({ image: PHOTO, prompt: "p", durationSeconds: 5, resolution: "480p" }),
    ).rejects.toMatchObject({ reason: "timeout" });
    expect(forever.now).toBeGreaterThanOrEqual(600_000);
    expect(forever.now).toBeLessThan(602_000);
  });

  it("saída que não é MP4, vazia, grande demais, fora de https ou com CDN fora do ar é recusada", async () => {
    const input = { image: PHOTO, prompt: "p", durationSeconds: 5 as const, resolution: "1080p" as const };
    const reasonOf = (server: ReturnType<typeof videoServer>) =>
      client(server)
        .animate(input)
        .then(() => "ok")
        .catch((error: unknown) => (error as StudioUnavailableError).reason);
    expect(await reasonOf(videoServer({ cdnBody: new Uint8Array(JPEG_BYTES) }))).toBe("invalid_response");
    expect(await reasonOf(videoServer({ cdnBody: new Uint8Array(0) }))).toBe("invalid_response");
    expect(await reasonOf(videoServer({ cdnHeaders: { "content-length": String(61 * 1024 * 1024) } }))).toBe("invalid_response");
    expect(await reasonOf(videoServer({ statuses: [{ status: "completed", output: ["data:video/mp4;base64,AAAA"] }] }))).toBe("invalid_response");
    expect(await reasonOf(videoServer({ statuses: [{ status: "completed", output: [] }] }))).toBe("invalid_response");
    expect(await reasonOf(videoServer({ cdnStatus: 403 }))).toBe("unavailable");
    expect(await reasonOf(videoServer({ statuses: [{ status: "failed", error: { name: "ContentModerationError", message: "corpo" } }] }))).toBe("rejected");
    vi.stubEnv("FASHN_API_KEY", "");
    expect(await reasonOf(videoServer())).toBe("no_key");
  });

  it("entrega o id do pedido assim que a FASHN aceita; retomar só acompanha e baixa, sem novo POST", async () => {
    const server = videoServer();
    const submitted: string[] = [];
    await client(server).animate({ image: PHOTO, prompt: "p", durationSeconds: 5, resolution: "1080p", onSubmitted: (id) => submitted.push(id) });
    expect(submitted).toEqual(["job-v"]);

    const resumed = videoServer();
    const again: string[] = [];
    const video = await client(resumed).animate({
      image: PHOTO,
      prompt: "p",
      durationSeconds: 5,
      resolution: "1080p",
      resumeJobId: "job-antigo",
      onSubmitted: (id) => again.push(id),
    });
    expect(video.data.equals(MP4_BYTES)).toBe(true);
    expect(again).toEqual([]);
    expect(resumed.calls.some((call) => call.url.endsWith("/run"))).toBe(false);
    expect(resumed.calls[0]?.url).toBe("https://api.fashn.ai/v1/status/job-antigo");
  });

  it("o id sai ANTES do fim: um pedido que estoura o prazo já entregou o id para retomar; id vazio nunca vira pedido novo", async () => {
    const order: string[] = [];
    const server = videoServer({ statuses: [{ status: "processing" }] });
    const tracked = {
      fetchImpl: async (url: string, init?: Call["init"]) => {
        order.push(url.endsWith("/run") ? "run" : url.includes("/status/") ? "status" : "cdn");
        return server.fetchImpl(url, init);
      },
    };
    const clock = { now: 0 };
    await expect(
      client(tracked, clock).animate({ image: PHOTO, prompt: "p", durationSeconds: 5, resolution: "1080p", onSubmitted: (id) => order.push(`id:${id}`) }),
    ).rejects.toMatchObject({ reason: "timeout" });
    expect(order.slice(0, 3)).toEqual(["run", "id:job-v", "status"]);

    for (const empty of ["", "   "]) {
      const blank = videoServer();
      await expect(client(blank).animate({ image: PHOTO, prompt: "p", durationSeconds: 5, resolution: "1080p", resumeJobId: empty })).rejects.toMatchObject({
        reason: "rejected",
      });
      expect(blank.calls).toHaveLength(0);
    }
  });

  it("queda no meio do download do MP4 vira erro de rede, não um erro cru", async () => {
    const broken = new FashnImageStudio({
      fetchImpl: async (url: string) => {
        if (url.endsWith("/run")) return new Response(JSON.stringify({ id: "j" }));
        if (url.includes("/status/")) return new Response(JSON.stringify({ status: "completed", output: ["https://cdn.fashn.ai/j/output_0.mp4"] }));
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(MP4_BYTES));
            controller.error(new TypeError("terminated"));
          },
        });
        return new Response(body);
      },
      sleep: async () => {},
    });
    await expect(broken.animate({ image: PHOTO, prompt: "p", durationSeconds: 5, resolution: "480p" })).rejects.toMatchObject({ reason: "network" });
  });

  it("creditsBalance lê o total de GET /credits; formato errado é invalid_response", async () => {
    const calls: string[] = [];
    const ok = new FashnImageStudio({
      fetchImpl: async (url: string) => {
        calls.push(url);
        return new Response(JSON.stringify({ credits: { total: 115, subscription: 0, on_demand: 115 } }));
      },
    });
    expect(await ok.creditsBalance()).toBe(115);
    expect(calls).toEqual(["https://api.fashn.ai/v1/credits"]);
    const bad = new FashnImageStudio({ fetchImpl: async () => new Response(JSON.stringify({ total: 3 })) });
    await expect(bad.creditsBalance()).rejects.toMatchObject({ reason: "invalid_response" });
    const noKey = new FashnImageStudio({ fetchImpl: async () => new Response("{}", { status: 401 }) });
    await expect(noKey.creditsBalance()).rejects.toMatchObject({ reason: "no_key" });
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
    expect(photos[0]).toMatchObject({ vendorModel: "fake-model-create", creditsUsed: 3, usdCents: 23 });
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

  it("animate de mentira: MP4 marcado FAKE com o custo da tabela; grava a chamada; recusa foto inválida; falha sob roteiro", async () => {
    const fake = new FakeImageStudio();
    const photo = await sharp({ create: { width: 300, height: 400, channels: 3, background: { r: 90, g: 60, b: 120 } } }).jpeg().toBuffer();
    const video = await fake.animate({ image: { data: photo, mimeType: "image/jpeg" }, prompt: "p", durationSeconds: 5, resolution: "1080p" });
    expect(video).toMatchObject({ mimeType: "video/mp4", vendor: "fake", vendorModel: "fake-image-to-video", creditsUsed: 6, usdCents: 45 });
    expect(video.data.subarray(4, 8).toString("latin1")).toBe("ftyp");
    expect(video.data.toString("utf8")).toContain("FAKE 5s 1080p");
    expect(fake.animations).toHaveLength(1);
    const ids: string[] = [];
    await fake.animate({ image: { data: photo, mimeType: "image/jpeg" }, prompt: "p", durationSeconds: 5, resolution: "480p", onSubmitted: (id) => ids.push(id) });
    await fake.animate({ image: { data: photo, mimeType: "image/jpeg" }, prompt: "p", durationSeconds: 5, resolution: "480p", resumeJobId: "x", onSubmitted: (id) => ids.push(id) });
    expect(ids).toEqual(["fake-video-2"]);
    await expect(
      fake.animate({ image: { data: Buffer.from("nao-e-imagem"), mimeType: "image/jpeg" }, prompt: "p", durationSeconds: 5, resolution: "480p" }),
    ).rejects.toMatchObject({ reason: "rejected" });
    fake.failNext();
    await expect(fake.animate({ image: { data: photo, mimeType: "image/jpeg" }, prompt: "p", durationSeconds: 5, resolution: "480p" })).rejects.toBeInstanceOf(
      StudioUnavailableError,
    );
    fake.reset();
    expect(fake.animations).toHaveLength(0);
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
