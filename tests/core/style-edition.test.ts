import { describe, expect, it } from "vitest";

import { buildEditionForProfile, scoreCandidate, type EditionCandidate } from "@/core/style/edition";
import { EMPTY_PROFILE, mergeStyleProfile } from "@/core/style/profile";

function candidate(over: Partial<EditionCandidate> & { id: string; name: string }): EditionCandidate {
  return {
    slug: over.id,
    categoryName: "Vestuário",
    priceFromCents: 20000,
    imagePath: `products/${over.id}-full.webp`,
    sizesAvailable: ["P", "M"],
    colorsAvailable: ["Preto"],
    ...over,
  };
}

const profile = mergeStyleProfile(EMPTY_PROFILE, {
  sizes: { vestido: "M", blusa: "P" },
  colorsLove: ["Terracota", "Verde"],
  colorsAvoid: ["Amarelo"],
  occasions: ["casamento"],
});

describe("scoreCandidate", () => {
  it("pontua tamanho com estoque, cor amada, ocasião; pune peça só em cores evitadas", () => {
    const dress = scoreCandidate(profile, candidate({ id: "dunas", name: "Vestido Longo Dunas", colorsAvailable: ["Terracota", "Preto"], sizesAvailable: ["M"] }));
    expect(dress.score).toBe(3 + 2 + 1);
    expect(dress.reasons).toEqual(["no seu M", "em Terracota", "para casamento"]);
    const wrongSize = scoreCandidate(profile, candidate({ id: "x", name: "Vestido Tulipa", sizesAvailable: ["G"], colorsAvailable: ["Preto"] }));
    expect(wrongSize.score).toBe(0);
    const avoided = scoreCandidate(profile, candidate({ id: "y", name: "Blusa Sol", sizesAvailable: ["P"], colorsAvailable: ["Amarelo"] }));
    expect(avoided.score).toBe(3 - 4);
    const bag = scoreCandidate(profile, candidate({ id: "b", name: "Bolsa Tote", categoryName: "Acessórios", colorsAvailable: ["Verde"], sizesAvailable: [] }));
    expect(bag.score).toBe(2);
    expect(bag.reasons).toEqual(["em Verde"]);
  });
});

describe("buildEditionForProfile", () => {
  it("escolhe até 3 com pontuação positiva, famílias variadas primeiro, sem foto não entra", () => {
    const picks = buildEditionForProfile(profile, [
      candidate({ id: "dunas", name: "Vestido Longo Dunas", colorsAvailable: ["Terracota"], sizesAvailable: ["M"] }),
      candidate({ id: "midi", name: "Vestido Midi Areia", colorsAvailable: ["Areia"], sizesAvailable: ["M"] }),
      candidate({ id: "blusa", name: "Blusa de Linho", colorsAvailable: ["Verde"], sizesAvailable: ["P"], priceFromCents: 15000 }),
      candidate({ id: "bolsa", name: "Bolsa Tote", categoryName: "Acessórios", colorsAvailable: ["Verde"], sizesAvailable: [] }),
      candidate({ id: "sem-foto", name: "Vestido Perfeito", colorsAvailable: ["Terracota"], sizesAvailable: ["M"], imagePath: null }),
      candidate({ id: "amarela", name: "Saia Sol", colorsAvailable: ["Amarelo"], sizesAvailable: ["40"] }),
    ]);
    expect(picks.map((pick) => pick.candidate.id)).toEqual(["dunas", "blusa", "bolsa"]);
    // Segunda peça da mesma família só quando falta variedade.
    const few = buildEditionForProfile(profile, [
      candidate({ id: "dunas", name: "Vestido Longo Dunas", colorsAvailable: ["Terracota"], sizesAvailable: ["M"] }),
      candidate({ id: "midi", name: "Vestido Midi Areia", colorsAvailable: ["Areia"], sizesAvailable: ["M"] }),
    ]);
    expect(few.map((pick) => pick.candidate.id)).toEqual(["dunas", "midi"]);
    expect(buildEditionForProfile(EMPTY_PROFILE, [candidate({ id: "x", name: "Vestido" })])).toEqual([]);
  });
});
