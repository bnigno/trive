// O nome provisório da peça sai do recado: sem saudação, sem "chegou",
// cortado antes do detalhe (fornecedor, cores, tamanhos, custo).
import { describe, expect, it } from "vitest";

import { DRAFT_NAME_MAX_CHARS, draftNameFromNote, fallbackDraftName } from "@/core/atelier/name";

// 18:00Z = 15:00 em São Paulo.
const NOW = new Date("2026-09-13T18:00:00Z");

describe("draftNameFromNote", () => {
  it.each([
    ["chegou o Longo Dunas da Aurora, areia e terra, do P ao GG, três de cada, custou 120", "Longo Dunas"],
    ["Baby look bella, 3 de cada", "Baby Look Bella"],
    ["vestido midi floral custou 80", "Vestido Midi Floral"],
    ["olha essa: cropped canelado em preto e off white", "Cropped Canelado"],
    ["Oi Lia, chegaram as calças wide leg da Aurora", "Calças Wide Leg"],
    ["conjunto linho areia P M G", "Conjunto Linho Areia"],
    ["saia midi GG da maria", "Saia Midi"],
    ["Blusa Ciganinha", "Blusa Ciganinha"],
    ["camisa social listrada azul marinho manga longa", "Camisa Social Listrada Azul Marinho"],
    ["tá aqui a nova peça: kimono estampado, 2 cores", "Kimono Estampado"],
  ])("%j → %j", (note, expected) => {
    expect(draftNameFromNote(note, NOW)).toBe(expected);
  });

  it("recado vazio ou sem nome aproveitável cai no nome pela hora de São Paulo", () => {
    expect(draftNameFromNote("", NOW)).toBe("Chegada 13/09 15:00");
    expect(draftNameFromNote("kk", NOW)).toBe("Chegada 13/09 15:00");
    expect(draftNameFromNote("chegou, custou 120", NOW)).toBe("Chegada 13/09 15:00");
    expect(fallbackDraftName(new Date("2026-09-14T02:05:00Z"))).toBe("Chegada 13/09 23:05");
  });

  it("nunca passa do teto de caracteres", () => {
    const long = "Vestidíssimo".repeat(8);
    expect(draftNameFromNote(long, NOW).length).toBeLessThanOrEqual(DRAFT_NAME_MAX_CHARS);
  });
});
