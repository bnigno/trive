import { describe, expect, it } from "vitest";
import type { EmailProvider } from "../../src/adapters/email/index";
import { FakeEmailProvider } from "../../src/adapters/email/fake";

// Os testes do FakeMessagingProvider (contrato da Fase 4) vivem em
// tests/adapters/zapi-fake.test.ts; os do FakePaymentGateway (Fase 3) em
// tests/adapters/mp-fake.test.ts.

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

  it("devolve id determinístico por instância e guarda os campos de threading", async () => {
    const fake = new FakeEmailProvider();

    const primeiro = await fake.send({
      to: "cliente@example.com",
      subject: "Re: Pedido #12",
      html: "<p>Já separamos.</p>",
      replyTo: "contato@trivemaison.com.br",
      cc: ["financeiro@trivemaison.com.br"],
      headers: { "In-Reply-To": "<m1@example.com>" },
    });
    const segundo = await fake.send({
      to: "cliente@example.com",
      subject: "Pedido enviado",
      html: "<p>Saiu para entrega.</p>",
    });

    expect(primeiro).toEqual({ providerMessageId: "fake-email-1" });
    expect(segundo).toEqual({ providerMessageId: "fake-email-2" });
    expect(fake.sentEmails[0]?.headers).toEqual({
      "In-Reply-To": "<m1@example.com>",
    });
    expect(fake.sentEmails[0]?.cc).toEqual(["financeiro@trivemaison.com.br"]);

    fake.reset();
    await expect(
      fake.send({ to: "a@b.com", subject: "x", html: "<p>x</p>" }),
    ).resolves.toEqual({ providerMessageId: "fake-email-1" });
  });
});
