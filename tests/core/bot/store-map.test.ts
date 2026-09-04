import { describe, expect, it } from "vitest";

import { renderStoreMap } from "@/core/bot/store-map";
import { formatCentsBRL } from "@/lib/money";

describe("renderStoreMap", () => {
  it("null com catálogo vazio", () => {
    expect(
      renderStoreMap({ totalProducts: 0, categories: [], colors: [], sizes: [] }),
    ).toBeNull();
  });

  it("lista categorias com contagem, faixa de preço, cores e tamanhos", () => {
    const texto = renderStoreMap({
      totalProducts: 13,
      categories: [
        { name: "Vestidos", slug: "vestidos", productCount: 12, priceFromCents: 18900, priceToCents: 45900 },
        { name: "Sem categoria", slug: "", productCount: 1, priceFromCents: 9900, priceToCents: 9900 },
      ],
      colors: ["Preto", "Verde"],
      sizes: ["P", "M", "G"],
    });
    expect(texto).toContain("13 peças ativas no catálogo.");
    expect(texto).toContain(
      `• Vestidos (categoria: vestidos) — 12 peças, ${formatCentsBRL(18900)} a ${formatCentsBRL(45900)}`,
    );
    expect(texto).toContain(`• Sem categoria — 1 peça, ${formatCentsBRL(9900)}`);
    expect(texto).toContain("Cores com estoque: Preto, Verde.");
    expect(texto).toContain("Tamanhos com estoque: P, M, G.");
  });

  it("corta listas longas de valores sem esconder que há mais", () => {
    const cores = Array.from({ length: 30 }, (_, i) => `Cor ${i}`);
    const texto = renderStoreMap({
      totalProducts: 1,
      categories: [{ name: "X", slug: "x", productCount: 1, priceFromCents: 1, priceToCents: 1 }],
      colors: cores,
      sizes: [],
    });
    expect(texto).toContain("e mais 6.");
    expect(texto).not.toContain("Tamanhos com estoque");
  });
});
