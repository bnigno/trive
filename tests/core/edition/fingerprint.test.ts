// A impressão digital dos cartões (PURO): muda quando qualquer coisa que
// entra no desenho muda, é estável para o mesmo conteúdo, e o cartão só
// fica velho depois de gerado (ou quando a peça nem estava na geração).
import { describe, expect, it } from "vitest";

import {
  editionCardFingerprint,
  editionFingerprintsOf,
  isEditionCardStale,
  parseEditionFingerprints,
} from "@/core/edition/fingerprint";
import type { EditionCardData } from "@/core/edition/types";

const base: EditionCardData = {
  editionName: "Edição Círio",
  productName: "Longo Dunas",
  curatorNote: "Escolhi pelo caimento.",
  wearNote: "Solta no corpo.",
  wearSource: "ficha",
  careNote: "Lavar à mão",
  qrUrl: "https://trivemaison.com.br/produto/longo-dunas",
  qrTarget: "peca",
  printedAddress: "trivemaison.com.br",
  layout: { titleSize: 84, titleLines: 1, quoteSize: 44, quoteLines: 1, bodySize: 30, wearLines: 1, careLines: 1, qrSize: 220 },
};

describe("editionCardFingerprint", () => {
  it("é estável para o mesmo conteúdo e muda com cada campo do desenho", () => {
    expect(editionCardFingerprint({ ...base })).toBe(editionCardFingerprint(base));
    const changes: Partial<EditionCardData>[] = [
      { editionName: null },
      { productName: "Longo Dunas II" },
      { curatorNote: null },
      { wearNote: "Justa." },
      { wearSource: "padrao" },
      { careNote: "Lavar à máquina" },
      { qrUrl: "https://trivemaison.com.br" },
      { qrTarget: "home" },
      { printedAddress: "loja.trive.com.br" },
    ];
    // O layout é derivado dos textos: não entra no hash.
    expect(editionCardFingerprint({ ...base, layout: { ...base.layout, bodySize: 26 } })).toBe(editionCardFingerprint(base));
    const seen = new Set([editionCardFingerprint(base)]);
    for (const change of changes) {
      const hash = editionCardFingerprint({ ...base, ...change });
      expect(seen.has(hash)).toBe(false);
      seen.add(hash);
    }
  });
});

describe("isEditionCardStale / parseEditionFingerprints", () => {
  it("antes de gerar nada está velho; depois, só o que diria outra coisa — ou a peça que não estava lá", () => {
    const stored = editionFingerprintsOf([{ productId: "p1", data: base }]);
    expect(isEditionCardStale(null, "p1", base)).toBe(false);
    expect(isEditionCardStale(stored, "p1", base)).toBe(false);
    expect(isEditionCardStale(stored, "p1", { ...base, curatorNote: "Outra frase." })).toBe(true);
    expect(isEditionCardStale(stored, "p2", base)).toBe(true);
  });

  it("o que está guardado fora do formato vale como 'nada gerado'", () => {
    expect(parseEditionFingerprints(null)).toBeNull();
    expect(parseEditionFingerprints("abc")).toBeNull();
    expect(parseEditionFingerprints({ p1: 1 })).toBeNull();
    expect(parseEditionFingerprints({ p1: "a" })).toEqual({ p1: "a" });
  });
});
