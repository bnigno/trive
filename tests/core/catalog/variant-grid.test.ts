// A grade cor × tamanho do cadastro de produto. A regra que mais importa aqui:
// quantidade em branco significa "essa combinação não existe" — é assim que o
// dono diz que o verde só veio em P e G.
import { describe, expect, it } from "vitest";

import {
  buildVariantGrid,
  combinationKey,
  gridAxes,
  selectGridVariants,
  type GridSelectionRow,
} from "@/core/catalog/variant-grid";

function row(overrides: Partial<GridSelectionRow>): GridSelectionRow {
  return { attributes: {}, sku: "", quantity: null, ...overrides };
}

describe("gridAxes", () => {
  it("declara os dois eixos quando há cor e tamanho", () => {
    expect(gridAxes(["Verde"], ["P"])).toEqual(["cor", "tamanho"]);
  });

  it("só cor, só tamanho, ou nenhum", () => {
    expect(gridAxes(["Verde"], [])).toEqual(["cor"]);
    expect(gridAxes([], ["P"])).toEqual(["tamanho"]);
    expect(gridAxes([], [])).toEqual([]);
  });

  it("ficha em branco não declara eixo", () => {
    expect(gridAxes(["   "], ["P"])).toEqual(["tamanho"]);
  });
});

describe("buildVariantGrid", () => {
  it("cruza cores e tamanhos com a cor por fora", () => {
    const grid = buildVariantGrid({
      name: "Blusa Seda",
      colors: ["Verde", "Preto"],
      sizes: ["P", "G"],
    });

    expect(grid.axes).toEqual(["cor", "tamanho"]);
    expect(grid.combinations.map((item) => item.label)).toEqual([
      "Verde · P",
      "Verde · G",
      "Preto · P",
      "Preto · G",
    ]);
  });

  it("sugere um SKU por combinação a partir do nome do produto", () => {
    const grid = buildVariantGrid({
      name: "Blusa Seda",
      colors: ["Verde"],
      sizes: ["P", "GG"],
    });

    expect(grid.combinations.map((item) => item.sku)).toEqual([
      "BLUSA-SEDA-VERD-P",
      "BLUSA-SEDA-VERD-GG",
    ]);
  });

  it("resolve colisão de SKU entre cores que abreviam igual", () => {
    const grid = buildVariantGrid({
      name: "Blusa",
      colors: ["Azul", "Azulado"],
      sizes: [],
    });

    expect(grid.combinations.map((item) => item.sku)).toEqual([
      "BLUSA-AZUL",
      "BLUSA-AZUL-2",
    ]);
  });

  it("normaliza e junta fichas repetidas", () => {
    const grid = buildVariantGrid({
      name: "Blusa",
      colors: ["preto", " Preto ", "PRETO"],
      sizes: [],
    });

    expect(grid.combinations).toHaveLength(1);
    expect(grid.combinations[0].attributes).toEqual({ cor: "Preto" });
  });

  it("só tamanhos também vira grade", () => {
    const grid = buildVariantGrid({
      name: "Blusa",
      colors: [],
      sizes: ["p", "m"],
    });

    expect(grid.axes).toEqual(["tamanho"]);
    expect(grid.combinations.map((item) => item.label)).toEqual(["P", "M"]);
    expect(grid.combinations.map((item) => item.sku)).toEqual([
      "BLUSA-P",
      "BLUSA-M",
    ]);
  });

  it("sem cor e sem tamanho é produto simples: uma linha só", () => {
    const grid = buildVariantGrid({ name: "Caneca", colors: [], sizes: [] });

    expect(grid.axes).toEqual([]);
    expect(grid.combinations).toEqual([
      { key: "[]", attributes: {}, label: "", sku: "CANECA" },
    ]);
  });

  it("dá chave distinta a cada combinação", () => {
    const grid = buildVariantGrid({
      name: "Blusa",
      colors: ["Verde", "Preto"],
      sizes: ["P", "G"],
    });

    const keys = grid.combinations.map((item) => item.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("a chave sobrevive a remontar a grade com os mesmos valores", () => {
    const first = buildVariantGrid({
      name: "Blusa",
      colors: ["Verde"],
      sizes: ["P"],
    });
    const second = buildVariantGrid({
      name: "Blusa Seda",
      colors: ["verde"],
      sizes: ["p"],
    });

    expect(second.combinations[0].key).toBe(first.combinations[0].key);
  });

  it("a chave separa os eixos: mesmo valor em eixo diferente é outra chave", () => {
    expect(combinationKey({ cor: "P" }, ["cor"])).not.toBe(
      combinationKey({ tamanho: "P" }, ["tamanho"]),
    );
  });
});

describe("selectGridVariants", () => {
  const axes = ["cor", "tamanho"];

  it("deixa de fora as combinações sem quantidade", () => {
    const variants = selectGridVariants({
      name: "Blusa",
      axes,
      rows: [
        row({ attributes: { cor: "Verde", tamanho: "P" }, quantity: 3 }),
        row({ attributes: { cor: "Verde", tamanho: "M" }, quantity: null }),
        row({ attributes: { cor: "Verde", tamanho: "G" }, quantity: 2 }),
      ],
    });

    expect(variants.map((variant) => variant.attributes.tamanho)).toEqual([
      "P",
      "G",
    ]);
  });

  it("quantidade 0 cria a variação sem estoque (diferente de branco)", () => {
    const variants = selectGridVariants({
      name: "Blusa",
      axes,
      rows: [row({ attributes: { cor: "Verde", tamanho: "P" }, quantity: 0 })],
    });

    expect(variants).toHaveLength(1);
    expect(variants[0].initialQuantity).toBe(0);
  });

  it("nenhuma quantidade preenchida não gera variação nenhuma", () => {
    expect(
      selectGridVariants({
        name: "Blusa",
        axes,
        rows: [row({ attributes: { cor: "Verde", tamanho: "P" } })],
      }),
    ).toEqual([]);
  });

  it("gera o SKU quando o campo veio em branco", () => {
    const variants = selectGridVariants({
      name: "Blusa Seda",
      axes,
      rows: [row({ attributes: { cor: "Verde", tamanho: "P" }, quantity: 1 })],
    });

    expect(variants[0].sku).toBe("BLUSA-SEDA-VERD-P");
  });

  it("respeita o SKU digitado, em caixa alta", () => {
    const variants = selectGridVariants({
      name: "Blusa",
      axes,
      rows: [
        row({
          attributes: { cor: "Verde", tamanho: "P" },
          sku: "  minha-blusa-p ",
          quantity: 1,
        }),
      ],
    });

    expect(variants[0].sku).toBe("MINHA-BLUSA-P");
  });

  it("desempata SKU digitado repetido em vez de recusar o cadastro", () => {
    const variants = selectGridVariants({
      name: "Blusa",
      axes,
      rows: [
        row({ attributes: { cor: "Verde", tamanho: "P" }, sku: "X1", quantity: 1 }),
        row({ attributes: { cor: "Verde", tamanho: "G" }, sku: "X1", quantity: 1 }),
      ],
    });

    expect(variants.map((variant) => variant.sku)).toEqual(["X1", "X1-2"]);
  });

  it("numera o SKU só entre as linhas que ficaram", () => {
    const variants = selectGridVariants({
      name: "Blusa",
      axes: ["cor"],
      rows: [
        row({ attributes: { cor: "Azul" }, quantity: null }),
        row({ attributes: { cor: "Azulado" }, quantity: 4 }),
      ],
    });

    expect(variants.map((variant) => variant.sku)).toEqual(["BLUSA-AZUL"]);
  });

  it("normaliza os valores dos eixos e ignora eixo não declarado", () => {
    const variants = selectGridVariants({
      name: "Blusa",
      axes: ["cor"],
      rows: [
        row({
          attributes: { cor: "  verde   musgo ", material: "Algodão" },
          quantity: 1,
        }),
      ],
    });

    expect(variants[0].attributes).toEqual({ cor: "Verde Musgo" });
  });

  it("aplica o mesmo preço de venda a todas as variações", () => {
    const variants = selectGridVariants({
      name: "Blusa",
      axes,
      rows: [
        row({ attributes: { cor: "Verde", tamanho: "P" }, quantity: 1 }),
        row({ attributes: { cor: "Verde", tamanho: "G" }, quantity: 1 }),
      ],
      priceCents: 12900,
    });

    expect(variants.map((variant) => variant.priceCents)).toEqual([
      12900, 12900,
    ]);
  });

  it("sem preço informado nenhuma variação nasce com preço", () => {
    const variants = selectGridVariants({
      name: "Blusa",
      axes,
      rows: [row({ attributes: { cor: "Verde", tamanho: "P" }, quantity: 1 })],
    });

    expect(variants[0].priceCents).toBeUndefined();
  });

  it("leva o custo linha a linha", () => {
    const variants = selectGridVariants({
      name: "Blusa",
      axes,
      rows: [
        row({
          attributes: { cor: "Verde", tamanho: "P" },
          quantity: 1,
          costCents: 4990,
        }),
        row({ attributes: { cor: "Verde", tamanho: "G" }, quantity: 1 }),
      ],
    });

    expect(variants.map((variant) => variant.costCents)).toEqual([
      4990,
      undefined,
    ]);
  });

  it("produto simples: uma variação sem atributos", () => {
    const variants = selectGridVariants({
      name: "Caneca",
      axes: [],
      rows: [row({ attributes: {}, quantity: 7 })],
    });

    expect(variants).toEqual([
      {
        sku: "CANECA",
        attributes: {},
        initialQuantity: 7,
        costCents: undefined,
        priceCents: undefined,
      },
    ]);
  });
});
