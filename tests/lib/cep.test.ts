import { describe, expect, it } from "vitest";

import { cepDigits, formatCep } from "@/lib/cep";

describe("formatCep", () => {
  it("põe o hífen depois do quinto dígito e limita a 8", () => {
    expect(formatCep("01310100")).toBe("01310-100");
    expect(formatCep("013101009999")).toBe("01310-100");
  });

  it("aceita entrada parcial e ignora o que não é dígito", () => {
    expect(formatCep("0131")).toBe("0131");
    expect(formatCep("01310")).toBe("01310");
    expect(formatCep("01.310-1")).toBe("01310-1");
    expect(formatCep("abc")).toBe("");
  });
});

describe("cepDigits", () => {
  it("devolve os 8 dígitos ou null", () => {
    expect(cepDigits("01310-100")).toBe("01310100");
    expect(cepDigits(" 66045335 ")).toBe("66045335");
    expect(cepDigits("0131")).toBeNull();
    expect(cepDigits("013101009")).toBeNull();
  });
});
