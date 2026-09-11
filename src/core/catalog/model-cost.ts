// Custo estimado de uma chamada ao modelo — PURO, em centavos de dólar
// (regra 2: dinheiro é inteiro). Preços de tabela por milhão de tokens;
// desconhecido cai no preço do modelo padrão da vendedora.

export type ModelUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};

export type ModelPriceUsdPerMTok = { input: number; output: number };

/** Tabela pública (USD por milhão de tokens). Cache: leitura 10%, escrita 2× (ttl 1 h). */
export const MODEL_PRICES_USD_PER_MTOK: Record<string, ModelPriceUsdPerMTok> = {
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

export const DEFAULT_PRICE_MODEL = "claude-sonnet-5";

export function priceForModel(model: string): ModelPriceUsdPerMTok {
  const exact = MODEL_PRICES_USD_PER_MTOK[model];
  if (exact) return exact;
  const family = Object.keys(MODEL_PRICES_USD_PER_MTOK).find((key) => model.startsWith(key));
  return family ? MODEL_PRICES_USD_PER_MTOK[family] : MODEL_PRICES_USD_PER_MTOK[DEFAULT_PRICE_MODEL];
}

/** Centavos de dólar, arredondado para cima (nunca subestima o gasto). */
export function estimateUsageCostUsdCents(usage: ModelUsage, model: string): number {
  const price = priceForModel(model);
  const usd =
    (usage.inputTokens * price.input +
      usage.outputTokens * price.output +
      (usage.cacheReadTokens ?? 0) * price.input * 0.1 +
      (usage.cacheWriteTokens ?? 0) * price.input * 2) /
    1_000_000;
  return Math.ceil(usd * 100);
}

/** "US$ 0,02" para a faixa do rascunho. */
export function formatUsdCents(cents: number): string {
  return `US$ ${(cents / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
