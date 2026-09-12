// Os textos do cartão da edição (PURO): limpeza, família pela categoria ou
// pelo nome, padrões que cabem no cartão, pictogramas de cuidado virando frase.
import { describe, expect, it } from "vitest";

import {
  careNoteFor,
  DEFAULT_CARE,
  DEFAULT_WEAR,
  EDITION_CURATOR_MAX,
  EDITION_NOTE_MAX,
  editionFamily,
  editionTexts,
  normalizeEditionNote,
  wearNoteFor,
} from "@/core/edition/text";

describe("normalizeEditionNote", () => {
  it("tira emoji e símbolo não latino, apara espaço, limita a quatro linhas e devolve null para vazio", () => {
    expect(normalizeEditionNote("  Linho   puro 😀, respira.  ")).toBe("Linho puro , respira.");
    expect(normalizeEditionNote("a\n\n\nb\nc\nd\ne\nf")).toBe("a\nb\nc\nd");
    expect(normalizeEditionNote("   ")).toBeNull();
    expect(normalizeEditionNote("…")).toBeNull();
    expect(normalizeEditionNote(null)).toBeNull();
  });

  it("corta no teto na última palavra inteira, com reticências", () => {
    const longo = normalizeEditionNote(Array.from({ length: 60 }, () => "palavra").join(" "))!;
    expect(longo.length).toBeLessThanOrEqual(EDITION_NOTE_MAX);
    expect(longo.endsWith("palavra…")).toBe(true);
    const curadora = normalizeEditionNote("x ".repeat(200), EDITION_CURATOR_MAX)!;
    expect(curadora.length).toBeLessThanOrEqual(EDITION_CURATOR_MAX);
  });
});

describe("editionFamily", () => {
  it("acha a família pela categoria, e pelo nome quando a categoria não diz", () => {
    expect(editionFamily("Vestidos", "Longo Dunas")).toBe("vestido");
    expect(editionFamily(null, "Longo Dunas")).toBe("vestido");
    expect(editionFamily("Blusas", "Cropped Íris")).toBe("blusa");
    expect(editionFamily(null, "BABY LOOK BELLA")).toBe("blusa");
    expect(editionFamily("Saias", "Saia Lua")).toBe("saia");
    expect(editionFamily("Calças", "Pantalona Areia")).toBe("calca");
    expect(editionFamily("Conjuntos", "Kimono Rio")).toBe("conjunto");
    expect(editionFamily("Acessórios", "Bolsa Tote")).toBe("acessorio");
    expect(editionFamily("Peças", "Coisa")).toBe("geral");
  });
});

describe("padrões por família", () => {
  it("cabem no cartão e passam pela limpeza sem mudar", () => {
    for (const table of [DEFAULT_WEAR, DEFAULT_CARE]) {
      for (const text of Object.values(table)) {
        expect(text.length).toBeLessThanOrEqual(EDITION_NOTE_MAX);
        expect(normalizeEditionNote(text)).toBe(text);
      }
    }
  });
});

describe("wearNoteFor / careNoteFor / editionTexts", () => {
  it("usa a ficha da peça quando existe; senão, o padrão da família", () => {
    expect(wearNoteFor("Solta no corpo, vai com sandália.", "vestido")).toBe("Solta no corpo, vai com sandália.");
    expect(wearNoteFor("", "saia")).toBe(DEFAULT_WEAR.saia);
    expect(careNoteFor("hand_wash\ndry_shade\nNão torcer", "blusa")).toBe(
      "Lavar à mão · Secar à sombra · Não torcer",
    );
    expect(careNoteFor(null, "calca")).toBe(DEFAULT_CARE.calca);
  });

  it("monta os três textos: a frase da curadora só quando existe", () => {
    const comNota = editionTexts({
      productName: "Longo Dunas",
      categoryName: "Vestidos",
      curatorNote: "Escolhi pelo caimento no calor. 🌞",
      fitNotes: null,
      careNotes: "dry_clean",
    });
    expect(comNota).toEqual({
      family: "vestido",
      curatorNote: "Escolhi pelo caimento no calor.",
      wearNote: DEFAULT_WEAR.vestido,
      careNote: "Lavagem a seco",
    });
    const semNota = editionTexts({
      productName: "Bolsa Tote",
      categoryName: null,
      curatorNote: "   ",
      fitNotes: "Alça longa, cabe um livro.",
      careNotes: null,
    });
    expect(semNota.curatorNote).toBeNull();
    expect(semNota.family).toBe("acessorio");
    expect(semNota.wearNote).toBe("Alça longa, cabe um livro.");
    expect(semNota.careNote).toBe(DEFAULT_CARE.acessorio);
  });
});
