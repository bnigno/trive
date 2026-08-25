import { describe, expect, it } from "vitest";
import type { PaymentGateway } from "../../src/adapters/mercadopago/index";
import { FakePaymentGateway } from "../../src/adapters/mercadopago/fake";
import type { MessagingProvider } from "../../src/adapters/zapi/index";
import { FakeMessagingProvider } from "../../src/adapters/zapi/fake";
import type { EmailProvider } from "../../src/adapters/email/index";
import { FakeEmailProvider } from "../../src/adapters/email/fake";

describe("FakePaymentGateway", () => {
  it("implementa a interface PaymentGateway", () => {
    const gateway: PaymentGateway = new FakePaymentGateway();
    expect(gateway.createCheckoutPreference).toBeTypeOf("function");
    expect(gateway.getPayment).toBeTypeOf("function");
    expect(gateway.refundPayment).toBeTypeOf("function");
  });

  it("cria preferência de checkout com pagamento pendente e total em centavos", async () => {
    const gateway = new FakePaymentGateway();
    const preference = await gateway.createCheckoutPreference({
      orderId: "5f9b2f6a-0000-4000-8000-000000000001",
      items: [
        { title: "Camiseta", quantity: 2, unitPriceCents: 4990 },
        { title: "Boné", quantity: 1, unitPriceCents: 2900 },
      ],
      payerEmail: "cliente@example.com",
    });

    expect(preference.preferenceId).toBe("fake-pref-1");
    expect(preference.initPointUrl).toContain(preference.preferenceId);

    const paymentId = gateway.paymentIdForPreference(preference.preferenceId);
    const payment = await gateway.getPayment(paymentId);
    expect(payment.status).toBe("pending");
    expect(payment.amountCents).toBe(2 * 4990 + 2900);
    expect(payment.orderId).toBe("5f9b2f6a-0000-4000-8000-000000000001");
  });

  it("approvePayment muda o status para approved", async () => {
    const gateway = new FakePaymentGateway();
    const preference = await gateway.createCheckoutPreference({
      orderId: "5f9b2f6a-0000-4000-8000-000000000002",
      items: [{ title: "Camiseta", quantity: 1, unitPriceCents: 4990 }],
    });
    const paymentId = gateway.paymentIdForPreference(preference.preferenceId);

    gateway.approvePayment(paymentId);

    const payment = await gateway.getPayment(paymentId);
    expect(payment.status).toBe("approved");
    expect(payment.installments).toBe(1);
    expect(Number.isInteger(payment.feeCents)).toBe(true);
  });

  it("refundPayment só funciona para pagamento aprovado", async () => {
    const gateway = new FakePaymentGateway();
    const preference = await gateway.createCheckoutPreference({
      orderId: "5f9b2f6a-0000-4000-8000-000000000003",
      items: [{ title: "Camiseta", quantity: 1, unitPriceCents: 4990 }],
    });
    const paymentId = gateway.paymentIdForPreference(preference.preferenceId);

    await expect(gateway.refundPayment(paymentId)).rejects.toThrow();

    gateway.approvePayment(paymentId);
    await gateway.refundPayment(paymentId);
    const payment = await gateway.getPayment(paymentId);
    expect(payment.status).toBe("refunded");
  });

  it("getPayment de id desconhecido lança erro", async () => {
    const gateway = new FakePaymentGateway();
    await expect(gateway.getPayment("nope")).rejects.toThrow();
  });
});

describe("FakeMessagingProvider", () => {
  it("implementa a interface MessagingProvider", () => {
    const provider: MessagingProvider = new FakeMessagingProvider();
    expect(provider.sendText).toBeTypeOf("function");
    expect(provider.getSessionStatus).toBeTypeOf("function");
  });

  it("sendText registra a mensagem e retorna providerMessageId", async () => {
    const provider = new FakeMessagingProvider();
    const result = await provider.sendText({
      toE164: "+5511999990000",
      body: "Seu pedido foi confirmado!",
    });

    expect(result.providerMessageId).toBe("fake-zapi-msg-1");
    expect(provider.sentMessages).toHaveLength(1);
    expect(provider.sentMessages[0]).toMatchObject({
      providerMessageId: "fake-zapi-msg-1",
      toE164: "+5511999990000",
      body: "Seu pedido foi confirmado!",
    });
  });

  it("dedupeKey repetido não duplica a mensagem e devolve o mesmo id", async () => {
    const provider = new FakeMessagingProvider();
    const first = await provider.sendText({
      toE164: "+5511999990000",
      body: "Oi",
      dedupeKey: "order-1:confirmed",
    });
    const second = await provider.sendText({
      toE164: "+5511999990000",
      body: "Oi",
      dedupeKey: "order-1:confirmed",
    });

    expect(second.providerMessageId).toBe(first.providerMessageId);
    expect(provider.sentMessages).toHaveLength(1);
  });

  it("desconectado: sendText lança erro e status expõe qrCodeUrl", async () => {
    const provider = new FakeMessagingProvider();
    await expect(provider.getSessionStatus()).resolves.toEqual({ connected: true });

    provider.simulateDisconnect();

    await expect(
      provider.sendText({ toE164: "+5511999990000", body: "Oi" }),
    ).rejects.toThrow();
    const status = await provider.getSessionStatus();
    expect(status.connected).toBe(false);
    expect(status.qrCodeUrl).toBeTypeOf("string");

    provider.simulateReconnect();
    await expect(
      provider.sendText({ toE164: "+5511999990000", body: "Oi de novo" }),
    ).resolves.toHaveProperty("providerMessageId");
  });
});

describe("FakeEmailProvider", () => {
  it("implementa a interface EmailProvider e registra envios", async () => {
    const provider: EmailProvider = new FakeEmailProvider();
    const fake = provider as FakeEmailProvider;

    await provider.send({
      to: "cliente@example.com",
      subject: "Pedido confirmado",
      html: "<p>Obrigado pela compra!</p>",
      text: "Obrigado pela compra!",
    });

    expect(fake.sentEmails).toHaveLength(1);
    expect(fake.sentEmails[0]).toEqual({
      to: "cliente@example.com",
      subject: "Pedido confirmado",
      html: "<p>Obrigado pela compra!</p>",
      text: "Obrigado pela compra!",
    });
  });
});
