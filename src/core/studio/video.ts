// "A peça se mexe": a foto no corpo (aprovada) vira um vídeo curto para o
// Reels. PURO — o padrão (5 s, 1080p), o texto que guia o movimento e a
// checagem do teto antes de gastar. O movimento é contido de propósito: o
// vídeo mostra a MESMA peça da foto, sem inventar costas, estampa ou
// acessório (quando há foto das costas, ela entra como quadro final e a
// modelo gira até ela).
import type { PieceType } from "@/core/catalog/piece-types";

import { videoCreditsFor, type VideoDurationSeconds, type VideoResolution } from "./cost";

export const VIDEO_DEFAULTS = { durationSeconds: 5 as VideoDurationSeconds, resolution: "1080p" as VideoResolution };

/** O vídeo sai com este aviso na legenda: o Instagram pede o rótulo de conteúdo feito com IA. */
export const VIDEO_AI_NOTICE = "imagem ilustrativa (feita com IA a partir da peça real)";

const ACCESSORY_TYPES: ReadonlySet<string> = new Set<PieceType>(["bolsa", "cinto", "brinco", "colar", "pulseira", "relogio", "oculos", "chapeu", "lenco"]);

/**
 * O texto de movimento, em inglês (é o que o modelo do vendor entende
 * melhor): cena e luz da própria foto (as fotos-base são editoriais desde
 * 23/09), câmera parada, gesto natural e pequeno com a expressão calma da
 * modelo, tecido caindo de verdade, e a proibição explícita de mudar a peça. Com as costas, a modelo gira até
 * o quadro final. `movement` troca SÓ a frase do gesto: a proibição fica.
 */
export function buildVideoMotionPrompt(input: { pieceType: string | null; withBackView: boolean; movement?: string }): string {
  const accessory = input.pieceType !== null && ACCESSORY_TYPES.has(input.pieceType);
  const custom = input.movement?.trim();
  const movement = custom
    ? custom
    : input.withBackView
      ? "She turns slowly and naturally to show the back of the outfit, ending on the back view."
      : accessory
        ? "She makes a small natural gesture that shows the accessory, keeping a calm, confident expression."
        : "She shifts her weight and turns slightly, letting the fabric move naturally, keeping a calm, confident expression.";
  return [
    "Realistic video that keeps the scene, background and lighting exactly as in the image; the camera stays steady.",
    movement,
    "Keep the garment exactly as in the image: same color, print, buttons, belt, length and fit. Do not add accessories, text or logos. Keep her face and body the same.",
  ].join(" ");
}

/** Cabe no teto de créditos? O script e, depois, a tela checam ANTES de pedir ao vendor. */
export function videoFitsBudget(input: {
  durationSeconds: VideoDurationSeconds;
  resolution: VideoResolution;
  budgetCredits: number;
  balanceCredits: number | null;
}): { ok: true; credits: number } | { ok: false; credits: number; reason: "teto" | "saldo" } {
  const credits = videoCreditsFor(input.durationSeconds, input.resolution);
  if (credits > input.budgetCredits) return { ok: false, credits, reason: "teto" };
  if (input.balanceCredits !== null && credits > input.balanceCredits) return { ok: false, credits, reason: "saldo" };
  return { ok: true, credits };
}

// ---------------------------------------------------------------------------
// O vídeo no estúdio (botão "Fazer vídeo" + fila). A FASHN leva uns 4–5 min
// por vídeo e cada invocação da fila tem menos de 1 min: o pedido é enviado
// uma vez (o id fica gravado) e depois acompanhado em rodadas curtas.

export const STUDIO_VIDEO_STATUSES = ["queued", "submitting", "processing", "done", "failed", "discarded"] as const;
export type StudioVideoStatus = (typeof STUDIO_VIDEO_STATUSES)[number];

/**
 * queued → submitting: vai pedir à FASHN (gravado ANTES do pedido).
 * submitting → queued: a FASHN recusou por excesso de chamadas (429) — nada foi cobrado, a fila tenta de novo.
 * failed → processing: só "Buscar de novo", que acompanha o mesmo pedido pelo id (nunca pede outro).
 */
export const VIDEO_TRANSITIONS: Record<StudioVideoStatus, readonly StudioVideoStatus[]> = {
  queued: ["submitting", "failed"],
  submitting: ["processing", "queued", "failed"],
  processing: ["done", "failed"],
  done: ["discarded"],
  failed: ["processing", "discarded"],
  discarded: [],
};

const VIDEO_STATUS_LABELS: Record<StudioVideoStatus, string> = {
  queued: "na fila",
  submitting: "enviando",
  processing: "fazendo",
  done: "pronto",
  failed: "falhou",
  discarded: "descartado",
};

export class InvalidVideoTransitionError extends Error {
  constructor(from: StudioVideoStatus, to: StudioVideoStatus) {
    super(`Transição de vídeo inválida: "${VIDEO_STATUS_LABELS[from]}" não pode mudar para "${VIDEO_STATUS_LABELS[to]}".`);
    this.name = "InvalidVideoTransitionError";
  }
}

export function isStudioVideoStatus(value: string): value is StudioVideoStatus {
  return (STUDIO_VIDEO_STATUSES as readonly string[]).includes(value);
}

export function canTransitionVideo(from: StudioVideoStatus, to: StudioVideoStatus): boolean {
  return VIDEO_TRANSITIONS[from].includes(to);
}

export function assertVideoTransition(from: StudioVideoStatus, to: StudioVideoStatus): void {
  if (!canTransitionVideo(from, to)) throw new InvalidVideoTransitionError(from, to);
}

/** Na fila, enviando ou sendo feito: ainda pode gastar e ainda vai mudar sozinho. */
export function isVideoInFlight(status: string): boolean {
  return status === "queued" || status === "submitting" || status === "processing";
}

export const VIDEO_TIMING = {
  /** 1ª espera depois do envio: o 1º vídeo real levou 266 s; a varredura da fila é por minuto. */
  firstPollDelayMs: 240_000,
  /** Entre rodadas de espera (a varredura seguinte pega). */
  pollGapMs: 20_000,
  /** Desiste de esperar (o pedido segue buscável pelo id por 3 dias). */
  giveUpAfterMs: 30 * 60_000,
  /** Guardado do prazo da invocação para subir o MP4 (~16 MB) e gravar. */
  saveReserveMs: 15_000,
  /** Espera por rodada quando não há prazo da fila (scripts de desenvolvimento). */
  defaultWaitMs: 30_000,
  /** A saída da FASHN vale 3 dias: depois disso, "Buscar de novo" não tem o que buscar. */
  refetchWindowMs: 72 * 3_600_000,
  /** "Fazendo" parado há tanto tempo = a fila perdeu a rodada; libera "Buscar de novo". */
  stallMs: 10 * 60_000,
} as const;

/**
 * O que fazer com uma falha do vendor. A regra de ouro: um pedido que a
 * FASHN PODE ter aceitado nunca é pedido de novo (seria pagar duas vezes).
 * - retry_not_charged: 429 na entrada — nada cobrado, a fila tenta de novo.
 * - closed_not_charged: recusa certa (resposta < 500 na entrada, chave ausente, ou "failed" no status) — nada cobrado.
 * - closed_job_gone: a FASHN não conhece o pedido (404).
 * - uncertain_submit: a resposta do envio não chegou (rede, prazo, 5xx) — pode ter sido feito e cobrado; nunca reenviar.
 * - keep_open: pedido aceito e ainda aberto (prazo, rede, 408, 429, 5xx, saída estranha) — continua esperando pelo id.
 */
export type VideoFailureOutcome = "retry_not_charged" | "closed_not_charged" | "closed_job_gone" | "uncertain_submit" | "keep_open";

export function classifyVideoFailure(input: { reason: string; status: number | undefined; jobId: string | null }): VideoFailureOutcome {
  if (input.jobId === null) {
    if (input.reason === "rate_limited") return "retry_not_charged";
    if (input.reason === "no_key") return "closed_not_charged";
    if (input.status !== undefined && input.status < 500) return "closed_not_charged";
    return "uncertain_submit";
  }
  if (input.reason === "rejected" && input.status === undefined) return "closed_not_charged";
  if (input.status === 404) return "closed_job_gone";
  return "keep_open";
}

/** Quando olhar de novo; null = passou do prazo de desistir. */
export function nextVideoPollAt(input: { submittedAt: Date; giveUpAt: Date; now: Date; first: boolean }): Date | null {
  const at = input.first
    ? new Date(Math.max(input.submittedAt.getTime() + VIDEO_TIMING.firstPollDelayMs, input.now.getTime() + 1_500))
    : new Date(input.now.getTime() + VIDEO_TIMING.pollGapMs);
  return at.getTime() > input.giveUpAt.getTime() ? null : at;
}

/** Códigos de falha que ainda têm vídeo para buscar pelo id (pago ou prestes a ser). */
const REFETCHABLE_FAILURES = new Set(["demorou_demais", "nao_salvou"]);

/** "Buscar de novo": só com o id do pedido, dentro dos 3 dias da FASHN, e só quando a espera parou. */
export function canRefetchVideo(
  video: { status: string; vendorJobId: string | null; errorDetail: string | null; submittedAt: Date | null; updatedAt: Date },
  now: Date,
): boolean {
  if (!video.vendorJobId || !video.submittedAt) return false;
  if (now.getTime() - video.submittedAt.getTime() >= VIDEO_TIMING.refetchWindowMs) return false;
  if (video.status === "failed") {
    const code = video.errorDetail?.split(":")[0]?.trim() ?? "";
    return REFETCHABLE_FAILURES.has(code);
  }
  if (video.status === "processing") return now.getTime() - video.updatedAt.getTime() > VIDEO_TIMING.stallMs;
  return false;
}

/**
 * Pode pedir mais um vídeo? O teto é em vídeos por dia (o dia de São Paulo);
 * o saldo da FASHN, quando conhecido, precisa cobrir o vídeo inteiro.
 */
export function checkVideoRequest(input: {
  dailyLimit: number;
  usedToday: number;
  credits: number;
  balanceCredits: number | null;
}): { ok: true } | { ok: false; reason: "teto" | "saldo" } {
  if (input.usedToday >= input.dailyLimit) return { ok: false, reason: "teto" };
  if (input.balanceCredits !== null && input.credits > input.balanceCredits) return { ok: false, reason: "saldo" };
  return { ok: true };
}

/** A linha que vai na legenda do vídeo (a mesma ideia de VIDEO_AI_NOTICE, como frase). */
export const VIDEO_CAPTION_NOTICE = "Imagem ilustrativa (feita com IA a partir da peça real).";
