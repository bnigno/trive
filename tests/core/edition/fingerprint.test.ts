// A impressão digital dos cartões (PURO): muda quando qualquer coisa que
// entra no desenho muda, é estável para o mesmo conteúdo, e o cartão só
// fica velho depois de gerado (ou quando a peça nem estava na geração).
import { describe, expect, it } from "vitest";

import {
  debutLetterFingerprint,
  editionCardFingerprint,
  editionFingerprintsOf,
  isDebutLetterStale,
  isEditionCardStale,
  LETTER_FINGERPRINT_KEY,
  parseEditionFingerprints,
} from "@/core/edition/fingerprint";
import type { DebutLetterData, EditionCardData } from "@/core/edition/types";

const base: EditionCardData = {
  storeName: "TRIVÉ",
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
    // O nome da loja só desenha no cartão do presente: muda o hash só dele.
    expect(editionCardFingerprint({ ...base, storeName: "Outra Loja" })).toBe(editionCardFingerprint(base));
    const gift = { ...base, qrTarget: "home" as const };
    expect(editionCardFingerprint({ ...gift, storeName: "Outra Loja" })).not.toBe(editionCardFingerprint(gift));
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

describe("carta de estreia na impressão digital", () => {
  const letter: DebutLetterData = { recipientName: "Ana", text: "Bem-vinda.", signature: "Marina", editionName: "Edição Círio" };

  it("a carta entra no mapa sob a chave 'carta' e muda com cada campo desenhado", () => {
    const stored = editionFingerprintsOf([{ productId: "p1", data: base }], letter);
    expect(Object.keys(stored).sort()).toEqual([LETTER_FINGERPRINT_KEY, "p1"]);
    expect(stored[LETTER_FINGERPRINT_KEY]).toBe(debutLetterFingerprint(letter));
    const seen = new Set([debutLetterFingerprint(letter)]);
    for (const change of [{ recipientName: "Bia" }, { text: "Outra." }, { signature: "Lia" }, { editionName: null }] as Partial<DebutLetterData>[]) {
      const hash = debutLetterFingerprint({ ...letter, ...change });
      expect(seen.has(hash)).toBe(false);
      seen.add(hash);
    }
    // Sem carta, o mapa não tem a chave.
    expect(editionFingerprintsOf([{ productId: "p1", data: base }], null)).not.toHaveProperty(LETTER_FINGERPRINT_KEY);
  });

  it("a carta fica velha quando o texto muda ou quando foi escrita depois da geração; sem carta hoje, nunca", () => {
    const stored = editionFingerprintsOf([{ productId: "p1", data: base }], letter);
    expect(isDebutLetterStale(stored, letter)).toBe(false);
    expect(isDebutLetterStale(stored, { ...letter, text: "Mudou." })).toBe(true);
    expect(isDebutLetterStale(editionFingerprintsOf([{ productId: "p1", data: base }], null), letter)).toBe(true);
    expect(isDebutLetterStale(stored, null)).toBe(false);
    expect(isDebutLetterStale(null, letter)).toBe(false);
  });
});
