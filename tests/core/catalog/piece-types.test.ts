import { describe, expect, it } from "vitest";

import { PIECE_TYPE_SLUGS, PIECE_TYPES, parsePieceType, pieceTypeHints, pieceTypeLabel, pieceTypeNear, pieceTypePlural, pieceTypeTerms, pluralizePieceTerm, suggestPieceType } from "@/core/catalog/piece-types";

describe("tipos de peça", () => {
  it("a lista é fechada, sem slug repetido, e todo slug tem rótulo e plural", () => {
    expect(new Set(PIECE_TYPE_SLUGS).size).toBe(PIECE_TYPES.length);
    for (const type of PIECE_TYPES) {
      expect(pieceTypeLabel(type.slug)).toBe(type.label);
      expect(pieceTypePlural(type.slug)).toBe(type.plural);
      expect(type.slug).toMatch(/^[a-z-]+$/);
    }
  });

  it("parsePieceType aceita slug, rótulo, plural e sinônimo, sem acento e sem caixa", () => {
    expect(parsePieceType("corset")).toBe("corset");
    expect(parsePieceType("Vestidos")).toBe("vestido");
    expect(parsePieceType("ÓCULOS")).toBe("oculos");
    expect(parsePieceType("corselet")).toBe("corset");
    expect(parsePieceType("  Calça ")).toBe("calca");
    expect(parsePieceType("baby look")).toBe("blusa");
    expect(parsePieceType("Bermuda")).toBe("bermuda");
    expect(parsePieceType("Sapatos")).toBeNull();
    expect(parsePieceType("vestuario")).toBeNull();
    expect(parsePieceType("")).toBeNull();
  });

  it("pieceTypeTerms lista rótulo, plural, slug, sinônimos e o plural dos sinônimos — o que se procura no nome quando o tipo não está marcado", () => {
    expect(pieceTypeTerms("vestido")).toEqual(["vestido", "vestidos"]);
    expect(pieceTypeTerms("calca")).toEqual(["calca", "calcas", "pantalona", "legging", "pantalonas", "leggings"]);
    expect(pieceTypeTerms("blusa")).toContain("baby look");
    expect(pieceTypeTerms("blusa")).toContain("baby looks");
    expect(pieceTypeTerms("bermuda")).toEqual(["bermuda", "bermudas"]);
    expect(pieceTypeTerms("short")).not.toContain("bermuda");
  });

  it("o plural dos sinônimos também é reconhecido — a cliente escreve 'pantalonas', a dona escreve 'BERMUDAS'", () => {
    expect(parsePieceType("bermudas")).toBe("bermuda");
    expect(parsePieceType("pantalonas")).toBe("calca");
    expect(parsePieceType("camisões")).toBe("camisa");
    expect(parsePieceType("leggings")).toBe("calca");
    expect(parsePieceType("bodys")).toBe("body");
    expect(parsePieceType("clutches")).toBe("bolsa");
  });

  it("pluralizePieceTerm segue as regras simples do português e dos estrangeirismos da moda", () => {
    expect(pluralizePieceTerm("bermuda")).toBe("bermudas");
    expect(pluralizePieceTerm("camisão")).toBe("camisoes");
    expect(pluralizePieceTerm("jardim")).toBe("jardins");
    expect(pluralizePieceTerm("capuz")).toBe("capuzes");
    expect(pluralizePieceTerm("clutch")).toBe("clutches");
    expect(pluralizePieceTerm("cardigan")).toBe("cardigans");
    expect(pluralizePieceTerm("blazer")).toBe("blazers");
    expect(pluralizePieceTerm("baby look")).toBe("baby looks");
    expect(pluralizePieceTerm("óculos")).toBe("oculos");
    expect(pluralizePieceTerm("")).toBe("");
  });

  it("dicas (adjetivos) valem para reconhecer e sugerir, nunca para a busca no nome — 'KIMONO LONGO' não é vestido", () => {
    expect(pieceTypeHints("vestido")).toEqual(["longo", "midi", "curto", "longos", "midis", "curtos"]);
    expect(pieceTypeHints("bermuda")).toEqual([]);
    expect(parsePieceType("longo")).toBe("vestido");
    expect(parsePieceType("longos")).toBe("vestido");
    expect(pieceTypeTerms("vestido")).not.toContain("longo");
    expect(suggestPieceType("Longo Dunas")).toBe("vestido");
    expect(suggestPieceType("KIMONO LONGO SOL")).toBe("kimono");
    expect(suggestPieceType("LONGO KIMONO SOL")).toBe("kimono");
  });

  it("tipo vizinho: bermuda ↔ short; os outros não têm", () => {
    expect(pieceTypeNear("bermuda")).toBe("short");
    expect(pieceTypeNear("short")).toBe("bermuda");
    expect(pieceTypeNear("vestido")).toBeNull();
  });

  it("guarda: nenhum termo nem dica pertence a dois tipos (a próxima linha da lista não pode disputar um sinônimo)", () => {
    for (const type of PIECE_TYPES) {
      for (const term of [...pieceTypeTerms(type.slug), ...pieceTypeHints(type.slug)]) {
        expect({ term, tipo: parsePieceType(term) }).toEqual({ term, tipo: type.slug });
      }
    }
  });

  it("suggestPieceType lê o nome da peça: primeiro termo reconhecido, conjunto ganha, nunca 'outro'", () => {
    expect(suggestPieceType("CORSET DOMINIQUE")).toBe("corset");
    expect(suggestPieceType("Longo Dunas")).toBe("vestido");
    expect(suggestPieceType("CONJUNTO SAIA E TOP")).toBe("conjunto");
    expect(suggestPieceType("Saia e top do conjunto")).toBe("conjunto");
    expect(suggestPieceType("BABY LOOK BELLA")).toBe("blusa");
    expect(suggestPieceType("Cropped Íris")).toBe("cropped");
    expect(suggestPieceType("BERMUDAS JEANS")).toBe("bermuda");
    expect(suggestPieceType("SHORT BERMUDA")).toBe("short");
    expect(suggestPieceType("Calça pantalonas Lua")).toBe("calca");
    expect(suggestPieceType("Aurora")).toBeNull();
    expect(suggestPieceType("Outro")).toBeNull();
    expect(suggestPieceType("")).toBeNull();
  });
});
