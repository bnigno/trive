// Plano das etiquetas da peça: padrão de uma por variação ativa, quantidades
// explícitas, tetos e repartição em folhas de 24.
import { describe, expect, it } from "vitest";

import {
  LABELS_MAX_PER_VARIANT,
  LABELS_MAX_TOTAL,
  LABELS_PER_SHEET,
  planProductLabels,
  type LabelVariant,
} from "@/core/catalog/labels";

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
) {
  return planProductLabels({
    storeName: "TRIVÉ",
    productName: "Longo Dunas",
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
      storeName: "TRIVÉ",
      productName: "Bolsa Lua",
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
    expect(result.sheets.map((sheet) => sheet.length)).toEqual([LABELS_PER_SHEET, 6]);
    expect(plan({ [verdeP.id]: 0 }).sheets).toEqual([]);
  });

  it("lista os SKUs pedidos sem preço ativo", () => {
    expect(plan(null).withoutPrice).toEqual(["LONGO-VERDE-M"]);
    expect(plan({ [verdeP.id]: 1 }).withoutPrice).toEqual([]);
  });
});
