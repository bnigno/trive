// Custo estimado de uma chamada ao modelo — PURO, em centavos de dólar
// (regra 2: dinheiro é inteiro). É a MESMA tabela para todos os usos de IA
// da casa: o turno da vendedora e a ficha pela foto. Preços de tabela por
// milhão de tokens; cache lido custa 10% da entrada e cache gravado por 1 h
// custa 2×. Modelo desconhecido cai no preço do padrão da vendedora.

export type ModelUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};

export type ModelPriceUsdCentsPerMTok = {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
};

export const MODEL_PRICES_USD_CENTS_PER_MTOK: Record<string, ModelPriceUsdCentsPerMTok> = {
  "claude-sonnet-5": { input: 300, cacheRead: 30, cacheWrite: 600, output: 1500 },
  "claude-haiku-4-5": { input: 100, cacheRead: 10, cacheWrite: 200, output: 500 },
  "claude-opus-5": { input: 500, cacheRead: 50, cacheWrite: 1000, output: 2500 },
};

export const DEFAULT_PRICE_MODEL = "claude-sonnet-5";

export function priceForModel(model: string): ModelPriceUsdCentsPerMTok {
  const exact = MODEL_PRICES_USD_CENTS_PER_MTOK[model];
  if (exact) return exact;
  const family = Object.keys(MODEL_PRICES_USD_CENTS_PER_MTOK).find((key) => model.startsWith(key));
  return family
    ? MODEL_PRICES_USD_CENTS_PER_MTOK[family]
    : MODEL_PRICES_USD_CENTS_PER_MTOK[DEFAULT_PRICE_MODEL];
}

/** Centavos de dólar, arredondado para cima (nunca subestima o gasto). */
export function estimateUsageCostUsdCents(usage: ModelUsage, model: string): number {
  const price = priceForModel(model);
  const total =
    usage.inputTokens * price.input +
    usage.outputTokens * price.output +
    (usage.cacheReadTokens ?? 0) * price.cacheRead +
    (usage.cacheWriteTokens ?? 0) * price.cacheWrite;
  return Math.ceil(total / 1_000_000);
}

/** "US$ 0,03" para a faixa do rascunho. */
export function formatUsdCents(cents: number): string {
  return `US$ ${(cents / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
