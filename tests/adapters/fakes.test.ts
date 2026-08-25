import { describe, expect, it } from "vitest";
import type { MessagingProvider } from "../../src/adapters/zapi/index";
import { FakeMessagingProvider } from "../../src/adapters/zapi/fake";
import type { EmailProvider } from "../../src/adapters/email/index";
import { FakeEmailProvider } from "../../src/adapters/email/fake";

// Os testes do FakePaymentGateway (contrato da Fase 3) vivem em
// tests/adapters/mp-fake.test.ts.

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
