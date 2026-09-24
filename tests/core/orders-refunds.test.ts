// A fronteira entre "o sistema devolve" e "o dono devolve", e quando a
// cliente pode ser avisada. Regra nascida de um caso real: o pedido #1004
// ficou 'refunded' e a cliente foi avisada, com o dinheiro ainda no vendor.
import { describe, expect, it } from "vitest";

import {
  initialRefundState,
  isAutomaticRefund,
  mayAnnounceRefund,
  REFUND_STATES,
  type RefundState,
} from "@/core/orders/refunds";

describe("rota do reembolso", () => {
  it("estorna sozinho o que passou pelo Mercado Pago", () => {
    for (const method of ["pix", "credit_card", "boleto"] as const) {
      expect(isAutomaticRefund({ paymentMethod: method, mpPaymentId: "180085960636" })).toBe(true);
      expect(initialRefundState({ paymentMethod: method, mpPaymentId: "180085960636" })).toBe("pendente");
    }
  });

  it("Pix manual e dinheiro na entrega ficam com o dono", () => {
    for (const method of ["pix_manual", "cash"] as const) {
      expect(isAutomaticRefund({ paymentMethod: method, mpPaymentId: "180085960636" })).toBe(false);
      expect(initialRefundState({ paymentMethod: method, mpPaymentId: null })).toBe("nao_aplicavel");
    }
  });

  it("método do MP sem id de pagamento não tem o que estornar", () => {
    expect(isAutomaticRefund({ paymentMethod: "pix", mpPaymentId: null })).toBe(false);
    expect(isAutomaticRefund({ paymentMethod: "pix", mpPaymentId: "   " })).toBe(false);
  });

  it("pedido sem forma de pagamento não estorna sozinho", () => {
    expect(isAutomaticRefund({ paymentMethod: null, mpPaymentId: "180085960636" })).toBe(false);
  });

  it("a cliente só é avisada quando o dinheiro saiu (ou quando a devolução é por fora)", () => {
    expect(mayAnnounceRefund("devolvido")).toBe(true);
    expect(mayAnnounceRefund("nao_aplicavel")).toBe(true);
    // O aviso prematuro é justamente o defeito que esta regra existe para impedir.
    expect(mayAnnounceRefund("pendente")).toBe(false);
    expect(mayAnnounceRefund("falhou")).toBe(false);
  });

  it("todo estado tem rótulo e a lista é fechada", () => {
    expect(REFUND_STATES).toEqual(["nao_aplicavel", "pendente", "devolvido", "falhou"]);
    for (const state of REFUND_STATES) expect(mayAnnounceRefund(state as RefundState)).toBeTypeOf("boolean");
  });
});
