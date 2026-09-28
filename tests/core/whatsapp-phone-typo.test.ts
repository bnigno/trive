// "Número sem WhatsApp" é quase sempre um dígito errado no checkout: o
// número certo aparece falando com a Lia e muda só um dígito.
import { describe, expect, it } from "vitest";

import { likelyIntendedPhone, looksLikePhoneTypo } from "@/core/whatsapp/phone-typo";

describe("looksLikePhoneTypo", () => {
  it("um dígito trocado, em qualquer posição", () => {
    expect(looksLikePhoneTypo("+5591981232560", "+5591981242560")).toBe(true);
    expect(looksLikePhoneTypo("+5591981232560", "+5591981232561")).toBe(true);
    expect(looksLikePhoneTypo("5591981232560", "(91) 98123-1560")).toBe(false); // sem o 55 não é o mesmo tamanho nem o 9 a mais
  });

  it("dois vizinhos invertidos", () => {
    expect(looksLikePhoneTypo("+5591981232560", "+5591982132560")).toBe(true);
    // Dois dígitos trocados que não são vizinhos invertidos: é outro número.
    expect(looksLikePhoneTypo("+5591981232560", "+5591971232561")).toBe(false);
  });

  it("o 9 da frente a mais ou a menos (conta antiga do WhatsApp)", () => {
    expect(looksLikePhoneTypo("+5591981232560", "+559181232560")).toBe(true);
    expect(looksLikePhoneTypo("+559181232560", "+5591981232560")).toBe(true);
    // Tamanhos diferentes que não são o 9: não.
    expect(looksLikePhoneTypo("+5591981232560", "+559181232561")).toBe(false);
  });

  it("igual, muito diferente ou curto demais: não", () => {
    expect(looksLikePhoneTypo("+5591981232560", "+5591981232560")).toBe(false);
    expect(looksLikePhoneTypo("+5591981232560", "+5511999990000")).toBe(false);
    expect(looksLikePhoneTypo("123", "124")).toBe(false);
  });
});

describe("likelyIntendedPhone", () => {
  it("só devolve quando há UM candidato parecido; repetido conta uma vez", () => {
    expect(likelyIntendedPhone("+5591981232560", ["+5511999990000", "+5591981242560", "+5591981242560"])).toBe("+5591981242560");
    expect(likelyIntendedPhone("+5591981232560", ["+5591981242560", "+5591981232561"])).toBeNull();
    expect(likelyIntendedPhone("+5591981232560", ["+5511999990000"])).toBeNull();
    expect(likelyIntendedPhone("+5591981232560", [])).toBeNull();
  });
});
