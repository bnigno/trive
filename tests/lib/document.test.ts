import { describe, expect, it } from "vitest";

import {
  isValidCnpj,
  isValidCpf,
  normalizeDocument,
} from "../../src/lib/document";

describe("isValidCpf", () => {
  it("accepts known valid CPFs", () => {
    expect(isValidCpf("52998224725")).toBe(true);
    expect(isValidCpf("11144477735")).toBe(true);
  });

  it("rejects wrong check digits", () => {
    expect(isValidCpf("52998224726")).toBe(false);
    expect(isValidCpf("52998224715")).toBe(false);
    expect(isValidCpf("12345678900")).toBe(false);
  });

  it("rejects repeated sequences even with valid check-digit math", () => {
    for (const digit of "0123456789") {
      expect(isValidCpf(digit.repeat(11))).toBe(false);
    }
  });

  it("rejects wrong length and masked input", () => {
    expect(isValidCpf("5299822472")).toBe(false);
    expect(isValidCpf("529982247251")).toBe(false);
    expect(isValidCpf("529.982.247-25")).toBe(false);
    expect(isValidCpf("")).toBe(false);
  });
});

describe("isValidCnpj", () => {
  it("accepts known valid CNPJs", () => {
    expect(isValidCnpj("11222333000181")).toBe(true);
    expect(isValidCnpj("11444777000161")).toBe(true);
  });

  it("rejects wrong check digits", () => {
    expect(isValidCnpj("11222333000180")).toBe(false);
    expect(isValidCnpj("11222333000191")).toBe(false);
  });

  it("rejects repeated sequences", () => {
    expect(isValidCnpj("00000000000000")).toBe(false);
    expect(isValidCnpj("11111111111111")).toBe(false);
  });

  it("rejects wrong length and masked input", () => {
    expect(isValidCnpj("1122233300018")).toBe(false);
    expect(isValidCnpj("11.222.333/0001-81")).toBe(false);
  });
});

describe("normalizeDocument", () => {
  it("strips CPF mask and classifies as cpf", () => {
    expect(normalizeDocument("529.982.247-25")).toEqual({
      type: "cpf",
      digits: "52998224725",
    });
    expect(normalizeDocument("52998224725")).toEqual({
      type: "cpf",
      digits: "52998224725",
    });
  });

  it("strips CNPJ mask and classifies as cnpj", () => {
    expect(normalizeDocument("11.222.333/0001-81")).toEqual({
      type: "cnpj",
      digits: "11222333000181",
    });
  });

  it("returns null for invalid documents", () => {
    expect(normalizeDocument("529.982.247-26")).toBe(null);
    expect(normalizeDocument("11.222.333/0001-80")).toBe(null);
    expect(normalizeDocument("123")).toBe(null);
    expect(normalizeDocument("111.111.111-11")).toBe(null);
    expect(normalizeDocument("")).toBe(null);
    expect(normalizeDocument("abc")).toBe(null);
  });
});
