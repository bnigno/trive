import { describe, expect, it } from "vitest";

import { BLURB_MAX_CHARS, formatCatalogLine, LINE_VALUES_MAX, pieceBlurb } from "@/core/bot/catalog-line";

const base = {
  name: "Vestido Dunas",
  typeLabel: "Vestido",
  categoryName: "Vestuário",
  price: "R$ 289,00",
  available: true,
  colors: ["Preto", "Verde"],
  sizes: ["P", "M", "G"],
  blurbSource: "Linho leve que respira no calor de Belém, com corte fluido e comprimento midi. Forro em algodão.",
};

describe("pieceBlurb", () => {
  it("usa a primeira frase quando cabe; corta em palavra inteira com reticências quando não cabe", () => {
    expect(pieceBlurb(base.blurbSource)).toBe("Linho leve que respira no calor de Belém, com corte fluido e comprimento midi.");
    const longa = "Uma frase única e muito longa sem ponto final que fala do tecido do caimento da ocasião do calor e de tudo o mais que couber aqui dentro";
    const cortada = pieceBlurb(longa)!;
    expect(cortada.length).toBeLessThanOrEqual(BLURB_MAX_CHARS);
    expect(cortada.endsWith("…")).toBe(true);
    expect(cortada).not.toMatch(/\s…$/);
    expect(longa.startsWith(cortada.slice(0, -1))).toBe(true);
  });

  it("texto curto demais ('diversos') e vazio não viram frase; espaços em excesso são normalizados", () => {
    expect(pieceBlurb("diversos")).toBeNull();
    expect(pieceBlurb("")).toBeNull();
    expect(pieceBlurb(null)).toBeNull();
    expect(pieceBlurb("  Corset em renda   com bojo estruturado.  ")).toBe("Corset em renda com bojo estruturado.");
  });
});

describe("formatCatalogLine", () => {
  it("nome · tipo — preço · cores · tamanhos — frase", () => {
    expect(formatCatalogLine(base)).toBe(
      '• Vestido Dunas · Vestido — R$ 289,00 · cores: Preto, Verde · tamanhos: P, M, G — "Linho leve que respira no calor de Belém, com corte fluido e comprimento midi."',
    );
  });

  it("sem tipo cai na categoria; sem nada, só nome e preço; esgotada mantém o aviso depois do preço", () => {
    expect(formatCatalogLine({ ...base, typeLabel: null, colors: [], sizes: [], blurbSource: null })).toBe("• Vestido Dunas · Vestuário — R$ 289,00");
    expect(formatCatalogLine({ ...base, typeLabel: null, categoryName: null, colors: [], sizes: [], blurbSource: "diversos", available: false })).toBe(
      "• Vestido Dunas — R$ 289,00 (esgotado)",
    );
  });

  it("muitas cores viram 'e mais N'; é determinístico", () => {
    const cores = Array.from({ length: LINE_VALUES_MAX + 2 }, (_, i) => `Cor ${i + 1}`);
    const linha = formatCatalogLine({ ...base, colors: cores });
    expect(linha).toContain(`cores: ${cores.slice(0, LINE_VALUES_MAX).join(", ")} e mais 2`);
    expect(formatCatalogLine(base)).toBe(formatCatalogLine(base));
  });
});
