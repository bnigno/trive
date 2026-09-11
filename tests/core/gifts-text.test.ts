import { describe, expect, it } from "vitest";

import { giftMessageFontSize, giftSignature, normalizeGiftName, normalizeGiftText } from "@/core/gifts/text";
import { GIFT_MESSAGE_MAX } from "@/core/gifts/types";

describe("normalizeGiftText", () => {
  it("tira emoji e símbolos, colapsa espaços e linhas vazias e limita a 6 linhas", () => {
    expect(normalizeGiftText("  Para  você 🤎, com   amor.  ")).toBe("Para você , com amor.");
    expect(normalizeGiftText("a\r\n\r\n\r\nb\n\n\n")).toBe("a\n\nb");
    expect(normalizeGiftText("1\n2\n3\n4\n5\n6\n7\n8")).toBe("1\n2\n3\n4\n5\n6");
    expect(normalizeGiftText("x".repeat(400))).toHaveLength(GIFT_MESSAGE_MAX);
    expect(normalizeGiftText("Mãe, você é única — obrigada!")).toBe("Mãe, você é única — obrigada!");
  });

  it("nome vira uma linha só", () => {
    expect(normalizeGiftName(" Ana\nClara ✨ ")).toBe("Ana Clara");
  });
});

describe("giftMessageFontSize", () => {
  it("diminui com o comprimento e o número de linhas", () => {
    expect(giftMessageFontSize("Para iluminar o seu setembro.")).toBe(48);
    expect(giftMessageFontSize("a".repeat(120))).toBe(42);
    expect(giftMessageFontSize("a".repeat(200))).toBe(36);
    expect(giftMessageFontSize("a".repeat(280))).toBe(32);
    expect(giftMessageFontSize("a\nb\nc")).toBe(42);
  });
});

describe("giftSignature", () => {
  it("usa o primeiro nome da compradora com inicial maiúscula", () => {
    expect(giftSignature("maria da silva")).toBe("Com carinho, Maria");
    expect(giftSignature("JULIANA")).toBe("Com carinho, Juliana");
    expect(giftSignature("   ")).toBe("Com carinho");
  });
});
