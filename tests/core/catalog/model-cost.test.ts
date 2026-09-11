// Custo estimado por chamada ao modelo (PURO), em centavos de dólar.
import { describe, expect, it } from "vitest";

import {
  estimateUsageCostUsdCents,
  formatUsdCents,
  MODEL_PRICES_USD_PER_MTOK,
  priceForModel,
} from "@/core/catalog/model-cost";

describe("estimateUsageCostUsdCents", () => {
  it("usa a tabela do modelo, cache a 10%/2× e arredonda para cima", () => {
    // 4 200 tokens de entrada × US$ 2/M + 800 de saída × US$ 10/M = 0,0084 + 0,008 = US$ 0,0164 → 2 centavos.
    expect(estimateUsageCostUsdCents({ inputTokens: 4200, outputTokens: 800 }, "claude-sonnet-5")).toBe(2);
    expect(estimateUsageCostUsdCents({ inputTokens: 4200, outputTokens: 800 }, "claude-haiku-4-5")).toBe(1);
    expect(
      estimateUsageCostUsdCents(
        { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 },
        "claude-sonnet-5",
      ),
    ).toBe(Math.ceil((2 * 0.1 + 2 * 2) * 100));
    expect(estimateUsageCostUsdCents({ inputTokens: 0, outputTokens: 0 }, "claude-sonnet-5")).toBe(0);
  });

  it("modelo desconhecido cai na família pelo prefixo ou no padrão", () => {
    expect(priceForModel("claude-haiku-4-5-20251001")).toEqual(MODEL_PRICES_USD_PER_MTOK["claude-haiku-4-5"]);
    expect(priceForModel("gpt-x")).toEqual(MODEL_PRICES_USD_PER_MTOK["claude-sonnet-5"]);
  });

  it("formata em dólar com vírgula", () => {
    expect(formatUsdCents(2)).toBe("US$ 0,02");
    expect(formatUsdCents(1234)).toBe("US$ 12,34");
  });
});
