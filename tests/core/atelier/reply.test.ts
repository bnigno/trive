import { describe, expect, it } from "vitest";

import { formatCentsBRL } from "@/lib/money";

import {
  ATELIER_HELP_REASONS,
  arrivalDetailsLine,
  atelierDraftVars,
  atelierHelpReasonText,
  isAtelierHelpReason,
  photosLabel,
} from "@/core/atelier/reply";

describe("resposta do Ateliê", () => {
  it("conta as fotos em português", () => {
    expect(photosLabel(1)).toBe("1 foto");
    expect(photosLabel(3)).toBe("3 fotos");
  });

  it("monta as variáveis do template owner_atelier_draft", () => {
    expect(atelierDraftVars({ name: "Longo Dunas", photos: 2, link: "https://x/admin/produtos/1" })).toEqual({
      peca: "Longo Dunas",
      fotos: "2 fotos",
      link: "https://x/admin/produtos/1",
      detalhes: "",
    });
  });

  it("a linha de detalhes só diz o que se sabe", () => {
    const full = {
      colors: ["Areia", "Terra"],
      sizes: ["P", "M", "G", "GG"],
      quantityPerVariant: 3,
      totalQuantity: 24,
      unitCostCents: 12000,
      totalCostCents: 288000,
      costBasis: "per_piece" as const,
      supplierName: "Aurora",
    };
    expect(arrivalDetailsLine(full, 28990)).toBe(
      ` · 2 cores × 4 tamanhos · 3 de cada (24 peças) · custo ${formatCentsBRL(12000)} · sugerido ${formatCentsBRL(28990)} · Aurora`,
    );
    expect(arrivalDetailsLine({ ...full, colors: [], quantityPerVariant: null, totalQuantity: 10, unitCostCents: null, supplierName: null }, null)).toBe(
      ` · 4 tamanhos · 10 peças · custo total ${formatCentsBRL(288000)}`,
    );
    expect(arrivalDetailsLine({ ...full, colors: [], sizes: [], quantityPerVariant: null, totalQuantity: null, unitCostCents: null, totalCostCents: null, supplierName: null }, null)).toBe("");
    expect(arrivalDetailsLine(null, 100)).toBe("");
  });

  it("todo motivo de ajuda tem texto e é reconhecido pelo guard", () => {
    for (const reason of Object.keys(ATELIER_HELP_REASONS)) {
      expect(isAtelierHelpReason(reason)).toBe(true);
      expect(atelierHelpReasonText(reason as keyof typeof ATELIER_HELP_REASONS).length).toBeGreaterThan(10);
    }
    expect(isAtelierHelpReason("qualquer")).toBe(false);
    expect(atelierHelpReasonText("documento")).toContain("documento");
  });
});
