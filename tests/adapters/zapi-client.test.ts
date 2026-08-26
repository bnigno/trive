import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ZapiMessagingProvider } from "@/adapters/zapi/client";

type RecordedCall = {
  url: string;
  method: string | undefined;
  body: unknown;
};

/** Fetch fake injetável: grava as chamadas e responde o payload configurado. */
function createFakeFetch(payload: unknown, status = 200) {
  const calls: RecordedCall[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return new Response(JSON.stringify(payload), { status });
  }) as typeof fetch;
  return { calls, fetchFn };
}

describe("ZapiMessagingProvider (client real com fetch fake)", () => {
  beforeEach(() => {
    vi.stubEnv("ZAPI_INSTANCE_ID", "inst-test");
    vi.stubEnv("ZAPI_INSTANCE_TOKEN", "token-test");
    vi.stubEnv("ZAPI_CLIENT_TOKEN", "client-token-test");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("sendImage faz POST /send-image com phone sem '+', image e caption", async () => {
    const { calls, fetchFn } = createFakeFetch({ messageId: "mid-1" });
    const provider = new ZapiMessagingProvider(fetchFn);

    const sent = await provider.sendImage({
      toE164: "+5511999990000",
      imageUrl: "https://cdn.trive.example/produtos/colar.jpg",
      caption: "Colar de prata",
    });

    expect(sent).toEqual({ providerMessageId: "mid-1" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toMatch(/\/send-image$/);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toEqual({
      phone: "5511999990000",
      image: "https://cdn.trive.example/produtos/colar.jpg",
      caption: "Colar de prata",
    });
  });

  it("sendImage omite a chave caption quando ausente", async () => {
    const { calls, fetchFn } = createFakeFetch({ zaapId: "zid-1" });
    const provider = new ZapiMessagingProvider(fetchFn);

    const sent = await provider.sendImage({
      toE164: "+5511999990000",
      imageUrl: "https://cdn.trive.example/produtos/colar.jpg",
    });

    // Fallback de id: sem messageId, usa zaapId.
    expect(sent).toEqual({ providerMessageId: "zid-1" });
    expect(calls[0]?.body).toEqual({
      phone: "5511999990000",
      image: "https://cdn.trive.example/produtos/colar.jpg",
    });
  });

  it("sendOptionList faz POST /send-option-list com optionList aninhado", async () => {
    const { calls, fetchFn } = createFakeFetch({ id: 12345 });
    const provider = new ZapiMessagingProvider(fetchFn);

    const sent = await provider.sendOptionList({
      toE164: "+5511999990000",
      message: "Como quer receber?",
      title: "Entrega",
      buttonLabel: "Ver opções",
      options: [
        { id: "sedex", title: "Sedex", description: "2 dias úteis" },
        { id: "pac", title: "PAC" },
      ],
    });

    // Fallback de id: aceita 'id' numérico e normaliza para string.
    expect(sent).toEqual({ providerMessageId: "12345" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toMatch(/\/send-option-list$/);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toEqual({
      phone: "5511999990000",
      message: "Como quer receber?",
      optionList: {
        title: "Entrega",
        buttonLabel: "Ver opções",
        options: [
          { id: "sedex", title: "Sedex", description: "2 dias úteis" },
          // Sem description, a chave não vai no payload.
          { id: "pac", title: "PAC" },
        ],
      },
    });
  });

  it("lança quando a resposta não traz id de mensagem", async () => {
    const provider = new ZapiMessagingProvider(createFakeFetch({}).fetchFn);

    await expect(
      provider.sendImage({
        toE164: "+5511999990000",
        imageUrl: "https://cdn.trive.example/produtos/colar.jpg",
      }),
    ).rejects.toThrow(/send-image/);
    await expect(
      provider.sendOptionList({
        toE164: "+5511999990000",
        message: "Como quer receber?",
        title: "Entrega",
        buttonLabel: "Ver opções",
        options: [{ id: "pac", title: "PAC" }],
      }),
    ).rejects.toThrow(/send-option-list/);
  });

  it("lança em HTTP >= 400 sem expor a URL com tokens", async () => {
    const provider = new ZapiMessagingProvider(
      createFakeFetch({ messageId: "mid-1" }, 500).fetchFn,
    );

    const failure = provider.sendImage({
      toE164: "+5511999990000",
      imageUrl: "https://cdn.trive.example/produtos/colar.jpg",
    });
    await expect(failure).rejects.toThrow(/HTTP 500 em \/send-image/);
    await expect(failure).rejects.not.toThrow(/token-test/);
  });
});
