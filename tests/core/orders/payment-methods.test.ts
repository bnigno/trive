import { describe, expect, it } from "vitest";
import {
  ALL_PAYMENT_METHODS,
  MP_PAYMENT_METHODS,
  PAYMENT_METHOD_LABELS,
  PAYMENT_METHOD_LABELS_SHORT,
} from "@/core/orders/payment-methods";

describe("payment-methods", () => {
  it("declara os 5 métodos na ordem canônica", () => {
    expect(ALL_PAYMENT_METHODS).toEqual([
      "pix",
      "credit_card",
      "boleto",
      "pix_manual",
      "cash",
    ]);
  });

  it("MP_PAYMENT_METHODS são exatamente os 3 primeiros", () => {
    expect(MP_PAYMENT_METHODS).toEqual(["pix", "credit_card", "boleto"]);
    expect(MP_PAYMENT_METHODS).toEqual(ALL_PAYMENT_METHODS.slice(0, 3));
  });

  it("labels longos pt-BR para todos os métodos", () => {
    expect(PAYMENT_METHOD_LABELS).toEqual({
      pix: "Pix",
      credit_card: "Cartão de crédito",
      boleto: "Boleto",
      pix_manual: "Pix manual",
      cash: "Dinheiro na entrega",
    });
  });

  it("labels curtos: só credit_card muda", () => {
    expect(PAYMENT_METHOD_LABELS_SHORT.credit_card).toBe("Cartão");
    for (const method of ALL_PAYMENT_METHODS) {
      if (method === "credit_card") continue;
      expect(PAYMENT_METHOD_LABELS_SHORT[method]).toBe(
        PAYMENT_METHOD_LABELS[method],
      );
    }
  });
});
