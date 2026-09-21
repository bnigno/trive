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

  it("Edições de Belém entram com slug, contagem e vigência (no ar / começa em N dias / fora do horário)", () => {
    const texto = renderStoreMap({
      totalProducts: 3,
      categories: [{ name: "Vestidos", slug: "vestidos", productCount: 3, priceFromCents: 100, priceToCents: 200 }],
      colors: [],
      sizes: [],
      editions: [
        { name: "Edição Círio", slug: "edicao-cirio", productCount: 2, current: true, daysUntil: 0 },
        { name: "Natal", slug: "natal", productCount: 1, current: false, daysUntil: 90 },
        { name: "Chuva das 14h", slug: "chuva", productCount: 4, current: false, daysUntil: null, kind: "hours" },
        { name: "Chuva do Círio", slug: "chuva-cirio", productCount: 2, current: false, daysUntil: 0, kind: "period_hours" },
      ],
    });
    expect(texto).toContain("Edições de Belém (curadoria por ocasião; filtre com edicao em listar_produtos):");
    expect(texto).toContain("• Edição Círio (edicao: edicao-cirio) — 2 peças, NO AR");
    expect(texto).toContain("• Natal (edicao: natal) — 1 peça, começa em 90 dias");
    expect(texto).toContain("• Chuva das 14h (edicao: chuva) — 4 peças, fora do horário agora");
    expect(texto).toContain("• Chuva do Círio (edicao: chuva-cirio) — 2 peças, fora do horário agora");
    // Sem edições, o bloco não aparece.
    expect(
      renderStoreMap({ totalProducts: 1, categories: [{ name: "X", slug: "x", productCount: 1, priceFromCents: 1, priceToCents: 1 }], colors: [], sizes: [], editions: [] }),
    ).not.toContain("Edições de Belém");
  });

  it("tipos de peça viram sub-linhas da categoria, com 'sem tipo' e a dica de que categoria aceita tipo; sem tipos, a saída é a de sempre", () => {
    const base = { totalProducts: 33, colors: [], sizes: [] };
    const semTipos = renderStoreMap({ ...base, categories: [{ name: "Vestuário", slug: "vestuario", productCount: 33, priceFromCents: 8900, priceToCents: 45900 }] });
    expect(semTipos).not.toContain("tipo:");
    expect(semTipos).not.toContain("listar_produtos.categoria");

    const comTipos = renderStoreMap({
      ...base,
      categories: [
        {
          name: "Vestuário",
          slug: "vestuario",
          productCount: 33,
          priceFromCents: 8900,
          priceToCents: 45900,
          types: [
            { type: "vestido", label: "Vestidos", productCount: 12, priceFromCents: 18900, priceToCents: 45900 },
            { type: "corset", label: "Corsets", productCount: 4, priceFromCents: 22900, priceToCents: 28900 },
          ],
          untyped: 2,
        },
      ],
    });
    expect(comTipos).toContain(`• Vestuário (categoria: vestuario) — 33 peças, ${formatCentsBRL(8900)} a ${formatCentsBRL(45900)}`);
    expect(comTipos).toContain(`  – Vestidos (tipo: vestido) — 12 peças, ${formatCentsBRL(18900)} a ${formatCentsBRL(45900)}`);
    expect(comTipos).toContain(`  – Corsets (tipo: corset) — 4 peças, ${formatCentsBRL(22900)} a ${formatCentsBRL(28900)}`);
    expect(comTipos).toContain("  – sem tipo marcado — 2 peças (o filtro por tipo não as vê; busque pelo nome)");
    // Categoria com peças mas NENHUM tipo marcado: a Lia fica sabendo que o filtro está cego.
    const cega = renderStoreMap({ ...base, categories: [{ name: "Vestuário", slug: "vestuario", productCount: 33, priceFromCents: 8900, priceToCents: 45900, types: [], untyped: 33 }] });
    expect(cega).toContain("  – sem tipo marcado — 33 peças");
    expect(cega).toContain("listar_produtos.categoria");
    expect(comTipos).toContain('Em listar_produtos.categoria vale a categoria OU o tipo (ex.: "corset").');
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
