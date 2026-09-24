// Ensaio da peça no corpo: gerador de imagem atrás de interface própria.
// real = FASHN (fashn.ts): try-on que TRANSFERE a peça para a foto-base da
// modelo sem redesenhar estampa, e model-create para as fotos-base das
// modelos da casa. fake = devolve a própria foto com faixa "FAKE" (fake.ts),
// para o fluxo inteiro rodar em dev e nos testes. Seleção por ADAPTER_MODE.
//
// A interface é neutra de propósito: peça + foto da modelo + texto da cena.
// Outro vendor (Gemini, gpt-image) entra como outro client sem tocar em
// core/service/UI.
import type { VideoDurationSeconds, VideoResolution } from "@/core/studio/cost";
import type { StudioQuality } from "@/core/studio/presets";
import type { StudioGarmentCategory } from "@/core/studio/prompts";

import { getAdapterMode } from "../adapter-mode";
import { FakeImageStudio } from "./fake";
import { FashnImageStudio } from "./fashn";

export type StudioImageInput = {
  data: Buffer;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
};

/** 3:4 casa com as molduras dos cartões (post 540×720, story 900×1200). */
export type StudioAspectRatio = "3:4" | "4:5" | "9:16";

export type StudioImage = {
  data: Buffer;
  mimeType: "image/jpeg" | "image/png";
  /** "fashn", "fake"… — vai para o audit e para a proveniência. */
  vendor: string;
  vendorModel: string;
  /** O que a tabela do vendor cobra por esta imagem (a API não devolve o gasto). */
  creditsUsed: number;
  usdCents: number;
  elapsedMs: number;
  seed: number | null;
};

export type CreateModelPhotoInput = {
  /** Texto completo (core/studio/prompts: modelo + corpo + cena + regra da casa). */
  prompt: string;
  aspectRatio: StudioAspectRatio;
  /** 1–4 candidatas numa chamada só. */
  count: number;
  quality: StudioQuality;
  seed?: number;
  /** Cancela a espera quando o orçamento de tempo do handler estoura. */
  signal?: AbortSignal;
};

export type GenerateOnModelInput = {
  /** A foto real da peça (esticada/cabide) — é ela que o try-on transfere. */
  garment: StudioImageInput;
  /** A foto-base da modelo da casa, na cena e no corpo escolhidos. */
  model: StudioImageInput;
  category: StudioGarmentCategory | "auto";
  /** Só o vendor de qualidade alta lê; o econômico mantém a cena da foto-base. */
  scenePrompt: string;
  count: number;
  quality: StudioQuality;
  seed?: number;
  signal?: AbortSignal;
};

export type AnimateInput = {
  /** A foto no corpo aprovada — o primeiro quadro do vídeo. */
  image: StudioImageInput;
  /** Foto das costas (opcional): o último quadro, para o giro mostrar a costa real. */
  endImage?: StudioImageInput;
  /** O movimento (core/studio/video: buildVideoMotionPrompt). */
  prompt: string;
  durationSeconds: VideoDurationSeconds;
  resolution: VideoResolution;
  signal?: AbortSignal;
  /** Chamado com o id do pedido assim que o vendor aceita (e cobra): quem chama guarda para retomar. */
  onSubmitted?: (jobId: string) => void;
  /** Retoma um pedido já feito (só espera e baixa, sem pedir — e pagar — de novo). */
  resumeJobId?: string;
};

export type StudioVideo = {
  data: Buffer;
  mimeType: "video/mp4";
  vendor: string;
  vendorModel: string;
  creditsUsed: number;
  usdCents: number;
  elapsedMs: number;
};

export interface ImageStudio {
  createModelPhoto(input: CreateModelPhotoInput): Promise<StudioImage[]>;
  generateOnModel(input: GenerateOnModelInput): Promise<StudioImage[]>;
  /** "A peça se mexe": a foto vira um vídeo curto (MP4). */
  animate(input: AnimateInput): Promise<StudioVideo>;
}

/**
 * Por que não gerou — quem chama escolhe o que fazer: sem chave e sem
 * crédito são configuração (avisar a dona); recusado é ESTE pedido
 * (foto ruim, moderação); cota, tempo, rede e queda passam com o tempo.
 */
export type StudioFailureReason =
  | "no_key"
  | "no_credits"
  | "rejected"
  | "rate_limited"
  | "timeout"
  | "network"
  | "invalid_response"
  | "unavailable";

const RETRYABLE_REASONS: ReadonlySet<StudioFailureReason> = new Set(["rate_limited", "timeout", "network", "unavailable"]);

export class StudioUnavailableError extends Error {
  readonly reason: StudioFailureReason;
  readonly status: number | undefined;
  /** Passageira: vale a fila tentar de novo daqui a pouco. */
  readonly retryable: boolean;

  constructor(message: string, reason: StudioFailureReason = "unavailable", status?: number) {
    super(message);
    this.name = "StudioUnavailableError";
    this.reason = reason;
    this.status = status;
    this.retryable = RETRYABLE_REASONS.has(reason);
  }
}

/** 1–4 imagens por chamada, como o vendor aceita. */
export function clampStudioCount(count: number): number {
  return Math.min(4, Math.max(1, Math.trunc(count)));
}

/** Há como gerar neste ambiente? (fake: sempre; real: com FASHN_API_KEY). */
export function isImageStudioConfigured(): boolean {
  if (getAdapterMode() !== "real") return true;
  return typeof process.env.FASHN_API_KEY === "string" && process.env.FASHN_API_KEY.trim() !== "";
}

let instance: ImageStudio | undefined;

export function getImageStudio(): ImageStudio {
  if (!instance) {
    instance = getAdapterMode() === "real" ? new FashnImageStudio() : new FakeImageStudio();
  }
  return instance;
}
