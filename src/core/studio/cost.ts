// Custo do ensaio em centavos de dólar (regra 2: inteiro). A FASHN cobra em
// créditos (US$ 0,075 cada, sob demanda); a tabela por chamada é a da doc
// (tryon-v1.6 = 1; tryon-max e model-create por modo × resolução). A API não
// devolve o gasto: o cliente registra o que a tabela diz — e o painel
// arredonda para cima, nunca subestima.
import type { StudioQuality } from "./presets";

/** US$ 0,075 por crédito = 7,5 centavos; guardado em décimos de centavo. */
export const FASHN_USD_TENTHS_OF_CENT_PER_CREDIT = 75;

export function creditsToUsdCents(credits: number): number {
  return Math.ceil((credits * FASHN_USD_TENTHS_OF_CENT_PER_CREDIT) / 10);
}

export type StudioCall = "tryon" | "model_photo";

/**
 * Créditos por imagem de saída. Econômica: try-on v1.6 (1) e foto-base em
 * 1K balanced (2). Alta: try-on max 2K balanced (3) e foto-base em 2K quality (4).
 */
export const FASHN_CREDITS_PER_IMAGE: Record<StudioCall, Record<StudioQuality, number>> = {
  tryon: { economica: 1, alta: 3 },
  model_photo: { economica: 2, alta: 4 },
};

export function creditsFor(call: StudioCall, quality: StudioQuality, count: number): number {
  return FASHN_CREDITS_PER_IMAGE[call][quality] * count;
}

export type StudioRequestEstimate = {
  credits: number;
  vendorUsdCents: number;
  judgeUsdCents: number;
  totalUsdCents: number;
};

/** Julgamento de fidelidade (2 imagens ≈ 4k tokens no claude-sonnet-5): ~US$ 0,014. */
export const JUDGE_USD_CENTS_PER_IMAGE = 2;

/** Quanto custa um pedido de N opções, contando a retentativa média do portão (20%). */
export function estimateRequestUsdCents(input: {
  options: number;
  quality: StudioQuality;
  retryShare?: number;
}): StudioRequestEstimate {
  const retryShare = input.retryShare ?? 0.2;
  const images = Math.ceil(input.options * (1 + retryShare));
  const credits = creditsFor("tryon", input.quality, images);
  const vendorUsdCents = creditsToUsdCents(credits);
  const judgeUsdCents = JUDGE_USD_CENTS_PER_IMAGE * images;
  return { credits, vendorUsdCents, judgeUsdCents, totalUsdCents: vendorUsdCents + judgeUsdCents };
}

/** Câmbio de referência para a tela ("≈ R$ 2,70"); a dona ajusta nas configurações se quiser. */
export const DEFAULT_BRL_PER_USD_CENTS = 550;

export function usdCentsToBrlCents(usdCents: number, brlPerUsdCents = DEFAULT_BRL_PER_USD_CENTS): number {
  return Math.ceil((usdCents * brlPerUsdCents) / 100);
}
