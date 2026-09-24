import { describe, expect, it } from "vitest";

import {
  closingLine,
  isRoundOpen,
  normalizeDisplayName,
  normalizeNickname,
  normalizeNote,
  notesBlock,
  optionLabel,
  ROUND_OPEN_MS,
  roundClosesAt,
  scoreboardLine,
  tallyRound,
} from "@/core/friends/decision";

const options = [optionLabel(0, "Kimono Maré", null), optionLabel(1, "Longo Dunas", "areia")];

describe("o que a amiga escreve", () => {
  it("recado sem link, sem quebra de linha, até 140", () => {
    expect(normalizeNote("  combina com\nteu cabelo  https://golpe.example/x ")).toBe("combina com teu cabelo");
    expect(normalizeNote("www.site.com")).toBeNull();
    expect(normalizeNote("a".repeat(200))).toHaveLength(140);
    expect(normalizeNote("   ")).toBeNull();
  });
  it("nome e apelido curtos e com letra", () => {
    expect(normalizeDisplayName("  Ana  Paula ")).toBe("Ana Paula");
    expect(normalizeDisplayName("🙂🙂")).toBeNull();
    expect(normalizeNickname("x".repeat(50))).toHaveLength(30);
  });
});

describe("prazo", () => {
  it("aberta por 24 h, fechada ao marcar", () => {
    const now = new Date("2026-10-05T12:00:00Z");
    const closesAt = roundClosesAt(now);
    expect(closesAt.getTime() - now.getTime()).toBe(ROUND_OPEN_MS);
    expect(isRoundOpen({ closesAt, closedAt: null }, now)).toBe(true);
    expect(isRoundOpen({ closesAt, closedAt: null }, closesAt)).toBe(false);
    expect(isRoundOpen({ closesAt, closedAt: now }, now)).toBe(false);
  });
});

describe("placar", () => {
  it("conta, acha a líder e ignora escolha inválida", () => {
    expect(tallyRound(2, [{ choice: 1 }, { choice: 1 }, { choice: 0 }, { choice: 7 }])).toEqual({ counts: [1, 2], total: 3, leader: 1 });
  });
  it("empate no topo não tem líder", () => {
    expect(tallyRound(3, [{ choice: 0 }, { choice: 2 }]).leader).toBeNull();
    expect(tallyRound(2, []).leader).toBeNull();
  });
  it("linha do placar da mais votada para a menos", () => {
    expect(scoreboardLine(options, tallyRound(2, [{ choice: 1 }, { choice: 1 }, { choice: 0 }]))).toBe(
      "B, Longo Dunas (areia): 2 votos · A, Kimono Maré: 1 voto",
    );
  });
  it("até dois recados, com a letra votada", () => {
    expect(
      notesBlock(options, [
        { nickname: "Carla", note: "combina com teu cabelo", choice: 1 },
        { nickname: null, note: "a A é mais fresca", choice: 0 },
        { nickname: "Bia", note: "terceiro não entra", choice: 1 },
      ]),
    ).toBe("\n💬 Carla (B): combina com teu cabelo\n💬 Uma amiga (A): a A é mais fresca");
    expect(notesBlock(options, [])).toBe("");
  });
  it("fecho: vencedora, empate ou ninguém votou", () => {
    expect(closingLine(options, tallyRound(2, [{ choice: 1 }]))).toContain("escolheram a B: Longo Dunas (areia)");
    expect(closingLine(options, tallyRound(2, [{ choice: 1 }, { choice: 0 }]))).toContain("empate entre A e B");
    expect(closingLine(options, tallyRound(2, []))).toContain("Ninguém votou");
  });
});
