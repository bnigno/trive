// Normalização dos eixos de variação: o UNIQUE (product_id, attributes) do
// banco é literal, então tudo que grava attributes tem de passar por aqui.
import { describe, expect, it } from "vitest";

import {
  axisValues,
  buildAttributes,
  cartesian,
  normalizeAxisValue,
  variantLabel,
} from "@/core/catalog/attributes";

describe("normalizeAxisValue", () => {
  it("apara espaço das pontas", () => {
    expect(normalizeAxisValue("  Preto  ")).toBe("Preto");
  });

  it("colapsa espaço interno", () => {
    expect(normalizeAxisValue("azul    marinho")).toBe("Azul Marinho");
  });

  it("capitaliza cada palavra e rebaixa o resto", () => {
    expect(normalizeAxisValue("PRETO")).toBe("Preto");
    expect(normalizeAxisValue("verde MUSGO")).toBe("Verde Musgo");
  });

  it("preserva acento ao capitalizar", () => {
    expect(normalizeAxisValue("índigo")).toBe("Índigo");
    expect(normalizeAxisValue("ÁGUA marinha")).toBe("Água Marinha");
  });

  it.each([
    ["pp", "PP"],
    ["p", "P"],
    ["m", "M"],
    ["g", "G"],
    ["gg", "GG"],
    ["xg", "XG"],
    [" Gg ", "GG"],
  ])("sigla de tamanho %s fica em caixa alta (%s)", (input, expected) => {
    expect(normalizeAxisValue(input)).toBe(expected);
  });

  it("palavra curta que não é sigla de tamanho é só capitalizada", () => {
    expect(normalizeAxisValue("cru")).toBe("Cru");
  });

  it("string vazia ou só espaço vira vazio", () => {
    expect(normalizeAxisValue("")).toBe("");
    expect(normalizeAxisValue("   ")).toBe("");
  });

  it("é idempotente", () => {
    const once = normalizeAxisValue("  azul   MARINHO ");
    expect(normalizeAxisValue(once)).toBe(once);
  });

  it("colapsa a variação de caixa que duplicaria a variante", () => {
    expect(normalizeAxisValue("preto")).toBe(normalizeAxisValue("Preto"));
  });
});

describe("buildAttributes", () => {
  it("monta só os eixos declarados, normalizados", () => {
    expect(
      buildAttributes(["cor", "tamanho"], { cor: " preto ", tamanho: "gg" }),
    ).toEqual({ cor: "Preto", tamanho: "GG" });
  });

  it("ignora valor de eixo não declarado", () => {
    expect(
      buildAttributes(["cor"], {
        cor: "verde",
        tamanho: "P",
        material: "algodão",
      }),
    ).toEqual({ cor: "Verde" });
  });

  it("eixo sem valor (ou com valor em branco) não entra no objeto", () => {
    expect(
      buildAttributes(["cor", "tamanho"], { cor: "verde", tamanho: "  " }),
    ).toEqual({ cor: "Verde" });
  });

  it("sem eixos devolve objeto vazio", () => {
    expect(buildAttributes([], { cor: "verde" })).toEqual({});
  });
});

describe("axisValues", () => {
  it("lista os valores do eixo sem repetir, na ordem em que aparecem", () => {
    const variants = [
      { cor: "Verde", tamanho: "P" },
      { cor: "Azul", tamanho: "P" },
      { cor: "Verde", tamanho: "M" },
    ];
    expect(axisValues("cor", variants)).toEqual(["Verde", "Azul"]);
    expect(axisValues("tamanho", variants)).toEqual(["P", "M"]);
  });

  it("ignora variação sem o eixo e devolve vazio para eixo desconhecido", () => {
    const variants: Record<string, string>[] = [
      { cor: "Verde" },
      {},
      { tamanho: "P" },
    ];
    expect(axisValues("cor", variants)).toEqual(["Verde"]);
    expect(axisValues("tecido", variants)).toEqual([]);
    expect(axisValues("cor", [])).toEqual([]);
  });
});

describe("variantLabel", () => {
  it("segue a ordem de attributes_schema, não a do objeto", () => {
    const attributes = { tamanho: "P", cor: "Verde" };
    expect(variantLabel(attributes, ["cor", "tamanho"])).toBe("Verde · P");
    expect(variantLabel(attributes, ["tamanho", "cor"])).toBe("P · Verde");
  });

  it("pula eixo ausente no attributes", () => {
    expect(variantLabel({ cor: "Verde" }, ["cor", "tamanho"])).toBe("Verde");
  });

  it("sem eixos devolve vazio", () => {
    expect(variantLabel({ cor: "Verde" }, [])).toBe("");
    expect(variantLabel({}, ["cor"])).toBe("");
  });
});

describe("cartesian", () => {
  it("combina dois eixos na ordem natural de leitura", () => {
    expect(
      cartesian([
        { name: "cor", values: ["verde", "azul"] },
        { name: "tamanho", values: ["p", "m"] },
      ]),
    ).toEqual([
      { cor: "Verde", tamanho: "P" },
      { cor: "Verde", tamanho: "M" },
      { cor: "Azul", tamanho: "P" },
      { cor: "Azul", tamanho: "M" },
    ]);
  });

  it("com um eixo só devolve uma combinação por valor", () => {
    expect(cartesian([{ name: "tamanho", values: ["p", "m", "gg"] }])).toEqual([
      { tamanho: "P" },
      { tamanho: "M" },
      { tamanho: "GG" },
    ]);
  });

  it("sem nenhum eixo devolve a única variante sem atributos", () => {
    expect(cartesian([])).toEqual([{}]);
  });

  it("eixo sem valores não restringe a grade", () => {
    expect(
      cartesian([
        { name: "cor", values: ["verde"] },
        { name: "tamanho", values: [] },
      ]),
    ).toEqual([{ cor: "Verde" }]);
  });

  it("valores que normalizam igual entram uma vez só", () => {
    expect(
      cartesian([{ name: "cor", values: ["preto", "Preto", " PRETO "] }]),
    ).toEqual([{ cor: "Preto" }]);
  });

  it("três eixos: o último é o que mais varia", () => {
    const combinations = cartesian([
      { name: "cor", values: ["verde", "azul"] },
      { name: "tamanho", values: ["p", "m"] },
      { name: "tecido", values: ["seda", "linho"] },
    ]);
    expect(combinations).toHaveLength(8);
    expect(combinations[0]).toEqual({
      cor: "Verde",
      tamanho: "P",
      tecido: "Seda",
    });
    expect(combinations[1]).toEqual({
      cor: "Verde",
      tamanho: "P",
      tecido: "Linho",
    });
    expect(combinations[7]).toEqual({
      cor: "Azul",
      tamanho: "M",
      tecido: "Linho",
    });
  });
});
