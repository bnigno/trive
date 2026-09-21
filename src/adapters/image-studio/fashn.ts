import { z } from "zod";

import { creditsFor, creditsToUsdCents, type StudioCall } from "@/core/studio/cost";
import type { StudioQuality } from "@/core/studio/presets";

import {
  clampStudioCount,
  StudioUnavailableError,
  type CreateModelPhotoInput,
  type GenerateOnModelInput,
  type ImageStudio,
  type StudioImage,
  type StudioImageInput,
} from "./index";

const BASE_URL = "https://api.fashn.ai/v1";
/** Uma chamada HTTP (o POST ou um GET de status/CDN). */
const REQUEST_TIMEOUT_MS = 15_000;
/** Entre duas consultas de status. */
const POLL_INTERVAL_MS = 1_500;
/** Teto da espera pelo resultado: quality 4K leva ~55 s na doc; 2K balanced ~25 s. */
const MAX_WAIT_MS = 90_000;
/** Consultas de status que podem falhar seguidas (rede, 5xx) antes de desistir de um pedido já pago. */
const MAX_POLL_FAILURES = 3;
/** O que a doc chama cada modelo. */
export const FASHN_MODELS = {
  tryonLight: "tryon-v1.6",
  tryonMax: "tryon-max",
  modelCreate: "model-create",
} as const;

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
    const inputs =
      input.quality === "alta"
        ? { resolution: "2k", generation_mode: "quality" }
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

  private async run(job: {
    call: StudioCall;
    quality: StudioQuality;
    modelName: string;
    inputs: Record<string, unknown>;
    count: number;
    seed: number;
    signal?: AbortSignal;
  }): Promise<StudioImage[]> {
    const apiKey = process.env.FASHN_API_KEY?.trim();
    if (!apiKey) throw new StudioUnavailableError("FASHN_API_KEY não configurada.", "no_key");
    const headers = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    const startedAt = this.now();

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

    const deadline = startedAt + MAX_WAIT_MS;
    let pollFailures = 0;
    for (;;) {
      if (job.signal?.aborted) throw new StudioUnavailableError("O ensaio não ficou pronto no prazo.", "timeout");
      if (this.now() >= deadline) throw new StudioUnavailableError("A FASHN demorou demais para responder.", "timeout");
      await this.sleep(POLL_INTERVAL_MS, job.signal);
      let raw: unknown;
      try {
        raw = await this.request(`${BASE_URL}/status/${encodeURIComponent(run.data.id)}`, {
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
      if (outputs.length === 0) throw new StudioUnavailableError("A FASHN terminou sem imagem.", "invalid_response");
      const elapsedMs = this.now() - startedAt;
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
    return Buffer.from(await response.arrayBuffer());
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
      // Nunca o corpo: pode ecoar o prompt ou a imagem. O status diz o bastante.
      const status = response.status;
      const reason =
        status === 401 || status === 403
          ? "no_key"
          : status === 402
            ? "no_credits"
            : status === 429
              ? "rate_limited"
              : status < 500
                ? "rejected"
                : "unavailable";
      throw new StudioUnavailableError(`A FASHN respondeu HTTP ${status}.`, reason, status);
    }
    try {
      return await response.json();
    } catch {
      throw new StudioUnavailableError("A FASHN devolveu uma resposta inválida.", "invalid_response");
    }
  }
}

function networkError(error: unknown): StudioUnavailableError {
  const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
  return new StudioUnavailableError(
    timedOut ? "A FASHN não respondeu a tempo." : "Sem conexão com a FASHN.",
    timedOut ? "timeout" : "network",
  );
}

/** Toda chamada HTTP tem o seu próprio teto, além do prazo de quem chama. */
function withRequestTimeout(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
