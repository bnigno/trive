import { afterEach, describe, expect, it, vi } from "vitest";

import { FakeMailboxProvider } from "@/adapters/mailbox/fake";
import {
  MailboxError,
  isMailboxConfigured,
  type MailboxProvider,
} from "@/adapters/mailbox";

function createProvider(): FakeMailboxProvider {
  const provider = new FakeMailboxProvider();
  provider.seed({ from: "ana@example.com", subject: "Dúvida sobre o pedido" });
  provider.seed({ from: "bruno@example.com", subject: "Troca de tamanho" });
  provider.seed({ from: "ana@example.com", subject: "Re: Dúvida sobre o pedido" });
  return provider;
}

describe("FakeMailboxProvider", () => {
  it("implementa a interface MailboxProvider", () => {
    const provider: MailboxProvider = new FakeMailboxProvider();
    expect(typeof provider.fetchSince).toBe("function");
    expect(typeof provider.appendToSent).toBe("function");
    expect(typeof provider.markSeen).toBe("function");
  });

  it("seed numera os UIDs em sequência e dá Message-ID a cada mensagem", () => {
    const provider = createProvider();

    expect(provider.list().map((email) => email.uid)).toEqual([1, 2, 3]);
    expect(new Set(provider.list().map((email) => email.messageId)).size).toBe(3);
  });

  it("fetchSince devolve só o que veio DEPOIS do último UID, em ordem", async () => {
    const provider = createProvider();

    const primeiraRodada = await provider.fetchSince(0, 10);
    expect(primeiraRodada.map((email) => email.uid)).toEqual([1, 2, 3]);

    const segundaRodada = await provider.fetchSince(2, 10);
    expect(segundaRodada.map((email) => email.uid)).toEqual([3]);

    expect(await provider.fetchSince(3, 10)).toEqual([]);
  });

  it("fetchSince respeita o limite", async () => {
    const provider = createProvider();

    expect((await provider.fetchSince(0, 2)).map((email) => email.uid)).toEqual([
      1, 2,
    ]);
    expect(await provider.fetchSince(0, 0)).toEqual([]);
  });

  it("o que sai do fetchSince é cópia: mexer no retorno não mexe na caixa", async () => {
    const provider = createProvider();

    const [primeiro] = await provider.fetchSince(0, 1);
    primeiro!.subject = "adulterado";
    primeiro!.references.push("<intruso@example.com>");

    const [denovo] = await provider.fetchSince(0, 1);
    expect(denovo?.subject).toBe("Dúvida sobre o pedido");
    expect(denovo?.references).toEqual([]);
  });

  it("seed aceita remetente com nome, anexos e cadeia de resposta", async () => {
    const provider = new FakeMailboxProvider();
    provider.seed({
      from: { address: "ana@example.com", name: "Ana Souza" },
      to: ["contato@trivemaison.com.br"],
      cc: ["financeiro@trivemaison.com.br"],
      subject: "Re: Pedido #12",
      inReplyTo: "<raiz@trive.local>",
      references: ["<raiz@trive.local>"],
      textBody: "Segue o comprovante.",
      htmlBody: "<p>Segue o comprovante.</p>",
      attachments: [
        {
          filename: "comprovante.pdf",
          contentType: "application/pdf",
          content: new Uint8Array([1, 2, 3]),
        },
      ],
      receivedAt: new Date("2026-08-26T12:00:00.000Z"),
    });

    const [email] = await provider.fetchSince(0, 10);
    expect(email?.from).toEqual({ address: "ana@example.com", name: "Ana Souza" });
    expect(email?.cc).toEqual(["financeiro@trivemaison.com.br"]);
    expect(email?.references).toEqual(["<raiz@trive.local>"]);
    expect(email?.attachments[0]?.content).toEqual(new Uint8Array([1, 2, 3]));
    expect(email?.receivedAt.toISOString()).toBe("2026-08-26T12:00:00.000Z");
  });

  it("appendToSent guarda a cópia crua e markSeen registra o UID", async () => {
    const provider = createProvider();

    await provider.appendToSent("From: contato@trivemaison.com.br\r\n\r\nOi!");
    await provider.markSeen(1);
    await provider.markSeen(999);

    expect(provider.appendedToSent).toHaveLength(1);
    expect(provider.appendedToSent[0]).toContain("Oi!");
    // UID inexistente não é erro, igual ao IMAP real.
    expect(provider.seenUids).toEqual([1, 999]);
  });

  it("failNext faz só a PRÓXIMA chamada falhar, com MailboxError tipado", async () => {
    const provider = createProvider();
    provider.failNext("fetchSince", "indisponivel");

    await expect(provider.fetchSince(0, 10)).rejects.toMatchObject({
      name: "MailboxError",
      code: "indisponivel",
    });
    await expect(provider.fetchSince(0, 10)).resolves.toHaveLength(3);
  });

  it("failNext('autenticacao') carrega o código que o service usa para decidir", async () => {
    const provider = createProvider();
    provider.failNext("appendToSent", "autenticacao");

    const erro = await provider.appendToSent("cru").catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(MailboxError);
    expect((erro as MailboxError).code).toBe("autenticacao");
  });

  it("reset esvazia caixa, enviados, lidos e falhas programadas", async () => {
    const provider = createProvider();
    await provider.appendToSent("cru");
    await provider.markSeen(1);
    provider.failNext("fetchSince", "indisponivel");

    provider.reset();

    expect(provider.list()).toEqual([]);
    expect(provider.appendedToSent).toEqual([]);
    expect(provider.seenUids).toEqual([]);
    await expect(provider.fetchSince(0, 10)).resolves.toEqual([]);
    // UID reinicia junto: a caixa é outra depois do reset.
    expect(provider.seed({ from: "ana@example.com" }).uid).toBe(1);
  });
});

describe("isMailboxConfigured", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("em modo fake responde true sem precisar de variável nenhuma", () => {
    expect(isMailboxConfigured()).toBe(true);
  });

  it("em modo real exige as QUATRO variáveis", () => {
    vi.stubEnv("ADAPTER_MODE", "real");
    vi.stubEnv("EMAIL_INBOX_HOST", "imap.example.com");
    vi.stubEnv("EMAIL_INBOX_PORT", "993");
    vi.stubEnv("EMAIL_INBOX_USER", "contato@example.com");
    vi.stubEnv("EMAIL_INBOX_PASSWORD", "");
    expect(isMailboxConfigured()).toBe(false);

    vi.stubEnv("EMAIL_INBOX_PASSWORD", "senha-de-app");
    expect(isMailboxConfigured()).toBe(true);
  });
});
