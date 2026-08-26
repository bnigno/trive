// O que importa aqui é o CORPO que sai para o Resend: sem reply_to a resposta
// do cliente não chega na caixa que lemos por IMAP, e sem In-Reply-To/
// References o Gmail dele não encaixa a mensagem na conversa.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ResendEmailProvider } from "@/adapters/email/client";
import { buildReplyHeaders } from "@/core/email/threading";

type RecordedCall = {
  url: string;
  method: string | undefined;
  body: Record<string, unknown> | undefined;
};

/** Fetch fake injetável: grava as chamadas e responde o payload configurado. */
function createFakeFetch(payload: unknown, status = 200) {
  const calls: RecordedCall[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method,
      body:
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : undefined,
    });
    return new Response(JSON.stringify(payload), { status });
  }) as typeof fetch;
  return { calls, fetchFn };
}

describe("ResendEmailProvider (client real com fetch fake)", () => {
  beforeEach(() => {
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("EMAIL_FROM", "TRIVË <contato@trivemaison.com.br>");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("devolve o id do e-mail enviado", async () => {
    const { fetchFn } = createFakeFetch({ id: "resend-1" });
    const provider = new ResendEmailProvider(fetchFn);

    await expect(
      provider.send({
        to: "cliente@example.com",
        subject: "Pedido confirmado",
        html: "<p>Obrigado!</p>",
      }),
    ).resolves.toEqual({ providerMessageId: "resend-1" });
  });

  it("repassa reply_to, cc e headers de threading", async () => {
    const { calls, fetchFn } = createFakeFetch({ id: "resend-2" });
    const provider = new ResendEmailProvider(fetchFn);

    await provider.send({
      to: "cliente@example.com",
      subject: "Re: Pedido #12",
      html: "<p>Já separamos.</p>",
      text: "Já separamos.",
      replyTo: "contato@trivemaison.com.br",
      cc: ["financeiro@trivemaison.com.br"],
      headers: buildReplyHeaders({
        messageId: "<m2@example.com>",
        references: ["<raiz@example.com>"],
      }),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual({
      from: "TRIVË <contato@trivemaison.com.br>",
      to: ["cliente@example.com"],
      subject: "Re: Pedido #12",
      html: "<p>Já separamos.</p>",
      text: "Já separamos.",
      reply_to: "contato@trivemaison.com.br",
      cc: ["financeiro@trivemaison.com.br"],
      headers: {
        "In-Reply-To": "<m2@example.com>",
        References: "<raiz@example.com> <m2@example.com>",
      },
    });
  });

  it("omite as chaves novas quando não há o que mandar", async () => {
    const { calls, fetchFn } = createFakeFetch({ id: "resend-3" });
    const provider = new ResendEmailProvider(fetchFn);

    await provider.send({
      to: "cliente@example.com",
      subject: "Pedido confirmado",
      html: "<p>Obrigado!</p>",
      cc: [],
      headers: {},
    });

    expect(calls[0]?.body).toEqual({
      from: "TRIVË <contato@trivemaison.com.br>",
      to: ["cliente@example.com"],
      subject: "Pedido confirmado",
      html: "<p>Obrigado!</p>",
    });
  });

  it("falha alto quando a resposta do Resend não traz o id", async () => {
    const { fetchFn } = createFakeFetch({ nada: true });
    const provider = new ResendEmailProvider(fetchFn);

    await expect(
      provider.send({
        to: "cliente@example.com",
        subject: "Pedido confirmado",
        html: "<p>Obrigado!</p>",
      }),
    ).rejects.toThrow(/id/);
  });
});
