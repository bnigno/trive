import { describe, expect, it } from "vitest";

import { expandArrivalGrid } from "@/core/atelier/grid";

describe("expandArrivalGrid", () => {
  it("2 cores × 4 tamanhos = 8 variações com SKU, custo por peça e estoque zero", () => {
    const { axes, variants } = expandArrivalGrid("Longo Dunas", {
      colors: ["Areia", "Terra"],
      sizes: ["P", "M", "G", "GG"],
      unitCostCents: 12000,
      weightGrams: 320,
    });
    expect(axes).toEqual(["cor", "tamanho"]);
    expect(variants).toHaveLength(8);
    expect(variants[0]).toEqual({
      sku: "LONGO-DUNAS-AREI-P",
      attributes: { cor: "Areia", tamanho: "P" },
      initialQuantity: 0,
      costCents: 12000,
      weightGrams: 320,
    });
    expect(new Set(variants.map((variant) => variant.sku)).size).toBe(8);
  });

  it("sem cor nem tamanho, uma variação simples; sem custo, sem costCents", () => {
    const { axes, variants } = expandArrivalGrid("Blusa", { colors: [], sizes: [], unitCostCents: null, weightGrams: null });
    expect(axes).toEqual([]);
    expect(variants).toEqual([{ sku: "BLUSA", attributes: {}, initialQuantity: 0 }]);
  });
});
