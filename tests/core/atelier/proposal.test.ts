// O recado interpretado vira proposta: faixa de tamanhos expandida na ordem
// certa, custo por peça/total derivado, sala pelo slug, avisos honestos.
import { describe, expect, it } from "vitest";

import {
  expandSizeRange,
  normalizeArrivalProposal,
  parseAtelierParsed,
  sizeRank,
  type RawArrivalProposal,
} from "@/core/atelier/proposal";

const CATEGORIES = [{ id: "c-vestidos", name: "Vestidos", slug: "vestidos" }];

function raw(overrides: Partial<RawArrivalProposal> = {}): RawArrivalProposal {
  return {
    name: "Longo Dunas",
    categorySlug: "vestidos",
    description: "x".repeat(320),
    composition: "100% linho",
    careSymbols: ["hand_wash", "invalido"],
    careFreeText: "Não torcer; secar à sombra",
    fitNotes: "Corte fluido",
    colors: ["areia", "terra", "Areia"],
    sizes: ["P", "M", "G", "GG"],
    sizeRange: { from: "P", to: "GG" },
    quantityPerVariant: 3,
    totalQuantity: null,
    costCents: 12000,
    costBasis: "per_piece",
    supplierName: "Aurora",
    weightGramsEstimate: 320,
    warnings: [],
    ...overrides,
  };
}

describe("expandSizeRange / sizeRank", () => {
  it("expande faixas de letra e numéricas, em qualquer direção", () => {
    expect(expandSizeRange("P", "GG")).toEqual(["P", "M", "G", "GG"]);
    expect(expandSizeRange("gg", "p")).toEqual(["P", "M", "G", "GG"]);
    expect(expandSizeRange("36", "42")).toEqual(["36", "38", "40", "42"]);
    expect(expandSizeRange("P", "42")).toEqual([]);
    expect(expandSizeRange("10", "20")).toEqual([]);
  });

  it("ordena letras antes de números e o resto no fim", () => {
    expect(["42", "M", "PP", "38", "Único"].sort((a, b) => sizeRank(a) - sizeRank(b))).toEqual(["PP", "M", "38", "42", "Único"]);
  });
});

describe("normalizeArrivalProposal", () => {
  it("o recado do enunciado vira 2 cores × 4 tamanhos, 3 de cada, custo por peça e total", () => {
    const proposal = normalizeArrivalProposal(raw(), { categories: CATEGORIES });
    expect(proposal).toMatchObject({
      name: "Longo Dunas",
      categoryId: "c-vestidos",
      categoryName: "Vestidos",
      colors: ["Areia", "Terra"],
      sizes: ["P", "M", "G", "GG"],
      variantCount: 8,
      quantityPerVariant: 3,
      totalQuantity: 24,
      unitCostCents: 12000,
      totalCostCents: 288000,
      costBasis: "per_piece",
      supplierName: "Aurora",
      weightGrams: 320,
      careSymbols: ["hand_wash"],
      careFreeText: ["Não torcer", "secar à sombra"],
    });
    expect(proposal.warnings).toEqual([]);
  });

  it("sem lista de tamanhos, a faixa dita é expandida; faixa sem sentido vira aviso", () => {
    const fromRange = normalizeArrivalProposal(raw({ sizes: [], sizeRange: { from: "36", to: "40" } }), { categories: CATEGORIES });
    expect(fromRange.sizes).toEqual(["36", "38", "40"]);
    const broken = normalizeArrivalProposal(raw({ sizes: [], sizeRange: { from: "P", to: "44" } }), { categories: CATEGORIES });
    expect(broken.sizes).toEqual([]);
    expect(broken.variantCount).toBe(2);
    expect(broken.warnings.join(" ")).toContain("Não entendi a faixa de tamanhos");
  });

  it("custo total com quantidade vira custo por peça; sem quantidade, aviso", () => {
    const withQty = normalizeArrivalProposal(raw({ costCents: 288000, costBasis: "total" }), { categories: CATEGORIES });
    expect(withQty.unitCostCents).toBe(12000);
    expect(withQty.totalCostCents).toBe(288000);
    const noQty = normalizeArrivalProposal(raw({ costCents: 288000, costBasis: "total", quantityPerVariant: null }), { categories: CATEGORIES });
    expect(noQty.unitCostCents).toBeNull();
    expect(noQty.warnings.join(" ")).toContain("Custo total sem a quantidade");
  });

  it("custo sem base conhecida é tratado como por peça, com aviso", () => {
    const proposal = normalizeArrivalProposal(raw({ costBasis: "unknown" }), { categories: CATEGORIES });
    expect(proposal.costBasis).toBe("per_piece");
    expect(proposal.unitCostCents).toBe(12000);
    expect(proposal.warnings.join(" ")).toContain("POR PEÇA");
  });

  it("sala desconhecida, descrição curta, peso fora da faixa e quantidade absurda viram null/aviso", () => {
    const proposal = normalizeArrivalProposal(
      raw({ categorySlug: "chapeus", description: "curta", weightGramsEstimate: 9, quantityPerVariant: 5000, costCents: -5 }),
      { categories: CATEGORIES },
    );
    expect(proposal.categoryId).toBeNull();
    expect(proposal.weightGrams).toBeNull();
    expect(proposal.quantityPerVariant).toBeNull();
    expect(proposal.unitCostCents).toBeNull();
    expect(proposal.warnings.join(" ")).toContain("não existe");
    expect(proposal.warnings.join(" ")).toContain("Descrição curta");
  });

  it("JSON fora do formato lança", () => {
    expect(() => normalizeArrivalProposal({ name: "x" }, { categories: CATEGORIES })).toThrow();
  });
});

describe("parseAtelierParsed", () => {
  it("lê o que a chegada guardou e tolera lixo", () => {
    expect(parseAtelierParsed(null)).toBeNull();
    expect(parseAtelierParsed({ oi: 1 })).toBeNull();
    const ok = parseAtelierParsed({
      proposal: null,
      suggestedPriceCents: null,
      model: "m",
      usage: null,
      estimatedCostUsdCents: 0,
      ms: 12,
      failed: "ia_indisponivel",
    });
    expect(ok?.failed).toBe("ia_indisponivel");
  });
});
