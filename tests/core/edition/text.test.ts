// Os textos do cartão da edição (PURO): limpeza, família (categoria antes do
// nome; acessório antes de tudo; vestido por último), padrões que cabem no
// cartão, pictogramas de cuidado virando frase, corte na frase com aviso.
import { describe, expect, it } from "vitest";

import {
  careNoteFor,
  DEFAULT_CARE,
  DEFAULT_WEAR,
  EDITION_CURATOR_MAX,
  EDITION_NOTE_MAX,
  editionFamily,
  editionTexts,
  fitEditionNote,
  normalizeEditionNote,
  wearNoteFor,
} from "@/core/edition/text";

describe("fitEditionNote / normalizeEditionNote", () => {
  it("tira emoji sem deixar espaço antes da vírgula, mantém °, $, +, × e acentos em NFD, tab vira espaço", () => {
    expect(normalizeEditionNote("  Linho   puro 😀, respira.  ")).toBe("Linho puro, respira.");
    expect(normalizeEditionNote("Lavar a 30°C, R$ 10, 2+1 × 3, 50%")).toBe("Lavar a 30°C, R$ 10, 2+1 × 3, 50%");
    expect(normalizeEditionNote("Coração")).toBe("Coração");
    expect(normalizeEditionNote("Lave\tà mão")).toBe("Lave à mão");
    expect(normalizeEditionNote("   ")).toBeNull();
    expect(normalizeEditionNote("…")).toBeNull();
    expect(normalizeEditionNote(null)).toBeNull();
  });

  it("linhas da ficha viram uma só com ' · ' (nada some em silêncio)", () => {
    expect(normalizeEditionNote("Caimento fluido\nComprimento midi\n\nModelo veste M")).toBe(
      "Caimento fluido · Comprimento midi · Modelo veste M",
    );
    const cinco = normalizeEditionNote("a\nb\nc\nd\ne")!;
    expect(cinco).toBe("a · b · c · d · e");
  });

  it("corta no fim da última frase que cabe, avisando; sem frase, na palavra com reticências; nunca em '·'", () => {
    const frases = fitEditionNote("Primeira frase curta. Segunda frase também curta. " + "x".repeat(200));
    expect(frases).toEqual({ text: "Primeira frase curta. Segunda frase também curta.", truncated: true });
    const palavras = fitEditionNote(Array.from({ length: 60 }, () => "palavra").join(" "));
    expect(palavras.truncated).toBe(true);
    expect(palavras.text!.length).toBeLessThanOrEqual(EDITION_NOTE_MAX);
    expect(palavras.text!.endsWith("palavra…")).toBe(true);
    const separador = fitEditionNote(Array.from({ length: 40 }, () => "abc").join("\n"));
    expect(separador.text).not.toMatch(/[·—,]\s*…$/);
    expect(fitEditionNote("cabe", 10)).toEqual({ text: "cabe", truncated: false });
  });

  it("a frase da curadora: aspas nas pontas saem (o desenho põe as dele) e o teto é maior", () => {
    expect(fitEditionNote("“Amei esta peça.”", EDITION_CURATOR_MAX, { quotes: true })).toEqual({
      text: "Amei esta peça.",
      truncated: false,
    });
    expect(fitEditionNote('"Amei." ', EDITION_CURATOR_MAX, { quotes: true }).text).toBe("Amei.");
    expect(EDITION_CURATOR_MAX).toBeGreaterThan(EDITION_NOTE_MAX);
  });
});

describe("editionFamily", () => {
  it("a categoria decide antes do nome; só sem categoria útil o nome fala", () => {
    expect(editionFamily("Vestidos", "Longo Dunas")).toBe("vestido");
    expect(editionFamily("Acessórios", "Colar Longo Pérola")).toBe("acessorio");
    expect(editionFamily("Saias", "Saia Midi Lírio")).toBe("saia");
    expect(editionFamily("Calças", "Calça Cropped Linho")).toBe("calca");
    expect(editionFamily("Blusas", "Top Curto Sol")).toBe("blusa");
    expect(editionFamily("Acessórios", "Bolsa de Malha")).toBe("acessorio");
    expect(editionFamily("Peças", "Coisa")).toBe("geral");
    expect(editionFamily(null, "Longo Dunas")).toBe("vestido");
    expect(editionFamily(null, "Saia Midi")).toBe("saia");
    expect(editionFamily(null, "BABY LOOK BELLA")).toBe("blusa");
    expect(editionFamily("Vestuário", "Cropped Íris")).toBe("blusa");
  });

  it("acessório e calçado antes de calça; sobreposição e conjunto de brincos no lugar certo", () => {
    expect(editionFamily("Calçados", "Sandália Rasteira")).toBe("acessorio");
    expect(editionFamily("Calçados", "Tênis Branco")).toBe("acessorio");
    expect(editionFamily(null, "Rasteira Ipê")).not.toBe("calca");
    expect(editionFamily("Calças", "Pantalona Areia")).toBe("calca");
    expect(editionFamily("Bijuterias", "Conjunto de brincos")).toBe("acessorio");
    expect(editionFamily(null, "Conjunto colar e brinco")).toBe("acessorio");
    expect(editionFamily("Casacos", "Kimono Rio")).toBe("sobreposicao");
    expect(editionFamily(null, "Jaqueta Jeans")).toBe("sobreposicao");
    expect(editionFamily("Conjuntos", "Conjunto Alfaiataria")).toBe("conjunto");
  });

  it("o que não é roupa não tem família — a mesma lista que a Lia usa", () => {
    expect(editionFamily("Casa", "Caneca Azul")).toBe("nenhuma");
    expect(editionFamily(null, "Garrafa Térmica 500ml")).toBe("nenhuma");
    expect(editionFamily(null, "Kit de Adesivos")).toBe("nenhuma");
    expect(editionTexts({ productName: "Caneca", categoryName: "Casa", curatorNote: null, fitNotes: null, careNotes: null })).toBeNull();
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
    expect(DEFAULT_CARE.sobreposicao).not.toContain("duas partes");
  });
});

describe("wearNoteFor / careNoteFor / editionTexts", () => {
  it("usa a ficha quando existe (com a origem); senão, o padrão da família", () => {
    expect(wearNoteFor("Solta no corpo, vai com sandália.", "vestido")).toEqual({
      text: "Solta no corpo, vai com sandália.",
      truncated: false,
      source: "ficha",
    });
    expect(wearNoteFor("", "saia")).toEqual({ text: DEFAULT_WEAR.saia, truncated: false, source: "padrao" });
    expect(careNoteFor("hand_wash\ndry_shade\nNão torcer", "blusa")).toEqual({
      text: "Não torcer · Lavar à mão · Secar à sombra",
      truncated: false,
      source: "ficha",
    });
    expect(careNoteFor(null, "calca")).toEqual({ text: DEFAULT_CARE.calca, truncated: false, source: "padrao" });
  });

  it("nos cuidados, o texto da dona entra inteiro e os pictogramas só enquanto couberem; linha só de emoji não deixa ' ·'", () => {
    const livre = "Lave à mão com sabão de coco, seque na sombra do quintal e passe em temperatura baixa, do avesso, sempre.";
    const cheio = careNoteFor(`hand_wash\nmachine_cold\nno_bleach\ndry_shade\niron_low\nno_iron\ndry_clean\nno_tumble\n${livre}`, "vestido");
    expect(cheio.text!.startsWith(livre)).toBe(true);
    expect(cheio.text!.length).toBeLessThanOrEqual(EDITION_NOTE_MAX);
    expect(cheio.truncated).toBe(true);
    expect(careNoteFor("hand_wash\n🌿\ndry_shade", "vestido").text).toBe("Lavar à mão · Secar à sombra");
  });

  it("monta os textos: a frase da curadora só quando existe, com o aviso de corte", () => {
    const comNota = editionTexts({
      productName: "Longo Dunas",
      categoryName: "Vestidos",
      curatorNote: "“Escolhi pelo caimento no calor. 🌞”",
      fitNotes: null,
      careNotes: "dry_clean",
    });
    expect(comNota).toEqual({
      family: "vestido",
      curatorNote: "Escolhi pelo caimento no calor.",
      curatorTruncated: false,
      wearNote: DEFAULT_WEAR.vestido,
      wearSource: "padrao",
      careNote: "Lavagem a seco",
      careTruncated: false,
    });
    const longa = editionTexts({
      productName: "Longo Dunas",
      categoryName: "Vestidos",
      curatorNote: Array.from({ length: 12 }, (_, i) => `Frase número ${i + 1} da nota da curadora sobre a peça.`).join(" "),
      fitNotes: "Alça longa, cabe um livro.",
      careNotes: null,
    })!;
    expect(longa.curatorTruncated).toBe(true);
    expect(longa.curatorNote!.length).toBeLessThanOrEqual(EDITION_CURATOR_MAX);
    expect(longa.curatorNote!.endsWith(".")).toBe(true);
    expect(longa.wearSource).toBe("ficha");
  });
});
