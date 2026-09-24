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
 * melhor): câmera parada, gesto natural e pequeno, tecido caindo de verdade,
 * e a proibição explícita de mudar a peça. Com as costas, a modelo gira até
 * o quadro final.
 */
export function buildVideoMotionPrompt(input: { pieceType: string | null; withBackView: boolean }): string {
  const accessory = input.pieceType !== null && ACCESSORY_TYPES.has(input.pieceType);
  const movement = input.withBackView
    ? "She turns slowly and naturally to show the back of the outfit, ending on the back view."
    : accessory
      ? "She makes a small natural gesture that shows the accessory, with a relaxed smile."
      : "She shifts her weight and turns slightly, letting the fabric move naturally, with a relaxed smile.";
  return [
    "Realistic smartphone video in soft natural daylight; the camera stays steady.",
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
