import { z } from "zod";

import { creditsFor, creditsToUsdCents, videoCreditsFor, type StudioCall } from "@/core/studio/cost";
import type { StudioQuality } from "@/core/studio/presets";

import {
  clampStudioCount,
  StudioUnavailableError,
  type AnimateInput,
  type CreateModelPhotoInput,
  type GenerateOnModelInput,
  type ImageStudio,
  type StudioImage,
  type StudioImageInput,
  type StudioVideo,
} from "./index";

const BASE_URL = "https://api.fashn.ai/v1";
/** Uma chamada HTTP (o POST ou um GET de status/CDN). */
const REQUEST_TIMEOUT_MS = 15_000;
/** Entre duas consultas de status. */
const POLL_INTERVAL_MS = 1_500;
/** Teto da espera pelo resultado: quality 4K leva ~55 s na doc; 2K balanced ~25 s. */
const MAX_WAIT_MS = 90_000;
/** Vídeo demora mais que foto (a doc não diz quanto; o 1º teste real levou 266 s): até 10 min. */
const VIDEO_MAX_WAIT_MS = 600_000;
/** Baixar o MP4 (alguns MB) do CDN deles. */
const VIDEO_DOWNLOAD_TIMEOUT_MS = 120_000;
/** Teto do arquivo: 5–10 s em 1080p passam longe disso; mais que isso é resposta errada. */
const VIDEO_MAX_BYTES = 60 * 1024 * 1024;
/** Consultas de status que podem falhar seguidas (rede, 5xx) antes de desistir de um pedido já pago. */
const MAX_POLL_FAILURES = 3;
/** O que a doc chama cada modelo. */
export const FASHN_MODELS = {
  tryonLight: "tryon-v1.6",
  tryonMax: "tryon-max",
  modelCreate: "model-create",
  imageToVideo: "image-to-video",
} as const;

const creditsResponseSchema = z.looseObject({
  credits: z.looseObject({ total: z.number(), subscription: z.number().optional(), on_demand: z.number().optional() }),
});

const runResponseSchema = z.looseObject({
  id: z.string().min(1).optional(),
  error: z.unknown().optional(),
});
const statusResponseSchema = z.looseObject({
  status: z.string(),
  output: z.array(z.string()).nullable().optional(),
  error: z
    .union([z.string(), z.looseObject({ name: z.string().optional(), message: z.string().optional() })])
    .nullable()
    .optional(),
});

type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<Response>;

type Deps = {
  fetchImpl?: FetchLike;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
};

function dataUri(image: StudioImageInput): string {
  return `data:${image.mimeType};base64,${image.data.toString("base64")}`;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", done);
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * Cliente REAL da FASHN via fetch nativo (sem SDK: três chamadas). Fluxo
 * assíncrono: POST /run devolve um id; GET /status/{id} até "completed" (ou
 * "failed"); a saída vem em base64 (`return_base64`) ou como URL do CDN
 * deles, que expira em 3 dias — por isso quem chama guarda no Storage na
 * hora. Corpo de erro nunca é relançado (não vaza nada nos logs).
 */
export class FashnImageStudio implements ImageStudio {
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly now: () => number;

  constructor(deps: Deps = {}) {
    this.fetchImpl = deps.fetchImpl ?? ((input, init) => fetch(input, init));
    this.sleep = deps.sleep ?? defaultSleep;
    this.now = deps.now ?? (() => Date.now());
  }

  async createModelPhoto(input: CreateModelPhotoInput): Promise<StudioImage[]> {
    const count = clampStudioCount(input.count);
    // Sempre "balanced": o modo "quality" da doc leva ~55 s, além do prazo
    // de quem chama pela fila; a resolução é o que muda com a qualidade.
    const inputs =
      input.quality === "alta"
        ? { resolution: "2k", generation_mode: "balanced" }
        : { resolution: "1k", generation_mode: "balanced" };
    return this.run({
      call: "model_photo",
      quality: input.quality,
      modelName: FASHN_MODELS.modelCreate,
      inputs: {
        prompt: input.prompt,
        aspect_ratio: input.aspectRatio,
        ...inputs,
        seed: input.seed ?? 42,
        num_images: count,
        output_format: "jpeg",
        return_base64: true,
      },
      count,
      seed: input.seed ?? 42,
      signal: input.signal,
    });
  }

  async generateOnModel(input: GenerateOnModelInput): Promise<StudioImage[]> {
    const count = clampStudioCount(input.count);
    const seed = input.seed ?? 42;
    if (input.quality === "alta") {
      return this.run({
        call: "tryon",
        quality: input.quality,
        modelName: FASHN_MODELS.tryonMax,
        inputs: {
          product_image: dataUri(input.garment),
          model_image: dataUri(input.model),
          prompt: input.scenePrompt,
          resolution: "2k",
          generation_mode: "balanced",
          seed,
          num_images: count,
          output_format: "jpeg",
          return_base64: true,
        },
        count,
        seed,
        signal: input.signal,
      });
    }
    return this.run({
      call: "tryon",
      quality: input.quality,
      modelName: FASHN_MODELS.tryonLight,
      inputs: {
        model_image: dataUri(input.model),
        garment_image: dataUri(input.garment),
        category: input.category,
        // A peça chega esticada ou em cabide: é o caso "flat-lay" da doc.
        garment_photo_type: "flat-lay",
        mode: "balanced",
        segmentation_free: true,
        seed,
        num_samples: count,
        output_format: "jpeg",
        return_base64: true,
      },
      count,
      seed,
      signal: input.signal,
    });
  }

  /**
   * "A peça se mexe": a foto no corpo vira MP4 (image-to-video). A saída vem
   * como URL do CDN deles; o vídeo é baixado na hora (a URL expira).
   */
  async animate(input: AnimateInput): Promise<StudioVideo> {
    const { outputs, elapsedMs } = await this.runJob({
      modelName: FASHN_MODELS.imageToVideo,
      inputs: {
        image: dataUri(input.image),
        prompt: input.prompt,
        duration: input.durationSeconds,
        resolution: input.resolution,
        ...(input.endImage ? { end_image: dataUri(input.endImage) } : {}),
      },
      maxWaitMs: VIDEO_MAX_WAIT_MS,
      signal: input.signal,
      onSubmitted: input.onSubmitted,
      resumeJobId: input.resumeJobId,
    });
    const credits = videoCreditsFor(input.durationSeconds, input.resolution);
    return {
      data: await this.readVideo(outputs[0], input.signal),
      mimeType: "video/mp4",
      vendor: "fashn",
      vendorModel: FASHN_MODELS.imageToVideo,
      creditsUsed: credits,
      usdCents: creditsToUsdCents(credits),
      elapsedMs,
    };
  }

  /** Saldo da conta (GET /credits, grátis): o script de prévia confere antes de gastar. */
  async creditsBalance(signal?: AbortSignal): Promise<number> {
    const raw = await this.request(`${BASE_URL}/credits`, { method: "GET", headers: this.headers(), signal });
    const parsed = creditsResponseSchema.safeParse(raw);
    if (!parsed.success) throw new StudioUnavailableError("A FASHN devolveu o saldo fora do formato.", "invalid_response");
    return parsed.data.credits.total;
  }

  private headers(): Record<string, string> {
    const apiKey = process.env.FASHN_API_KEY?.trim();
    if (!apiKey) throw new StudioUnavailableError("FASHN_API_KEY não configurada.", "no_key");
    return {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
  }

  private async run(job: {
    call: StudioCall;
    quality: StudioQuality;
    modelName: string;
    inputs: Record<string, unknown>;
    count: number;
    seed: number;
    signal?: AbortSignal;
  }): Promise<StudioImage[]> {
    const { outputs, elapsedMs } = await this.runJob({ modelName: job.modelName, inputs: job.inputs, maxWaitMs: MAX_WAIT_MS, signal: job.signal });
    const credits = creditsFor(job.call, job.quality, 1);
    const images: StudioImage[] = [];
    for (const output of outputs.slice(0, job.count)) {
      images.push({
        data: await this.readOutput(output, job.signal),
        mimeType: "image/jpeg",
        vendor: "fashn",
        vendorModel: job.modelName,
        creditsUsed: credits,
        usdCents: creditsToUsdCents(credits),
        elapsedMs,
        seed: job.seed,
      });
    }
    return images;
  }

  /**
   * POST /run e GET /status até "completed": devolve as saídas cruas (base64
   * ou URL). Com `resumeJobId`, pula o POST e só acompanha um pedido já feito.
   */
  private async runJob(job: {
    modelName: string;
    inputs: Record<string, unknown>;
    maxWaitMs: number;
    signal?: AbortSignal;
    onSubmitted?: (jobId: string) => void;
    resumeJobId?: string;
  }): Promise<{ outputs: string[]; elapsedMs: number }> {
    const headers = this.headers();
    const startedAt = this.now();

    let jobId = job.resumeJobId?.trim();
    if (job.resumeJobId !== undefined && !jobId) {
      // Retomar com id vazio nunca vira pedido novo (e pago).
      throw new StudioUnavailableError("Pedido para retomar sem id.", "rejected");
    }
    if (!jobId) {
      const started = await this.request(`${BASE_URL}/run`, {
        method: "POST",
        headers,
        body: JSON.stringify({ model_name: job.modelName, inputs: job.inputs }),
        signal: job.signal,
      });
      const run = runResponseSchema.safeParse(started);
      if (!run.success || !run.data.id) {
        throw new StudioUnavailableError("A FASHN não devolveu o id do pedido.", "invalid_response");
      }
      jobId = run.data.id;
      job.onSubmitted?.(jobId);
    }

    const deadline = startedAt + job.maxWaitMs;
    let pollFailures = 0;
    for (;;) {
      if (job.signal?.aborted) throw new StudioUnavailableError("A FASHN não terminou no prazo de quem pediu.", "timeout");
      if (this.now() >= deadline) throw new StudioUnavailableError("A FASHN demorou demais para responder.", "timeout");
      await this.sleep(POLL_INTERVAL_MS, job.signal);
      let raw: unknown;
      try {
        raw = await this.request(`${BASE_URL}/status/${encodeURIComponent(jobId)}`, {
          method: "GET",
          headers,
          signal: job.signal,
        });
      } catch (error) {
        // Uma consulta que falha de passagem não joga fora o pedido já pago.
        pollFailures += 1;
        if (error instanceof StudioUnavailableError && error.retryable && pollFailures < MAX_POLL_FAILURES) continue;
        throw error;
      }
      pollFailures = 0;
      const status = statusResponseSchema.safeParse(raw);
      if (!status.success) throw new StudioUnavailableError("A FASHN devolveu um status fora do formato.", "invalid_response");
      if (status.data.status === "failed") {
        const name = typeof status.data.error === "object" && status.data.error ? status.data.error.name : undefined;
        throw new StudioUnavailableError(`A FASHN recusou este pedido${name ? ` (${name})` : ""}.`, "rejected");
      }
      if (status.data.status !== "completed") continue;
      const outputs = status.data.output ?? [];
      if (outputs.length === 0) throw new StudioUnavailableError("A FASHN terminou sem saída.", "invalid_response");
      return { outputs, elapsedMs: this.now() - startedAt };
    }
  }

  /** O MP4 vem por URL do CDN deles: baixado com teto de tempo e de tamanho, e conferido. */
  private async readVideo(output: string | undefined, signal?: AbortSignal): Promise<Buffer> {
    if (!output || !/^https:\/\//i.test(output)) throw new StudioUnavailableError("A FASHN devolveu um vídeo ilegível.", "invalid_response");
    let response: Response;
    try {
      const timeout = AbortSignal.timeout(VIDEO_DOWNLOAD_TIMEOUT_MS);
      response = await this.fetchImpl(output, { method: "GET", signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    } catch (error) {
      throw networkError(error);
    }
    if (!response.ok) throw new StudioUnavailableError(`O vídeo da FASHN respondeu HTTP ${response.status}.`, "unavailable", response.status);
    if (Number(response.headers.get("content-length") ?? 0) > VIDEO_MAX_BYTES) {
      throw new StudioUnavailableError("O vídeo da FASHN veio grande demais.", "invalid_response");
    }
    const data = await readBody(response);
    if (data.byteLength === 0 || data.byteLength > VIDEO_MAX_BYTES) {
      throw new StudioUnavailableError("O vídeo da FASHN veio vazio ou grande demais.", "invalid_response");
    }
    // MP4 tem "ftyp" nos bytes 4–7: qualquer outra coisa (página de erro, imagem) é resposta errada.
    if (data.subarray(4, 8).toString("latin1") !== "ftyp") {
      throw new StudioUnavailableError("A FASHN devolveu algo que não é MP4.", "invalid_response");
    }
    return data;
  }

  /** A saída vem como data URI (base64) ou como URL do CDN — os dois viram Buffer. */
  private async readOutput(output: string, signal?: AbortSignal): Promise<Buffer> {
    const dataMatch = /^data:image\/[a-z]+;base64,(.+)$/i.exec(output);
    if (dataMatch) return Buffer.from(dataMatch[1], "base64");
    if (!/^https:\/\//i.test(output)) throw new StudioUnavailableError("A FASHN devolveu uma saída ilegível.", "invalid_response");
    let response: Response;
    try {
      response = await this.fetchImpl(output, { method: "GET", signal: withRequestTimeout(signal) });
    } catch (error) {
      throw networkError(error);
    }
    if (!response.ok) throw new StudioUnavailableError(`A imagem da FASHN respondeu HTTP ${response.status}.`, "unavailable", response.status);
    return readBody(response);
  }

  private async request(
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, { ...init, signal: withRequestTimeout(init.signal) });
    } catch (error) {
      throw networkError(error);
    }
    if (!response.ok) {
      // Do corpo, só o NOME do erro (nunca a mensagem: pode ecoar o prompt).
      // A FASHN responde 429 tanto para "muitas chamadas" quanto para "sem
      // crédito" — e sem crédito não melhora com o tempo (achado em produção).
      const status = response.status;
      const errorName = await readErrorName(response);
      const outOfCredits = /credit|balance|quota|insufficient/i.test(errorName);
      const reason =
        status === 401 || status === 403
          ? "no_key"
          : status === 402 || ((status === 429 || status === 400) && outOfCredits)
            ? "no_credits"
            : status === 429
              ? "rate_limited"
              : status < 500
                ? "rejected"
                : "unavailable";
      throw new StudioUnavailableError(
        `A FASHN respondeu HTTP ${status}${errorName ? ` (${errorName})` : ""}.`,
        reason,
        status,
      );
    }
    try {
      return await response.json();
    } catch {
      throw new StudioUnavailableError("A FASHN devolveu uma resposta inválida.", "invalid_response");
    }
  }
}

/**
 * `error.name` do corpo de erro da FASHN ("OutOfCredits", "RateLimit"…);
 * vazio quando não há. Só um identificador (letras, sem espaço) passa: uma
 * frase seria a mensagem, e mensagem pode ecoar o prompt.
 */
async function readErrorName(response: Response): Promise<string> {
  try {
    const raw: unknown = await response.json();
    const error = (raw as { error?: unknown })?.error;
    const candidate = typeof error === "string" ? error : (error as { name?: unknown })?.name;
    return typeof candidate === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,59}$/.test(candidate) ? candidate : "";
  } catch {
    return "";
  }
}

function networkError(error: unknown): StudioUnavailableError {
  const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
  return new StudioUnavailableError(
    timedOut ? "A FASHN não respondeu a tempo." : "Sem conexão com a FASHN.",
    timedOut ? "timeout" : "network",
  );
}

/** O corpo chega depois dos cabeçalhos: queda ou prazo no meio do download também é erro de rede. */
async function readBody(response: Response): Promise<Buffer> {
  try {
    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    throw networkError(error);
  }
}

/** Toda chamada HTTP tem o seu próprio teto, além do prazo de quem chama. */
function withRequestTimeout(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
