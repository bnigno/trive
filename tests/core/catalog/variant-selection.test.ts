// Qual variação a página do produto considera escolhida. Regra pura: o seletor
// e a barra fixa de compra só apresentam o que sai daqui.
import { describe, expect, it } from "vitest";

import {
  findMatchedVariant,
  initialAxisSelection,
} from "@/core/catalog/variant-selection";

type Variant = {
  sku: string;
  attributes: Record<string, string>;
  availableQty: number;
};

const axes = ["cor", "tamanho"];
const verdeP: Variant = { sku: "V-P", attributes: { cor: "Verde", tamanho: "P" }, availableQty: 0 };
const verdeM: Variant = { sku: "V-M", attributes: { cor: "Verde", tamanho: "M" }, availableQty: 3 };
const azulM: Variant = { sku: "A-M", attributes: { cor: "Azul", tamanho: "M" }, availableQty: 1 };

describe("initialAxisSelection", () => {
  it("prefere a primeira variante COM estoque", () => {
    expect(initialAxisSelection(axes, [verdeP, verdeM, azulM])).toEqual({
      cor: "Verde",
      tamanho: "M",
    });
  });

  it("cai na primeira variante quando tudo está esgotado", () => {
    const esgotadas = [verdeP, { ...azulM, availableQty: 0 }];
    expect(initialAxisSelection(axes, esgotadas)).toEqual({
      cor: "Verde",
      tamanho: "P",
    });
  });

  it("ignora eixo sem valor na variante e devolve vazio sem variantes", () => {
    const semTamanho: Variant = { sku: "X", attributes: { cor: "Rosa" }, availableQty: 2 };
    expect(initialAxisSelection(axes, [semTamanho])).toEqual({ cor: "Rosa" });
    expect(initialAxisSelection(axes, [])).toEqual({});
  });
});

describe("findMatchedVariant", () => {
  it("acha a variante que casa com todos os eixos", () => {
    expect(
      findMatchedVariant(axes, [verdeP, verdeM, azulM], { cor: "Azul", tamanho: "M" }),
    ).toBe(azulM);
  });

  it("devolve undefined para combinação inexistente ou seleção incompleta", () => {
    expect(findMatchedVariant(axes, [verdeP, verdeM, azulM], { cor: "Azul", tamanho: "P" })).toBeUndefined();
    expect(findMatchedVariant(axes, [verdeP, verdeM, azulM], { cor: "Verde" })).toBeUndefined();
  });

  it("produto sem eixos devolve a primeira variante", () => {
    const unica: Variant = { sku: "U", attributes: {}, availableQty: 5 };
    expect(findMatchedVariant([], [unica], {})).toBe(unica);
    expect(findMatchedVariant([], [], {})).toBeUndefined();
  });
});
