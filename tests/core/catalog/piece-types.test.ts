import { describe, expect, it } from "vitest";

import { PIECE_TYPE_SLUGS, PIECE_TYPES, parsePieceType, pieceTypeLabel, pieceTypePlural, pieceTypeTerms, suggestPieceType } from "@/core/catalog/piece-types";

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
    expect(parsePieceType("Sapatos")).toBeNull();
    expect(parsePieceType("vestuario")).toBeNull();
    expect(parsePieceType("")).toBeNull();
  });

  it("pieceTypeTerms lista rótulo, plural, slug e sinônimos normalizados — o que se procura no nome quando o tipo não está marcado", () => {
    expect(pieceTypeTerms("vestido")).toEqual(["vestido", "vestidos", "longo", "midi", "curto"]);
    expect(pieceTypeTerms("calca")).toEqual(["calca", "calcas", "pantalona", "legging"]);
    expect(pieceTypeTerms("blusa")).toContain("baby look");
  });

  it("suggestPieceType lê o nome da peça: primeiro termo reconhecido, conjunto ganha, nunca 'outro'", () => {
    expect(suggestPieceType("CORSET DOMINIQUE")).toBe("corset");
    expect(suggestPieceType("Longo Dunas")).toBe("vestido");
    expect(suggestPieceType("CONJUNTO SAIA E TOP")).toBe("conjunto");
    expect(suggestPieceType("Saia e top do conjunto")).toBe("conjunto");
    expect(suggestPieceType("BABY LOOK BELLA")).toBe("blusa");
    expect(suggestPieceType("Cropped Íris")).toBe("cropped");
    expect(suggestPieceType("Aurora")).toBeNull();
    expect(suggestPieceType("Outro")).toBeNull();
    expect(suggestPieceType("")).toBeNull();
  });
});
