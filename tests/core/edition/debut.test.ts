// A carta de estreia (PURO): o que é primeira compra, a limpeza da carta e da
// assinatura, o primeiro nome, o corpo da letra e a ordem de impressão.
import { describe, expect, it } from "vitest";

import {
  COUNTED_STATUSES,
  DEBUT_LETTER_MAX,
  DEBUT_LETTER_MAX_LINES,
  debutFirstName,
  debutLetterFontSize,
  editionPrintSet,
  isCountedStatus,
  isFirstPurchase,
  normalizeDebutLetter,
  normalizeDebutSignature,
} from "@/core/edition/debut";

describe("isFirstPurchase / status que contam", () => {
  it("primeira compra é não ter nenhum pedido pago antes; rascunho e cancelado não contam", () => {
    expect(isFirstPurchase({ priorCountedOrders: 0 })).toBe(true);
    expect(isFirstPurchase({ priorCountedOrders: 1 })).toBe(false);
    expect(COUNTED_STATUSES).toEqual(["paid", "preparing", "shipped", "delivered"]);
    expect(isCountedStatus("paid")).toBe(true);
    expect(isCountedStatus("pending_payment")).toBe(false);
    expect(isCountedStatus("canceled")).toBe(false);
  });
});

describe("normalizeDebutLetter / normalizeDebutSignature", () => {
  it("tira emoji, junta linhas vazias, limita a 12 linhas e 900 caracteres; vazio desliga a carta", () => {
    expect(normalizeDebutLetter("  Bem-vinda 🤎 à maison.\n\n\n\nCom carinho.  ")).toBe(
      "Bem-vinda à maison.\n\nCom carinho.",
    );
    const muitas = normalizeDebutLetter(Array.from({ length: 20 }, (_, i) => `linha ${i + 1}`).join("\n"))!;
    expect(muitas.split("\n")).toHaveLength(DEBUT_LETTER_MAX_LINES);
    expect(normalizeDebutLetter("x".repeat(2000))!.length).toBe(DEBUT_LETTER_MAX);
    expect(normalizeDebutLetter("   ")).toBeNull();
    expect(normalizeDebutLetter("…")).toBeNull();
    expect(normalizeDebutLetter(null)).toBeNull();
  });

  it("assinatura numa linha, sem emoji, com padrão", () => {
    expect(normalizeDebutSignature("  Marina,\ncuradora 🤎 ")).toBe("Marina, curadora");
    expect(normalizeDebutSignature("")).toBe("A curadora");
    expect(normalizeDebutSignature("x".repeat(80))).toHaveLength(60);
  });
});

describe("debutFirstName / debutLetterFontSize / editionPrintSet", () => {
  it("primeiro nome com inicial maiúscula; sem nome, 'você'", () => {
    expect(debutFirstName("ana CLARA souza")).toBe("Ana");
    expect(debutFirstName("  ")).toBe("você");
    expect(debutFirstName(null)).toBe("você");
  });

  it("o corpo da letra desce conforme a carta cresce", () => {
    expect(debutLetterFontSize("Bem-vinda.")).toBe(40);
    expect(debutLetterFontSize("x".repeat(300))).toBe(34);
    expect(debutLetterFontSize("x".repeat(500))).toBe(29);
    expect(debutLetterFontSize(Array.from({ length: 12 }, () => "linha").join("\n"))).toBe(25);
  });

  it("a carta vai na frente dos cartões; sem carta, só os cartões", () => {
    expect(editionPrintSet({ letter: "carta", cards: ["a", "b"] })).toEqual(["carta", "a", "b"]);
    expect(editionPrintSet({ letter: null, cards: ["a"] })).toEqual(["a"]);
  });
});
