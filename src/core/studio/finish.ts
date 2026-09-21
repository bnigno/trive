// Acabamento das fotos geradas: a foto de IA não pode "saltar" ao lado das
// reais no feed. Os números vivem aqui (PURO); quem aplica é
// services/studio-finish.ts com sharp.

export type FinishPreset = {
  /** Desvio-padrão do grão gaussiano (0 = sem grão). */
  grainSigma: number;
  /** Opacidade da vinheta nas bordas, 0–1. */
  vignette: number;
  /** Multiplicador de saturação (1 = inalterada). */
  saturation: number;
  /** Maior lado após o acabamento — o mesmo teto das fotos reais no upload. */
  maxEdge: number;
  /** Qualidade JPEG — a mesma família das fotos reais dos cartões. */
  jpegQuality: number;
};

export const FINISH_PRESET: FinishPreset = {
  grainSigma: 6,
  vignette: 0.12,
  saturation: 0.94,
  maxEdge: 1600,
  jpegQuality: 85,
};

/** Grão e vinheta são opcionais no preset; o resto sempre se aplica. */
export function finishStepsFor(preset: FinishPreset): { grain: boolean; vignette: boolean } {
  return { grain: preset.grainSigma > 0, vignette: preset.vignette > 0 };
}
