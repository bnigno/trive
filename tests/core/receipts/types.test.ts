import { describe, expect, it } from "vitest";

import { normalizeReceiptText } from "@/core/receipts/types";

describe("normalizeReceiptText", () => {
  it("mantém acentos, números e pontuação", () => {
    expect(normalizeReceiptText("Vestido Ébano — tam. 38, cód. VE-38")).toBe(
      "Vestido Ébano — tam. 38, cód. VE-38",
    );
  });

  it("tira emoji e símbolos fora do latim e junta espaços", () => {
    expect(normalizeReceiptText("Bolsa 🤍 Tote  ✨ 100% algodão")).toBe(
      "Bolsa Tote 100% algodão",
    );
    expect(normalizeReceiptText("  Colar ★ Lua  ")).toBe("Colar Lua");
  });
});
