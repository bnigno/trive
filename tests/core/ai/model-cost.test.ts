// Custo estimado por chamada ao modelo (PURO), em centavos de dólar — a
// mesma tabela para o turno da vendedora e para a ficha pela foto.
import { describe, expect, it } from "vitest";

import {
  estimateUsageCostUsdCents,
  formatUsdCents,
  MODEL_PRICES_USD_CENTS_PER_MTOK,
  priceForModel,
} from "@/core/ai/model-cost";

describe("estimateUsageCostUsdCents", () => {
  it("usa a tabela do modelo, cache a 10%/2× e arredonda para cima", () => {
    // 4 200 de entrada × US$ 3/M + 800 de saída × US$ 15/M = 0,0126 + 0,012 = US$ 0,0246 → 3 centavos.
    expect(estimateUsageCostUsdCents({ inputTokens: 4200, outputTokens: 800 }, "claude-sonnet-5")).toBe(3);
    expect(estimateUsageCostUsdCents({ inputTokens: 4200, outputTokens: 800 }, "claude-haiku-4-5")).toBe(1);
    expect(
      estimateUsageCostUsdCents(
        { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 },
        "claude-sonnet-5",
      ),
    ).toBe(30 + 600);
    expect(estimateUsageCostUsdCents({ inputTokens: 0, outputTokens: 0 }, "claude-sonnet-5")).toBe(0);
  });

  it("modelo desconhecido cai na família pelo prefixo ou no padrão", () => {
    expect(priceForModel("claude-haiku-4-5-20251001")).toEqual(
      MODEL_PRICES_USD_CENTS_PER_MTOK["claude-haiku-4-5"],
    );
    expect(priceForModel("gpt-x")).toEqual(MODEL_PRICES_USD_CENTS_PER_MTOK["claude-sonnet-5"]);
    expect(priceForModel("claude-opus-5")).toEqual(MODEL_PRICES_USD_CENTS_PER_MTOK["claude-opus-5"]);
  });

  it("formata em dólar com vírgula", () => {
    expect(formatUsdCents(3)).toBe("US$ 0,03");
    expect(formatUsdCents(1234)).toBe("US$ 12,34");
  });
});
