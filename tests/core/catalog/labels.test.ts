// Plano das etiquetas da peça: padrão de uma por variação ativa, quantidades
// explícitas, tetos por folha, repartição em folhas (24 adesivas, 9 tags de
// cabide), os modelos para a gráfica e o corpo do nome na tag.
import { describe, expect, it } from "vitest";

import {
  hangTagNameSizePt,
  serifLinesFor,
  LABELS_MAX_PER_VARIANT,
  LABELS_MAX_SHEETS,
  LABELS_PER_SHEET,
  labelsMaxTotal,
  planProductLabels,
  type LabelModel,
  type LabelVariant,
} from "@/core/catalog/labels";

const LABELS_MAX_TOTAL = labelsMaxTotal("adesiva");
const PRODUCT_URL = "https://trivemaison.com.br/produto/longo-dunas";

const AXES = ["cor", "tamanho"] as const;

const verdeP: LabelVariant = {
  id: "11111111-1111-4111-8111-111111111111",
  sku: "LONGO-VERDE-P",
  attributes: { tamanho: "P", cor: "Verde" },
  isActive: true,
  priceCents: 28900,
};
const verdeM: LabelVariant = {
  id: "22222222-2222-4222-8222-222222222222",
  sku: "LONGO-VERDE-M",
  attributes: { tamanho: "M", cor: "Verde" },
  isActive: true,
  priceCents: null,
};
const terraP: LabelVariant = {
  id: "33333333-3333-4333-8333-333333333333",
  sku: "LONGO-TERRA-P",
  attributes: { tamanho: "P", cor: "Terra" },
  isActive: false,
  priceCents: 28900,
};

function plan(
  quantities: Record<string, number> | null,
  variants: readonly LabelVariant[] = [verdeP, verdeM, terraP],
  model: LabelModel = "adesiva",
) {
  return planProductLabels({
    model,
    storeName: "TRIVÉ",
    productName: "Longo Dunas",
    composition: "100% linho",
    productUrl: PRODUCT_URL,
    axes: AXES,
    variants,
    quantities,
  });
}

describe("planProductLabels", () => {
  it("sem quantidades: uma etiqueta por variação ativa, inativa fica de fora", () => {
    const result = plan(null);
    expect(result.lines.map((line) => line.quantity)).toEqual([1, 1, 0]);
    expect(result.labels.map((label) => label.sku)).toEqual(["LONGO-VERDE-P", "LONGO-VERDE-M"]);
    expect(result.truncated).toBe(false);
  });

  it("com quantidades: só o que foi pedido, inclusive variação inativa", () => {
    const result = plan({ [terraP.id]: 3 });
    expect(result.lines.map((line) => line.quantity)).toEqual([0, 0, 3]);
    expect(result.labels).toHaveLength(3);
    expect(result.labels.every((label) => label.sku === "LONGO-TERRA-P")).toBe(true);
  });

  it("ignora id que não é do produto", () => {
    const result = plan({ "99999999-9999-4999-8999-999999999999": 5, [verdeP.id]: 2 });
    expect(result.labels).toHaveLength(2);
  });

  it("monta o rótulo na ordem dos eixos, não na ordem das chaves", () => {
    const [label] = plan({ [verdeP.id]: 1 }).labels;
    expect(label.variantLabel).toBe("Verde · P");
    expect(label.storeName).toBe("TRIVÉ");
    expect(label.productName).toBe("Longo Dunas");
    expect(label.priceCents).toBe(28900);
  });

  it("produto sem eixos sai com rótulo vazio", () => {
    const result = planProductLabels({
      model: "adesiva",
      storeName: "TRIVÉ",
      productName: "Bolsa Lua",
      composition: null,
      productUrl: PRODUCT_URL,
      axes: [],
      variants: [{ ...verdeP, attributes: {} }],
      quantities: null,
    });
    expect(result.labels[0].variantLabel).toBe("");
  });

  it("chaves são estáveis por variação e índice", () => {
    const result = plan({ [verdeP.id]: 2 });
    expect(result.labels.map((label) => label.key)).toEqual([`${verdeP.id}:0`, `${verdeP.id}:1`]);
  });

  it("apara quantidade por variação: negativa vira 0, acima do teto vira o teto, decimal trunca", () => {
    const result = plan({ [verdeP.id]: -4, [verdeM.id]: 999, [terraP.id]: 2.9 });
    expect(result.lines.map((line) => line.quantity)).toEqual([0, LABELS_MAX_PER_VARIANT, 2]);
    expect(result.truncated).toBe(false);
  });

  it("corta o total no teto a partir das últimas variações e avisa", () => {
    const result = plan({ [verdeP.id]: 200, [verdeM.id]: 200, [terraP.id]: 200 });
    expect(result.labels).toHaveLength(LABELS_MAX_TOTAL);
    expect(result.lines.map((line) => line.quantity)).toEqual([200, 200, LABELS_MAX_TOTAL - 400]);
    expect(result.truncated).toBe(true);
  });

  it("reparte em folhas de 24", () => {
    const result = plan({ [verdeP.id]: 30 });
    expect(result.sheets.map((sheet) => sheet.length)).toEqual([LABELS_PER_SHEET.adesiva, 6]);
    expect(plan({ [verdeP.id]: 0 }).sheets).toEqual([]);
  });

  it("lista os SKUs pedidos sem preço ativo", () => {
    expect(plan(null).withoutPrice).toEqual(["LONGO-VERDE-M"]);
    expect(plan({ [verdeP.id]: 1 }).withoutPrice).toEqual([]);
  });

  it("cada etiqueta leva a composição e a página da peça (o QR da tag)", () => {
    const [label] = plan({ [verdeP.id]: 1 }).labels;
    expect(label.composition).toBe("100% linho");
    expect(label.productUrl).toBe(PRODUCT_URL);
  });
});

describe("planProductLabels — tag de cabide", () => {
  it("o teto é por folhas: 20 folhas de 9 tags (180) contra 20 de 24 adesivas (480)", () => {
    expect(LABELS_MAX_SHEETS).toBe(20);
    expect(LABELS_PER_SHEET).toEqual({ adesiva: 24, cabide: 9 });
    expect(labelsMaxTotal("cabide")).toBe(180);
    expect(labelsMaxTotal("adesiva")).toBe(480);
  });

  it("reparte em folhas de 9 e corta em 180", () => {
    const result = plan({ [verdeP.id]: 20 }, undefined, "cabide");
    expect(result.sheets.map((sheet) => sheet.length)).toEqual([9, 9, 2]);
    const capped = plan({ [verdeP.id]: 100, [verdeM.id]: 100 }, undefined, "cabide");
    expect(capped.labels).toHaveLength(180);
    expect(capped.lines.map((line) => line.quantity)).toEqual([100, 80, 0]);
    expect(capped.truncated).toBe(true);
  });

  it("modelos para a gráfica: um por variação pedida, na ordem, com a quantidade — inativa incluída se pedida", () => {
    const result = plan({ [terraP.id]: 4, [verdeP.id]: 2 }, undefined, "cabide");
    expect(result.designs.map((design) => [design.key, design.sku, design.quantity])).toEqual([
      [verdeP.id, "LONGO-VERDE-P", 2],
      [terraP.id, "LONGO-TERRA-P", 4],
    ]);
    expect(result.designs[0].productUrl).toBe(PRODUCT_URL);
    expect(plan({ [verdeP.id]: 0 }, undefined, "cabide").designs).toEqual([]);
  });

  it("na gráfica não há folhas: capTotal false deixa passar as quantidades (só o teto por variação)", () => {
    const result = planProductLabels({
      model: "cabide",
      storeName: "TRIVÉ",
      productName: "Longo Dunas",
      composition: null,
      productUrl: PRODUCT_URL,
      axes: AXES,
      variants: [verdeP, verdeM, terraP],
      quantities: { [verdeP.id]: 100, [verdeM.id]: 100, [terraP.id]: 999 },
      capTotal: false,
    });
    expect(result.designs.map((design) => design.quantity)).toEqual([100, 100, LABELS_MAX_PER_VARIANT]);
    expect(result.truncated).toBe(false);
    expect(result.labels).toHaveLength(400);
  });
});

describe("hangTagNameSizePt (métrica da Cormorant SemiBold medida no Chrome)", () => {
  // Cada corpo abaixo foi conferido no Chrome: o nome cabe em 2 linhas de 45 mm nesse corpo.
  it.each([
    ["Longo Dunas", 13],
    ["Vestido Longo Dunas em Linho com Fenda", 13],
    ["Camisa Social Feminina Manga Longa", 13],
    ["Saia Midi Plissada Cetim Acetinado Champanhe", 13],
    ["Conjunto Cropped e Saia Midi Plissada Marfim", 11.5],
    ["Camisa Oversized Manga Bufante Algodão Orgânico", 11.5],
    ["Vestido Longo Dunas em Linho com Fenda Lateral", 11.5],
    ["VESTIDO LONGO DUNAS EM LINHO COM FENDA", 10],
    ["Macacão Pantalona Alfaiataria Amêndoa Premium", 10],
    ["CAMISA OVERSIZED LINHO BEGE COM BOLSOS FRONTAIS", 9],
  ])("%s → %s pt", (name, pt) => {
    expect(hangTagNameSizePt(name)).toBe(pt);
    expect(serifLinesFor(name, pt, 45)).toBeLessThanOrEqual(2);
  });

  it("quebra por palavra como o navegador: uma palavra maior que a linha ainda conta linhas", () => {
    expect(serifLinesFor("Longo Dunas", 13, 45)).toBe(1);
    expect(serifLinesFor("Vestido Longo Dunas em Linho com Fenda", 13, 45)).toBe(2);
    expect(serifLinesFor("Supercalifragilisticexpialidocious", 13, 20)).toBeGreaterThanOrEqual(2);
    // Nome absurdo: cai no menor corpo (o clamp da página corta o resto).
    expect(hangTagNameSizePt("VESTIDO LONGO DUNAS EM LINHO PURO COM FENDA LATERAL E ALÇAS AJUSTÁVEIS BORDADAS")).toBe(9);
  });
});
