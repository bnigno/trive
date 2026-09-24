import { describe, expect, it } from "vitest";

import {
  closesLabel,
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
  it("só o primeiro nome aparece; apelido só com letras e nunca se passando pela loja", () => {
    expect(normalizeDisplayName("  Ana  Paula Ferreira ")).toBe("Ana");
    expect(normalizeDisplayName("🌸 Ana 🌸 Moda Fit")).toBe("Ana");
    expect(normalizeDisplayName("🙂🙂")).toBeNull();
    expect(normalizeNickname("x".repeat(50))).toHaveLength(30);
    expect(normalizeNickname("Carla 91988887777")).toBe("Carla");
    expect(normalizeNickname("Equipe TRIVÉ")).toBeNull();
    expect(normalizeNickname("lia")).toBeNull();
  });

  it("recado sem domínio (mesmo sem http), telefone ou @perfil", () => {
    expect(normalizeNote("paga aqui bit.ly/pix ou site.com.br agora")).toBe("paga aqui ou agora");
    expect(normalizeNote("me chama no (91) 98888-7777 ou @perfil_x")).toBe("me chama no ou");
    expect(normalizeNote("a B, com 2 peças")).toBe("a B, com 2 peças");
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
  it("até três recados, com a letra votada, e sem assumir o gênero de quem votou", () => {
    expect(
      notesBlock(options, [
        { nickname: "Carla", note: "combina com teu cabelo", choice: 1 },
        { nickname: null, note: "a A é mais fresca", choice: 0 },
        { nickname: "Bia", note: "terceiro entra", choice: 1 },
        { nickname: "Duda", note: "quarto não", choice: 1 },
      ]),
    ).toBe("\n\nRecados de quem votou:\n💬 Carla (B): combina com teu cabelo\n💬 Alguém (A): a A é mais fresca\n💬 Bia (B): terceiro entra");
    expect(notesBlock(options, [])).toBe("");
  });

  it("fecho: a mais votada, empate (A, B e C) ou ninguém votou", () => {
    expect(closingLine(options, tallyRound(2, [{ choice: 1 }]))).toContain("A mais votada foi a B: Longo Dunas (areia)");
    expect(closingLine(options, tallyRound(2, [{ choice: 1 }, { choice: 0 }]))).toContain("empate entre A e B");
    const three = [...options, optionLabel(2, "Saia Rio", null)];
    expect(closingLine(three, tallyRound(3, [{ choice: 0 }, { choice: 1 }, { choice: 2 }]))).toContain("empate entre A, B e C");
    expect(closingLine(options, tallyRound(2, []))).toBe("Ninguém votou a tempo. Se quiser, eu te ajudo a escolher por aqui.");
  });

  it("o prazo por extenso no relógio de São Paulo", () => {
    const now = new Date("2026-10-05T15:00:00.000Z"); // 12h em SP
    expect(closesLabel(new Date("2026-10-05T23:00:00.000Z"), now)).toBe("hoje às 20h");
    expect(closesLabel(new Date("2026-10-06T12:30:00.000Z"), now)).toBe("amanhã às 9h30");
    expect(closesLabel(new Date("2026-10-08T13:00:00.000Z"), now)).toBe("08/10 às 10h");
  });
});
