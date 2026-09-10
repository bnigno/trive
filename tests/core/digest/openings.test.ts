import { describe, expect, it } from "vitest";

import {
  OPENINGS_WITH_SALES,
  OPENINGS_WITHOUT_SALES,
  openingFor,
} from "@/core/digest/openings";
import { normalizeReceiptText } from "@/core/receipts/types";

describe("openingFor", () => {
  it("sete frases distintas para cada caso, todas sem emoji ou símbolo", () => {
    for (const list of [OPENINGS_WITH_SALES, OPENINGS_WITHOUT_SALES]) {
      expect(list).toHaveLength(7);
      expect(new Set(list).size).toBe(7);
      for (const phrase of list) {
        expect(normalizeReceiptText(phrase)).toBe(phrase);
      }
    }
  });

  it("é determinística e muda com a venda", () => {
    expect(openingFor(3, true)).toBe(openingFor(3, true));
    expect(openingFor(3, true)).not.toBe(openingFor(3, false));
    expect(openingFor(3, true)).toBe(OPENINGS_WITH_SALES[3]);
    // Índice fora de 0..6 é normalizado, nunca undefined.
    expect(openingFor(7, true)).toBe(OPENINGS_WITH_SALES[0]);
    expect(openingFor(-1, false)).toBe(OPENINGS_WITHOUT_SALES[6]);
  });
});
