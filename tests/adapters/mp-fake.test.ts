import { describe, expect, it } from "vitest";

import type { PaymentGateway } from "../../src/adapters/mercadopago/index";
import { FakePaymentGateway } from "../../src/adapters/mercadopago/fake";

const ORDER_ID = "5f9b2f6a-0000-4000-8000-000000000001";

function checkoutInput(overrides: Partial<Parameters<PaymentGateway["createCheckoutPreference"]>[0]> = {}) {
  return {
    orderId: ORDER_ID,
    orderNumber: 42,
    externalReference: ORDER_ID,
    items: [
      { title: "Camiseta", quantity: 2, unitPriceCents: 4990 },
      { title: "Boné", quantity: 1, unitPriceCents: 2900 },
    ],
    payerEmail: "cliente@example.com",
    backUrl: "https://trive-lime.vercel.app/pedido/tok-123",
    ...overrides,
  };
}

describe("FakePaymentGateway (contrato atualizado)", () => {
  it("implementa a interface PaymentGateway", () => {
    const gateway: PaymentGateway = new FakePaymentGateway();
    expect(gateway.createCheckoutPreference).toBeTypeOf("function");
    expect(gateway.getPayment).toBeTypeOf("function");
    expect(gateway.refundPayment).toBeTypeOf("function");
  });

  it("cria preferência com pagamento pendente, total em centavos e externalReference", async () => {
    const gateway = new FakePaymentGateway();
    const preference = await gateway.createCheckoutPreference(checkoutInput());

    expect(preference.preferenceId).toBe("fake-pref-1");
    expect(preference.initPointUrl).toContain(preference.preferenceId);

    const paymentId = gateway.paymentIdForPreference(preference.preferenceId);
    const payment = await gateway.getPayment(paymentId);
    expect(payment).toEqual({
      paymentId,
      status: "pending",
      externalReference: ORDER_ID,
      amountCents: 2 * 4990 + 2900,
      feeCents: null,
      installments: null,
      paymentMethod: "pix",
    });
  });

  it("approvePayment aprova com taxa de 5% arredondada e installments", async () => {
    const gateway = new FakePaymentGateway();
    const preference = await gateway.createCheckoutPreference(
      checkoutInput({ items: [{ title: "Camiseta", quantity: 1, unitPriceCents: 4990 }] }),
    );
    const paymentId = gateway.paymentIdForPreference(preference.preferenceId);

    gateway.approvePayment(paymentId, {
      installments: 3,
      paymentMethod: "credit_card",
    });

    const payment = await gateway.getPayment(paymentId);
    expect(payment.status).toBe("approved");
    expect(payment.feeCents).toBe(Math.round(4990 * 0.05));
    expect(payment.installments).toBe(3);
    expect(payment.paymentMethod).toBe("credit_card");
  });

  it("approvePayment sem opções usa installments 1 e mantém pix", async () => {
    const gateway = new FakePaymentGateway();
    const preference = await gateway.createCheckoutPreference(checkoutInput());
    const paymentId = gateway.paymentIdForPreference(preference.preferenceId);

    gateway.approvePayment(paymentId);

    const payment = await gateway.getPayment(paymentId);
    expect(payment.installments).toBe(1);
    expect(payment.paymentMethod).toBe("pix");
  });

  it("rejectPayment e cancelPayment só funcionam a partir de pending", async () => {
    const gateway = new FakePaymentGateway();
    const p1 = await gateway.createCheckoutPreference(checkoutInput());
    const paymentId = gateway.paymentIdForPreference(p1.preferenceId);

    gateway.rejectPayment(paymentId);
    expect((await gateway.getPayment(paymentId)).status).toBe("rejected");
    expect(() => gateway.approvePayment(paymentId)).toThrow();
    expect(() => gateway.cancelPayment(paymentId)).toThrow();
  });

  it("refundPayment só funciona para pagamento aprovado", async () => {
    const gateway = new FakePaymentGateway();
    const preference = await gateway.createCheckoutPreference(checkoutInput());
    const paymentId = gateway.paymentIdForPreference(preference.preferenceId);

    await expect(gateway.refundPayment(paymentId)).rejects.toThrow();

    gateway.approvePayment(paymentId);
    await gateway.refundPayment(paymentId);
    expect((await gateway.getPayment(paymentId)).status).toBe("refunded");
  });

  it("getPayment de id desconhecido lança erro", async () => {
    const gateway = new FakePaymentGateway();
    await expect(gateway.getPayment("nope")).rejects.toThrow();
  });

  it("reset limpa pagamentos e reinicia a sequência", async () => {
    const gateway = new FakePaymentGateway();
    await gateway.createCheckoutPreference(checkoutInput());
    gateway.reset();

    await expect(gateway.getPayment("fake-payment-1")).rejects.toThrow();
    const preference = await gateway.createCheckoutPreference(checkoutInput());
    expect(preference.preferenceId).toBe("fake-pref-1");
  });
});
