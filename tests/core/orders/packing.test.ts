// Embalar antes de sair (puro): só a foto do pacote libera; quem já saiu
// antes da regra não é barrado.
import { describe, expect, it } from "vitest";

import { needsPackingBeforeDispatch, notPackedMessage } from "@/core/orders/packing";

describe("needsPackingBeforeDispatch", () => {
  it("sem foto e ainda na loja: precisa embalar (pago, em separação e dinheiro na entrega)", () => {
    expect(needsPackingBeforeDispatch({ status: "paid", packagePhotoPath: null })).toBe(true);
    expect(needsPackingBeforeDispatch({ status: "preparing", packagePhotoPath: null, dispatchedAt: null })).toBe(true);
    expect(needsPackingBeforeDispatch({ status: "pending_payment", packagePhotoPath: undefined })).toBe(true);
  });

  it("com foto libera; quem já saiu (dispatchedAt), enviado ou entregue não é barrado — pedidos de antes da regra fecham normalmente", () => {
    expect(needsPackingBeforeDispatch({ status: "paid", packagePhotoPath: "packages/x/embalagem.jpg" })).toBe(false);
    expect(needsPackingBeforeDispatch({ status: "preparing", packagePhotoPath: null, dispatchedAt: "2026-09-18T03:14:00.000Z" })).toBe(false);
    expect(needsPackingBeforeDispatch({ status: "shipped", packagePhotoPath: null })).toBe(false);
    expect(needsPackingBeforeDispatch({ status: "delivered", packagePhotoPath: null })).toBe(false);
  });

  it("a mensagem nomeia o pedido e a ação", () => {
    expect(notPackedMessage(1016, "sair")).toBe("O pedido #1016 ainda não foi embalado: registre a foto do pacote (Mesa de embalagem ou card Embalagem da ficha) antes de marcar que saiu.");
    expect(notPackedMessage(7, "enviar")).toContain("antes de marcar como enviado.");
  });
});
