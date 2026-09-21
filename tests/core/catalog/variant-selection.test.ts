// Qual variação a página do produto considera escolhida. Regra pura: o seletor
// e a barra fixa de compra só apresentam o que sai daqui.
import { describe, expect, it } from "vitest";

import {
  findMatchedVariant,
  initialAxisSelection,
  selectAxisValue,
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

// Grade esparsa, como a TRIVÉ compra: cada cor veio num único tamanho.
const nani40: Variant = { sku: "B-36", attributes: { cor: "Nani", tamanho: "40" }, availableQty: 1 };
const marmore36: Variant = { sku: "B-36-6", attributes: { cor: "Mármore", tamanho: "36" }, availableQty: 1 };
const ceu38: Variant = { sku: "B-38-8", attributes: { cor: "Céu", tamanho: "38" }, availableQty: 0 };
const ocean38: Variant = { sku: "B-38-1", attributes: { cor: "Ocean", tamanho: "38" }, availableQty: 1 };
const prata40: Variant = { sku: "B-40-3", attributes: { cor: "Prata", tamanho: "40" }, availableQty: 1 };
const bermudas = [nani40, marmore36, ceu38, ocean38, prata40];

describe("selectAxisValue", () => {
  it("combinação que existe (mesmo esgotada) só troca o eixo tocado", () => {
    // Verde/P está esgotada, mas existe: a cliente pediu P em Verde e é isso
    // que ela vê — o "me avisa quando voltar" depende de chegar aqui.
    expect(
      selectAxisValue(axes, [verdeP, verdeM, azulM], { cor: "Verde", tamanho: "M" }, "tamanho", "P"),
    ).toEqual({ cor: "Verde", tamanho: "P" });
  });

  it("grade esparsa: tocar numa cor de outro tamanho leva ao tamanho dela", () => {
    expect(
      selectAxisValue(axes, bermudas, { cor: "Nani", tamanho: "40" }, "cor", "Mármore"),
    ).toEqual({ cor: "Mármore", tamanho: "36" });
  });

  it("grade esparsa: tocar num tamanho prefere a cor COM estoque, mesmo que venha depois", () => {
    expect(
      selectAxisValue(axes, bermudas, { cor: "Nani", tamanho: "40" }, "tamanho", "38"),
    ).toEqual({ cor: "Ocean", tamanho: "38" });
  });

  it("valor só com peças esgotadas vai para a primeira delas", () => {
    const soCeu = [nani40, ceu38];
    expect(
      selectAxisValue(axes, soCeu, { cor: "Nani", tamanho: "40" }, "tamanho", "38"),
    ).toEqual({ cor: "Céu", tamanho: "38" });
  });

  it("valor que não existe em nenhuma variante só troca o eixo (combinação indisponível)", () => {
    const next = selectAxisValue(axes, bermudas, { cor: "Nani", tamanho: "40" }, "tamanho", "52");
    expect(next).toEqual({ cor: "Nani", tamanho: "52" });
    expect(findMatchedVariant(axes, bermudas, next)).toBeUndefined();
  });

  it("tocar no valor já escolhido não muda nada", () => {
    expect(
      selectAxisValue(axes, bermudas, { cor: "Nani", tamanho: "40" }, "cor", "Nani"),
    ).toEqual({ cor: "Nani", tamanho: "40" });
  });
});
