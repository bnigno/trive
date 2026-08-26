import { describe, expect, it } from "vitest";
import {
  ORDER_STATUSES,
  ORDER_STATUS_LABELS,
  VALID_TRANSITIONS,
  InvalidTransitionError,
  assertTransition,
  canTransition,
  requiredStockEffect,
  timestampFieldFor,
  type OrderStatus,
} from "@/core/orders/state-machine";

const VALID_PAIRS: ReadonlySet<string> = new Set([
  "draft->pending_payment",
  "draft->canceled",
  "pending_payment->paid",
  "pending_payment->canceled",
  "paid->preparing",
  "paid->canceled",
  "paid->refunded",
  "paid->delivered",
  "preparing->shipped",
  "preparing->canceled",
  "preparing->refunded",
  "shipped->delivered",
  "shipped->refunded",
  "delivered->refunded",
]);

describe("máquina de estados do pedido", () => {
  it("declara os 8 status na ordem canônica", () => {
    expect(ORDER_STATUSES).toEqual([
      "draft",
      "pending_payment",
      "paid",
      "preparing",
      "shipped",
      "delivered",
      "canceled",
      "refunded",
    ]);
  });

  describe("matriz completa 8x8 (canTransition e assertTransition)", () => {
    for (const from of ORDER_STATUSES) {
      for (const to of ORDER_STATUSES) {
        const expected = VALID_PAIRS.has(`${from}->${to}`);
        it(`${from} -> ${to}: ${expected ? "válida" : "inválida"}`, () => {
          expect(canTransition(from, to)).toBe(expected);
          if (expected) {
            expect(() => assertTransition(from, to)).not.toThrow();
          } else {
            expect(() => assertTransition(from, to)).toThrow(
              InvalidTransitionError,
            );
          }
        });
      }
    }
  });

  it("VALID_TRANSITIONS espelha exatamente a matriz esperada", () => {
    for (const from of ORDER_STATUSES) {
      const expected = ORDER_STATUSES.filter((to) =>
        VALID_PAIRS.has(`${from}->${to}`),
      );
      expect([...VALID_TRANSITIONS[from]].sort()).toEqual(
        [...expected].sort(),
      );
    }
  });

  it("estados terminais não têm saídas", () => {
    expect(VALID_TRANSITIONS.canceled).toEqual([]);
    expect(VALID_TRANSITIONS.refunded).toEqual([]);
  });

  it("erro de transição inválida tem mensagem pt-BR com os rótulos", () => {
    try {
      assertTransition("delivered", "paid");
      expect.unreachable("deveria ter lançado");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidTransitionError);
      const message = (error as Error).message;
      expect(message).toContain("Entregue");
      expect(message).toContain("Pago");
      expect(message).toContain("inválida");
    }
  });

  it("labels pt-BR completos para todos os status", () => {
    expect(ORDER_STATUS_LABELS).toEqual({
      draft: "Rascunho",
      pending_payment: "Aguardando pagamento",
      paid: "Pago",
      preparing: "Em separação",
      shipped: "Enviado",
      delivered: "Entregue",
      canceled: "Cancelado",
      refunded: "Reembolsado",
    });
  });

  describe("requiredStockEffect por transição (matriz completa)", () => {
    const EFFECTS: Record<string, "reserve" | "consume" | "release"> = {
      "draft->pending_payment": "reserve",
      "pending_payment->paid": "consume",
      "pending_payment->canceled": "release",
    };
    for (const from of ORDER_STATUSES) {
      for (const to of ORDER_STATUSES) {
        const expected = EFFECTS[`${from}->${to}`] ?? null;
        it(`${from} -> ${to}: ${expected ?? "null"}`, () => {
          expect(requiredStockEffect(from, to)).toBe(expected);
        });
      }
    }
  });

  it("devolução física não é automática: cancelamento pós-pagamento e reembolso retornam null", () => {
    expect(requiredStockEffect("paid", "canceled")).toBeNull();
    expect(requiredStockEffect("preparing", "canceled")).toBeNull();
    expect(requiredStockEffect("paid", "refunded")).toBeNull();
    expect(requiredStockEffect("shipped", "refunded")).toBeNull();
    expect(requiredStockEffect("delivered", "refunded")).toBeNull();
    expect(requiredStockEffect("draft", "canceled")).toBeNull();
  });

  describe("timestampFieldFor por status de destino", () => {
    const FIELDS: Record<OrderStatus, string | null> = {
      draft: null,
      pending_payment: null,
      paid: "paid_at",
      preparing: null,
      shipped: "shipped_at",
      delivered: "delivered_at",
      canceled: "canceled_at",
      refunded: null,
    };
    for (const to of ORDER_STATUSES) {
      it(`${to}: ${FIELDS[to] ?? "null"}`, () => {
        expect(timestampFieldFor(to)).toBe(FIELDS[to]);
      });
    }
  });
});
