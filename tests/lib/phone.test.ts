import { describe, expect, it } from "vitest";

import { isValidE164, toE164BR, waMeUrl } from "../../src/lib/phone";

describe("toE164BR", () => {
  it("normalizes common mobile formats to +55 E.164", () => {
    const expected = "+5511999998888";
    expect(toE164BR("(11) 99999-8888")).toBe(expected);
    expect(toE164BR("11 99999-8888")).toBe(expected);
    expect(toE164BR("11 99999 8888")).toBe(expected);
    expect(toE164BR("11999998888")).toBe(expected);
    expect(toE164BR("5511999998888")).toBe(expected);
    expect(toE164BR("+55 11 99999-8888")).toBe(expected);
    expect(toE164BR("+55 (11) 99999-8888")).toBe(expected);
    expect(toE164BR("011 99999-8888")).toBe(expected);
  });

  it("accepts landlines with 8 digits starting 2-5", () => {
    expect(toE164BR("(11) 3222-1234")).toBe("+551132221234");
    expect(toE164BR("55 11 3222-1234")).toBe("+551132221234");
  });

  it("keeps DDD 55 unambiguous (national vs country code)", () => {
    // 11 dígitos: DDD 55 nacional, não código do país.
    expect(toE164BR("55 99999-8888")).toBe("+5555999998888");
    // 13 dígitos: 55 é código do país.
    expect(toE164BR("5555999998888")).toBe("+5555999998888");
  });

  it("requires DDD", () => {
    expect(toE164BR("99999-8888")).toBe(null);
  });

  it("requires 9-digit mobiles to start with 9", () => {
    expect(toE164BR("11 89999-8888")).toBe(null);
  });

  it("adds the ninth digit to legacy 8-digit mobiles ONLY with the 55 prefix", () => {
    // O WhatsApp (Z-API) entrega contas antigas SEM o nono dígito — caso
    // real em produção que travava o criar_pedido do bot. O formato do JID
    // sempre traz o 55; digitação humana sem 55 não é reinterpretada.
    expect(toE164BR("+559181037536")).toBe("+5591981037536");
    expect(toE164BR("559181037536")).toBe("+5591981037536");
    expect(toE164BR("55 11 9999-8888")).toBe("+5511999998888");
    expect(toE164BR("11 9999-8888")).toBe(null);
    expect(toE164BR("91 8103-7536")).toBe(null);
    // Fixo (2-5) continua fixo, sem ganhar dígito.
    expect(toE164BR("55 11 3222-1234")).toBe("+551132221234");
  });

  it("rejects invalid DDDs, lengths and garbage", () => {
    expect(toE164BR("")).toBe(null);
    expect(toE164BR("abc")).toBe(null);
    expect(toE164BR("10 99999-8888")).toBe(null);
    expect(toE164BR("01 99999-8888")).toBe(null);
    expect(toE164BR("00 11 99999-8888")).toBe(null);
    expect(toE164BR("551199999888899")).toBe(null);
    expect(toE164BR("119999")).toBe(null);
  });

  it("always produces valid E.164 when it returns a value", () => {
    for (const input of ["(11) 99999-8888", "11 3222-1234", "5521988887777"]) {
      const result = toE164BR(input);
      expect(result).not.toBe(null);
      expect(isValidE164(result as string)).toBe(true);
    }
  });
});

describe("isValidE164", () => {
  it("accepts well-formed E.164", () => {
    expect(isValidE164("+5511999998888")).toBe(true);
    expect(isValidE164("+14155552671")).toBe(true);
  });

  it("rejects missing plus, leading zero, too short or too long", () => {
    expect(isValidE164("5511999998888")).toBe(false);
    expect(isValidE164("+05511999998888")).toBe(false);
    expect(isValidE164("+")).toBe(false);
    expect(isValidE164("+1")).toBe(false);
    expect(isValidE164("+1234567890123456")).toBe(false);
    expect(isValidE164("+55 11 99999-8888")).toBe(false);
  });
});

describe("waMeUrl", () => {
  it("prefixes national numbers with Brazil's 55", () => {
    expect(waMeUrl("(11) 99999-8888")).toBe("https://wa.me/5511999998888");
    expect(waMeUrl("11 3222-1234")).toBe("https://wa.me/551132221234");
  });

  it("keeps E.164 numbers as digits only", () => {
    expect(waMeUrl("+5511999998888")).toBe("https://wa.me/5511999998888");
  });

  it("encodes the prefilled text", () => {
    expect(waMeUrl("+5511999998888", "Olá! Vim pelo site da TRIVÉ")).toBe(
      "https://wa.me/5511999998888?text=Ol%C3%A1!%20Vim%20pelo%20site%20da%20TRIV%C3%89",
    );
  });

  it("returns null without digits or for non-strings", () => {
    expect(waMeUrl("")).toBeNull();
    expect(waMeUrl("   ")).toBeNull();
    expect(waMeUrl(undefined)).toBeNull();
    expect(waMeUrl(42)).toBeNull();
  });
});
