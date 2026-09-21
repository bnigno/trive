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

export type StudioCostLine = { label: string; usdCents: number; brlCents: number };

/**
 * A conta que a dona pediu, para a tela e para o script de prévia: por foto,
 * por peça (3 cores × 3 opções) e por mês (40 peças novas), nas duas
 * qualidades — já com a retentativa média do portão e o julgamento.
 */
export function studioCostTable(input: { quality: StudioQuality; brlPerUsdCents?: number }): StudioCostLine[] {
  const rate = input.brlPerUsdCents ?? DEFAULT_BRL_PER_USD_CENTS;
  const perPhoto = creditsToUsdCents(creditsFor("tryon", input.quality, 1)) + JUDGE_USD_CENTS_PER_IMAGE;
  const perColor = estimateRequestUsdCents({ options: 3, quality: input.quality }).totalUsdCents;
  const perPiece = perColor * 3;
  const perMonth = perPiece * 40;
  const line = (label: string, usdCents: number): StudioCostLine => ({ label, usdCents, brlCents: usdCentsToBrlCents(usdCents, rate) });
  return [
    line("1 foto (geração + julgamento)", perPhoto),
    line("1 cor, 3 opções (com a retentativa do portão)", perColor),
    line("1 peça, 3 cores × 3 opções", perPiece),
    line("1 mês, 40 peças novas", perMonth),
  ];
}
