import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  MOVEMENT_TYPES,
  InsufficientStockError,
  SignError,
  applyMovement,
  isLowStock,
  movementsForTransition,
  type StockLevel,
  type StockMovement,
} from "@/core/stock/ledger";

const LEVEL: StockLevel = { onHand: 10, reserved: 3 };

function applyAll(level: StockLevel, movements: StockMovement[]): StockLevel {
  return movements.reduce((acc, m) => applyMovement(acc, m), level);
}

describe("applyMovement", () => {
  it("declara os 7 tipos de movimento", () => {
    expect(MOVEMENT_TYPES).toEqual([
      "purchase_in",
      "sale_out",
      "reservation",
      "reservation_release",
      "adjustment",
      "return_in",
      "loss",
    ]);
  });

  describe("sinal correto por tipo", () => {
    it("purchase_in (+) afeta onHand", () => {
      expect(
        applyMovement(LEVEL, { type: "purchase_in", quantityDelta: 5 }),
      ).toEqual({ onHand: 15, reserved: 3 });
    });
    it("return_in (+) afeta onHand", () => {
      expect(
        applyMovement(LEVEL, { type: "return_in", quantityDelta: 2 }),
      ).toEqual({ onHand: 12, reserved: 3 });
    });
    it("sale_out (−) afeta onHand", () => {
      expect(
        applyMovement(LEVEL, { type: "sale_out", quantityDelta: -4 }),
      ).toEqual({ onHand: 6, reserved: 3 });
    });
    it("loss (−) afeta onHand", () => {
      expect(applyMovement(LEVEL, { type: "loss", quantityDelta: -1 })).toEqual(
        { onHand: 9, reserved: 3 },
      );
    });
    it("adjustment aceita positivo e negativo em onHand", () => {
      expect(
        applyMovement(LEVEL, { type: "adjustment", quantityDelta: 7 }),
      ).toEqual({ onHand: 17, reserved: 3 });
      expect(
        applyMovement(LEVEL, { type: "adjustment", quantityDelta: -7 }),
      ).toEqual({ onHand: 3, reserved: 3 });
    });
    it("reservation (+) afeta reserved", () => {
      expect(
        applyMovement(LEVEL, { type: "reservation", quantityDelta: 4 }),
      ).toEqual({ onHand: 10, reserved: 7 });
    });
    it("reservation_release (−) afeta reserved", () => {
      expect(
        applyMovement(LEVEL, {
          type: "reservation_release",
          quantityDelta: -3,
        }),
      ).toEqual({ onHand: 10, reserved: 0 });
    });
  });

  describe("sinal errado lança SignError com mensagem pt-BR", () => {
    const wrongSign: StockMovement[] = [
      { type: "purchase_in", quantityDelta: -1 },
      { type: "return_in", quantityDelta: -1 },
      { type: "sale_out", quantityDelta: 1 },
      { type: "loss", quantityDelta: 1 },
      { type: "reservation", quantityDelta: -1 },
      { type: "reservation_release", quantityDelta: 1 },
    ];
    for (const m of wrongSign) {
      it(`${m.type} com delta ${m.quantityDelta}`, () => {
        expect(() => applyMovement(LEVEL, m)).toThrow(SignError);
        expect(() => applyMovement(LEVEL, m)).toThrow(/quantidade/);
      });
    }
  });

  describe("delta zero ou fracionário lança SignError", () => {
    for (const type of MOVEMENT_TYPES) {
      it(`${type} com delta 0`, () => {
        expect(() => applyMovement(LEVEL, { type, quantityDelta: 0 })).toThrow(
          SignError,
        );
      });
    }
    it("delta fracionário", () => {
      expect(() =>
        applyMovement(LEVEL, { type: "purchase_in", quantityDelta: 1.5 }),
      ).toThrow(SignError);
    });
  });

  describe("invariantes de estoque", () => {
    it("onHand não pode ficar negativo (estoque insuficiente)", () => {
      expect(() =>
        applyMovement(LEVEL, { type: "sale_out", quantityDelta: -11 }),
      ).toThrow(InsufficientStockError);
      expect(() =>
        applyMovement(LEVEL, { type: "adjustment", quantityDelta: -11 }),
      ).toThrow(InsufficientStockError);
    });
    it("reserved não pode ficar negativo", () => {
      expect(() =>
        applyMovement(LEVEL, {
          type: "reservation_release",
          quantityDelta: -4,
        }),
      ).toThrow(InsufficientStockError);
    });
    it("reserva além do disponível falha", () => {
      // disponível = 10 − 3 = 7
      expect(() =>
        applyMovement(LEVEL, { type: "reservation", quantityDelta: 8 }),
      ).toThrow(InsufficientStockError);
      expect(
        applyMovement(LEVEL, { type: "reservation", quantityDelta: 7 }),
      ).toEqual({ onHand: 10, reserved: 10 });
    });
    it("baixa de onHand abaixo da reserva falha", () => {
      expect(() =>
        applyMovement(LEVEL, { type: "sale_out", quantityDelta: -8 }),
      ).toThrow(InsufficientStockError);
    });
    it("não muta o nível de entrada", () => {
      const before = { ...LEVEL };
      applyMovement(LEVEL, { type: "purchase_in", quantityDelta: 1 });
      expect(LEVEL).toEqual(before);
    });
  });
});

describe("movementsForTransition", () => {
  it("reserve → uma reserva positiva", () => {
    expect(movementsForTransition("reserve", 3)).toEqual([
      { type: "reservation", quantityDelta: 3 },
    ]);
  });
  it("consume → libera reserva e baixa definitiva", () => {
    expect(movementsForTransition("consume", 3)).toEqual([
      { type: "reservation_release", quantityDelta: -3 },
      { type: "sale_out", quantityDelta: -3 },
    ]);
  });
  it("release → só libera reserva", () => {
    expect(movementsForTransition("release", 3)).toEqual([
      { type: "reservation_release", quantityDelta: -3 },
    ]);
  });
  it("return → entrada de devolução", () => {
    expect(movementsForTransition("return", 3)).toEqual([
      { type: "return_in", quantityDelta: 3 },
    ]);
  });

  it("sequência reserve→consume conserva o disponível e baixa onHand", () => {
    const start: StockLevel = { onHand: 10, reserved: 0 };
    const reserved = applyAll(start, movementsForTransition("reserve", 4));
    expect(reserved).toEqual({ onHand: 10, reserved: 4 });
    const availableBefore = reserved.onHand - reserved.reserved;
    const consumed = applyAll(reserved, movementsForTransition("consume", 4));
    expect(consumed).toEqual({ onHand: 6, reserved: 0 });
    expect(consumed.onHand - consumed.reserved).toBe(availableBefore);
  });

  it("sequência reserve→release volta ao estado inicial", () => {
    const start: StockLevel = { onHand: 10, reserved: 2 };
    const afterCycle = applyAll(start, [
      ...movementsForTransition("reserve", 5),
      ...movementsForTransition("release", 5),
    ]);
    expect(afterCycle).toEqual(start);
  });

  it("propriedade: aplicar efeitos válidos em sequência nunca viola invariantes", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1000 }),
        fc.array(
          fc.record({
            effect: fc.constantFrom(
              "reserve" as const,
              "consume" as const,
              "release" as const,
              "return" as const,
            ),
            quantity: fc.integer({ min: 1, max: 50 }),
          }),
          { maxLength: 30 },
        ),
        (initialOnHand, steps) => {
          let level: StockLevel = { onHand: initialOnHand, reserved: 0 };
          for (const step of steps) {
            const movements = movementsForTransition(
              step.effect,
              step.quantity,
            );
            let candidate = level;
            try {
              candidate = applyAll(candidate, movements);
            } catch (error) {
              // Efeito inviável para o nível atual é rejeitado — nível intacto.
              expect(
                error instanceof InsufficientStockError ||
                  error instanceof SignError,
              ).toBe(true);
              continue;
            }
            level = candidate;
            expect(level.onHand).toBeGreaterThanOrEqual(0);
            expect(level.reserved).toBeGreaterThanOrEqual(0);
            expect(level.onHand - level.reserved).toBeGreaterThanOrEqual(0);
          }
        },
      ),
    );
  });
});

describe("isLowStock", () => {
  it("compara o disponível (onHand − reserved) com o limiar", () => {
    expect(isLowStock({ onHand: 10, reserved: 8 }, 2)).toBe(true);
    expect(isLowStock({ onHand: 10, reserved: 8 }, 1)).toBe(false);
    expect(isLowStock({ onHand: 0, reserved: 0 }, 0)).toBe(true);
    expect(isLowStock({ onHand: 10, reserved: 0 }, 9)).toBe(false);
    expect(isLowStock({ onHand: 10, reserved: 0 }, 10)).toBe(true);
  });
});
