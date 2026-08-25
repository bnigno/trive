import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  assertCents,
  formatCentsBRL,
  parseBRLToCents,
  splitProportional,
} from "../../src/lib/money";

// Intl pt-BR usa espaço não separável entre 'R$' e o número.
const normalize = (s: string) => s.replace(/ | /g, " ");

describe("assertCents", () => {
  it("accepts safe integers, including negatives and zero", () => {
    expect(() => assertCents(0)).not.toThrow();
    expect(() => assertCents(-1)).not.toThrow();
    expect(() => assertCents(123456)).not.toThrow();
  });

  it("rejects floats, NaN, Infinity and unsafe integers", () => {
    expect(() => assertCents(1.5)).toThrow(RangeError);
    expect(() => assertCents(NaN)).toThrow(RangeError);
    expect(() => assertCents(Infinity)).toThrow(RangeError);
    expect(() => assertCents(2 ** 53)).toThrow(RangeError);
  });
});

describe("formatCentsBRL", () => {
  it("formats with thousands separator and decimal comma", () => {
    expect(normalize(formatCentsBRL(123456))).toBe("R$ 1.234,56");
    expect(normalize(formatCentsBRL(0))).toBe("R$ 0,00");
    expect(normalize(formatCentsBRL(9))).toBe("R$ 0,09");
    expect(normalize(formatCentsBRL(100000000))).toBe("R$ 1.000.000,00");
  });

  it("formats negatives", () => {
    expect(normalize(formatCentsBRL(-100))).toBe("-R$ 1,00");
  });

  it("rejects non-integer cents", () => {
    expect(() => formatCentsBRL(1.5)).toThrow(RangeError);
  });
});

describe("parseBRLToCents", () => {
  it("parses common BRL formats", () => {
    expect(parseBRLToCents("1.234,56")).toBe(123456);
    expect(parseBRLToCents("R$ 1.234,56")).toBe(123456);
    expect(parseBRLToCents("R$1.234,56")).toBe(123456);
    expect(parseBRLToCents(" R$ 12,5 ")).toBe(1250);
    expect(parseBRLToCents("1234,56")).toBe(123456);
    expect(parseBRLToCents("1234")).toBe(123400);
    expect(parseBRLToCents("0,09")).toBe(9);
    expect(parseBRLToCents("R$ 0,00")).toBe(0);
    expect(parseBRLToCents("-R$ 1,00")).toBe(-100);
    expect(parseBRLToCents("1.000.000,00")).toBe(100000000);
  });

  it("rejects malformed values", () => {
    expect(() => parseBRLToCents("")).toThrow(RangeError);
    expect(() => parseBRLToCents("abc")).toThrow(RangeError);
    expect(() => parseBRLToCents("12,345")).toThrow(RangeError);
    expect(() => parseBRLToCents("1.23")).toThrow(RangeError);
    expect(() => parseBRLToCents("1,2,3")).toThrow(RangeError);
    expect(() => parseBRLToCents("12.34,56")).toThrow(RangeError);
    expect(() => parseBRLToCents("1.234.5,00")).toThrow(RangeError);
  });

  it("round-trips format -> parse (identity)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -10_000_000_000, max: 10_000_000_000 }),
        (cents) => {
          expect(parseBRLToCents(formatCentsBRL(cents))).toBe(cents);
        },
      ),
    );
  });
});

describe("splitProportional", () => {
  it("splits evenly with remainder on the last item", () => {
    expect(splitProportional(100, [1, 1, 1])).toEqual([33, 33, 34]);
    expect(splitProportional(10, [1, 1, 1])).toEqual([3, 3, 4]);
    expect(splitProportional(101, [50, 50])).toEqual([50, 51]);
  });

  it("handles zero total and zero weights among positive ones", () => {
    expect(splitProportional(0, [1, 2, 3])).toEqual([0, 0, 0]);
    expect(splitProportional(100, [0, 1])).toEqual([0, 100]);
    expect(splitProportional(100, [1])).toEqual([100]);
  });

  it("rejects invalid inputs", () => {
    expect(() => splitProportional(100, [])).toThrow(RangeError);
    expect(() => splitProportional(100, [0, 0])).toThrow(RangeError);
    expect(() => splitProportional(100, [-1, 2])).toThrow(RangeError);
    expect(() => splitProportional(100.5, [1])).toThrow(RangeError);
  });

  it("always sums exactly to the total (property)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000 }),
        fc
          .array(fc.integer({ min: 0, max: 1_000 }), {
            minLength: 1,
            maxLength: 10,
          })
          .filter((weights) => weights.some((w) => w > 0)),
        (total, weights) => {
          const parts = splitProportional(total, weights);
          expect(parts).toHaveLength(weights.length);
          expect(parts.reduce((sum, p) => sum + p, 0)).toBe(total);
          for (const part of parts) {
            expect(Number.isSafeInteger(part)).toBe(true);
            expect(part).toBeGreaterThanOrEqual(0);
          }
        },
      ),
    );
  });
});
