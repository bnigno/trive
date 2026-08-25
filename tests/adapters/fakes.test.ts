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
});
