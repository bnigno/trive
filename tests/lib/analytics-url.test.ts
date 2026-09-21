import { describe, expect, it } from "vitest";

import { anonymizeAnalyticsUrl } from "@/lib/analytics-url";

describe("anonymizeAnalyticsUrl", () => {
  it("apaga tokens de pedido e lançamento e o cupom; mantém o resto", () => {
    expect(anonymizeAnalyticsUrl("https://trivemaison.com.br/pedido/8785e2d7-8050?novo=1")).toBe(
      "https://trivemaison.com.br/pedido?novo=1",
    );
    expect(anonymizeAnalyticsUrl("https://trivemaison.com.br/lancamento/abc123/longo-dunas")).toBe(
      "https://trivemaison.com.br/lancamento",
    );
    expect(anonymizeAnalyticsUrl("https://trivemaison.com.br/checkout?cep=01310100&cupom=BEMVINDA10")).toBe(
      "https://trivemaison.com.br/checkout?cep=01310100",
    );
    expect(anonymizeAnalyticsUrl("https://trivemaison.com.br/c/MARIA-K7X2M")).toBe("https://trivemaison.com.br/c");
    expect(anonymizeAnalyticsUrl("https://trivemaison.com.br/produto/longo-dunas")).toBe(
      "https://trivemaison.com.br/produto/longo-dunas",
    );
    expect(anonymizeAnalyticsUrl("/produtos?categoria=vestidos")).toBe(
      "https://trivemaison.com.br/produtos?categoria=vestidos",
    );
  });
});
