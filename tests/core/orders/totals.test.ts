import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { OrderTotalsError, computeOrderTotals } from "@/core/orders/totals";

describe("computeOrderTotals", () => {
  it("soma itens, subtrai desconto e soma frete", () => {
    const result = computeOrderTotals(
      [
        { unitPriceCents: 1990, quantity: 2 },
        { unitPriceCents: 500, quantity: 1 },
      ],
      480,
      1500,
    );
    expect(result).toEqual({ subtotalCents: 4480, totalCents: 5500 });
  });

  it("pedido sem itens tem subtotal zero", () => {
    expect(computeOrderTotals([], 0, 0)).toEqual({
      subtotalCents: 0,
      totalCents: 0,
    });
  });

  it("desconto igual ao subtotal zera o total (menos o frete)", () => {
    const result = computeOrderTotals(
      [{ unitPriceCents: 1000, quantity: 3 }],
      3000,
      700,
    );
    expect(result).toEqual({ subtotalCents: 3000, totalCents: 700 });
  });

  it("desconto maior que o subtotal falha em pt-BR", () => {
    expect(() =>
      computeOrderTotals([{ unitPriceCents: 1000, quantity: 1 }], 1001, 0),
    ).toThrow(OrderTotalsError);
    expect(() =>
      computeOrderTotals([{ unitPriceCents: 1000, quantity: 1 }], 1001, 0),
    ).toThrow(/Desconto não pode ser maior que o subtotal/);
  });

  it("quantity 0 falha", () => {
    expect(() =>
      computeOrderTotals([{ unitPriceCents: 1000, quantity: 0 }], 0, 0),
    ).toThrow(OrderTotalsError);
  });

  it("quantity negativa ou fracionária falha", () => {
    expect(() =>
      computeOrderTotals([{ unitPriceCents: 1000, quantity: -1 }], 0, 0),
    ).toThrow(OrderTotalsError);
    expect(() =>
      computeOrderTotals([{ unitPriceCents: 1000, quantity: 1.5 }], 0, 0),
    ).toThrow(OrderTotalsError);
  });

  it("preço unitário negativo falha", () => {
    expect(() =>
      computeOrderTotals([{ unitPriceCents: -1, quantity: 1 }], 0, 0),
    ).toThrow(OrderTotalsError);
  });

  it("desconto negativo falha", () => {
    expect(() =>
      computeOrderTotals([{ unitPriceCents: 1000, quantity: 1 }], -1, 0),
    ).toThrow(OrderTotalsError);
  });

  it("frete negativo falha", () => {
    expect(() =>
      computeOrderTotals([{ unitPriceCents: 1000, quantity: 1 }], 0, -1),
    ).toThrow(OrderTotalsError);
  });

  it("preço unitário zero é permitido (brinde)", () => {
    expect(
      computeOrderTotals([{ unitPriceCents: 0, quantity: 5 }], 0, 0),
    ).toEqual({ subtotalCents: 0, totalCents: 0 });
  });

  it("propriedade: total = subtotal - desconto + frete, sempre inteiro e >= frete - 0", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            unitPriceCents: fc.integer({ min: 0, max: 1_000_000 }),
            quantity: fc.integer({ min: 1, max: 100 }),
          }),
          { maxLength: 20 },
        ),
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 0, max: 100_000 }),
        (items, rawDiscount, shipping) => {
          const subtotal = items.reduce(
            (s, i) => s + i.unitPriceCents * i.quantity,
            0,
          );
          const discount = Math.min(rawDiscount, subtotal);
          const result = computeOrderTotals(items, discount, shipping);
          expect(result.subtotalCents).toBe(subtotal);
          expect(result.totalCents).toBe(subtotal - discount + shipping);
          expect(Number.isInteger(result.totalCents)).toBe(true);
          expect(result.totalCents).toBeGreaterThanOrEqual(shipping);
        },
      ),
    );
  });
});
