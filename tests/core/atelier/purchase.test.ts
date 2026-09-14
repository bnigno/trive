import { describe, expect, it } from "vitest";

import { atelierCardLines, purchaseDescription, purchaseLinesFromVariants } from "@/core/atelier/purchase";
import { formatCentsBRL } from "@/lib/money";

const variants = [
  { id: "v1", sku: "LONGO-DUNAS-AREI-P" },
  { id: "v2", sku: "LONGO-DUNAS-AREI-M" },
  { id: "v3", sku: "LONGO-DUNAS-TERR-P" },
];

describe("purchaseLinesFromVariants", () => {
  it("'três de cada' com custo por peça: uma linha por variação e o total", () => {
    const plan = purchaseLinesFromVariants(variants, { quantityPerVariant: 3, totalQuantity: 9, unitCostCents: 12000 });
    expect(plan).toEqual({
      kind: "lines",
      lines: variants.map((variant) => ({ variantId: variant.id, sku: variant.sku, quantity: 3, unitCostCents: 12000 })),
      totalQuantity: 9,
      totalCents: 108000,
    });
  });

  it("quantidade sem custo: as linhas entram sem custo e sem total em dinheiro", () => {
    const plan = purchaseLinesFromVariants(variants, { quantityPerVariant: 2, totalQuantity: 6, unitCostCents: null });
    expect(plan).toMatchObject({ kind: "lines", totalQuantity: 6, totalCents: null });
    if (plan.kind !== "lines") throw new Error("esperava linhas");
    expect(plan.lines.every((line) => line.unitCostCents === null)).toBe(true);
  });

  it("um total só serve para peça de uma variação; sem quantidade, não há compra", () => {
    expect(purchaseLinesFromVariants([variants[0]], { quantityPerVariant: null, totalQuantity: 20, unitCostCents: 5000 })).toEqual({
      kind: "lines",
      lines: [{ variantId: "v1", sku: variants[0].sku, quantity: 20, unitCostCents: 5000 }],
      totalQuantity: 20,
      totalCents: 100000,
    });
    expect(purchaseLinesFromVariants(variants, { quantityPerVariant: null, totalQuantity: 20, unitCostCents: 5000 })).toEqual({
      kind: "none",
      reason: "total_sem_grade",
    });
    expect(purchaseLinesFromVariants(variants, { quantityPerVariant: null, totalQuantity: null, unitCostCents: 5000 })).toEqual({
      kind: "none",
      reason: "sem_quantidade",
    });
    expect(purchaseLinesFromVariants([], { quantityPerVariant: 1, totalQuantity: 1, unitCostCents: 5000 })).toEqual({
      kind: "none",
      reason: "sem_variacoes",
    });
  });
});

describe("purchaseDescription / atelierCardLines", () => {
  it("descreve a compra para o financeiro", () => {
    expect(purchaseDescription({ productName: "Longo Dunas", totalQuantity: 24, supplierName: "Aurora" })).toBe(
      "Compra: 24 peças de Longo Dunas — Aurora (Ateliê pelo WhatsApp)",
    );
    expect(purchaseDescription({ productName: "Blusa", totalQuantity: 1, supplierName: null })).toBe("Compra: 1 peça de Blusa (Ateliê pelo WhatsApp)");
  });

  it("as linhas do cartão só dizem o que se sabe, no máximo três", () => {
    expect(atelierCardLines({ colors: 2, sizes: 4, totalQuantity: 24, unitCostCents: 12000, supplierName: "Aurora", payableCents: 288000 })).toEqual([
      "2 cores × 4 tamanhos",
      `24 peças · custo ${formatCentsBRL(12000)}`,
      `Aurora · a pagar ${formatCentsBRL(288000)}`,
    ]);
    expect(atelierCardLines({ colors: 0, sizes: 0, totalQuantity: null, unitCostCents: null, supplierName: null, payableCents: null })).toEqual([]);
    expect(atelierCardLines({ colors: 1, sizes: 0, totalQuantity: 1, unitCostCents: null, supplierName: null, payableCents: null })).toEqual(["1 cor", "1 peça"]);
    const long = atelierCardLines({ colors: 0, sizes: 0, totalQuantity: null, unitCostCents: null, supplierName: "Aurora Confecções e Tecidos do Norte Ltda", payableCents: 288000 });
    expect(long).toHaveLength(1);
    expect(long[0].length).toBeLessThanOrEqual(44);
    // O dinheiro nunca é cortado: o nome encolhe.
    expect(long[0]).toMatch(new RegExp(`… · a pagar ${formatCentsBRL(288000).replace(/[$.]/g, "\\$&")}$`));
    const huge = atelierCardLines({ colors: 0, sizes: 0, totalQuantity: null, unitCostCents: null, supplierName: "Fornecedor", payableCents: 12_345_678_900 });
    expect(huge[0]).toBe(`Fornecedor · a pagar ${formatCentsBRL(12_345_678_900)}`);
  });
});
