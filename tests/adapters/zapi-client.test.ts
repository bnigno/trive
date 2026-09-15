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

  it("sendText com typingSeconds manda delayTyping e delayMessage: 1; sem, nenhum dos dois", async () => {
    const { calls, fetchFn } = createFakeFetch({ messageId: "mid-t" });
    const provider = new ZapiMessagingProvider(fetchFn);
    await provider.sendText({ toE164: "+5511999990000", body: "Oi!", typingSeconds: 2 });
    expect(calls[0]?.body).toEqual({ phone: "5511999990000", message: "Oi!", delayTyping: 2, delayMessage: 1 });
    await provider.sendText({ toE164: "+5511999990000", body: "Oi!" });
    expect(calls[1]?.body).toEqual({ phone: "5511999990000", message: "Oi!" });
    // Fora da faixa da Z-API (1–15): cortado.
    await provider.sendText({ toE164: "+5511999990000", body: "Oi!", typingSeconds: 40 });
    expect(calls[2]?.body).toMatchObject({ delayTyping: 15, delayMessage: 1 });
  });

  it("sendAudio com typingSeconds manda delayTyping ('gravando áudio…'); a lista só tira o atraso aleatório", async () => {
    const { calls, fetchFn } = createFakeFetch({ messageId: "mid-a" });
    const provider = new ZapiMessagingProvider(fetchFn);
    await provider.sendAudio({ toE164: "+5511999990000", audioUrl: "https://cdn.test/nota.ogg", typingSeconds: 3 });
    expect(calls[0]?.body).toEqual({ phone: "5511999990000", audio: "https://cdn.test/nota.ogg", waveform: true, delayTyping: 3, delayMessage: 1 });
    await provider.sendOptionList({ toE164: "+5511999990000", message: "Toque", title: "Peças", buttonLabel: "Ver", options: [{ id: "a", title: "A" }] });
    expect(calls[1]?.body).toMatchObject({ delayMessage: 1 });
    expect(calls[1]?.body).not.toHaveProperty("delayTyping");
  });

  it("markAsRead faz POST /read-message com phone sem '+' e messageId, com timeout; HTTP >= 400 lança", async () => {
    const { calls, fetchFn } = createFakeFetch({ value: true });
    const provider = new ZapiMessagingProvider(fetchFn);
    await provider.markAsRead({ fromE164: "+5511999990000", providerMessageId: "3EB0ABC" });
    expect(calls[0]?.url).toMatch(/\/read-message$/);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toEqual({ phone: "5511999990000", messageId: "3EB0ABC" });

    const failing = createFakeFetch({}, 500);
    await expect(
      new ZapiMessagingProvider(failing.fetchFn).markAsRead({ fromE164: "+5511999990000", providerMessageId: "x" }),
    ).rejects.toThrow(/HTTP 500/);
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

  it("sendAudio faz POST /send-audio com phone sem '+', a URL em `audio` e waveform (vira mensagem de voz)", async () => {
    const { calls, fetchFn } = createFakeFetch({ messageId: "mid-audio" });
    const provider = new ZapiMessagingProvider(fetchFn);

    const sent = await provider.sendAudio({
      toE164: "+5511999990000",
      audioUrl: "https://cdn.trive.example/products/x/curator-note.webm",
    });

    expect(sent).toEqual({ providerMessageId: "mid-audio" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toMatch(/\/send-audio$/);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toEqual({
      phone: "5511999990000",
      audio: "https://cdn.trive.example/products/x/curator-note.webm",
      waveform: true,
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
      delayMessage: 1,
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
      provider.sendAudio({ toE164: "+5511999990000", audioUrl: "https://cdn.trive.example/a.mp3" }),
    ).rejects.toThrow(/send-audio/);
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

describe("ZapiMessagingProvider.downloadMedia", () => {
  beforeEach(() => {
    vi.stubEnv("ZAPI_INSTANCE_ID", "inst-test");
    vi.stubEnv("ZAPI_INSTANCE_TOKEN", "token-test");
    vi.stubEnv("ZAPI_CLIENT_TOKEN", "client-token-test");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("faz GET na URL pública sem Client-Token e devolve bytes + content-type", async () => {
    const calls: { url: string; headers: unknown }[] = [];
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), headers: init?.headers });
      return new Response(Buffer.from("OggS-audio"), {
        status: 200,
        headers: { "content-type": "audio/ogg", "content-length": "10" },
      });
    }) as typeof fetch;
    const media = await new ZapiMessagingProvider(fetchFn).downloadMedia({
      url: "https://z-api.example/media/abc.ogg",
      maxBytes: 1024,
    });
    expect(media.contentType).toBe("audio/ogg");
    expect(media.data.toString()).toBe("OggS-audio");
    expect(calls[0]?.url).toBe("https://z-api.example/media/abc.ogg");
    expect(calls[0]?.headers).toBeUndefined();
  });

  it("recusa HTTP ≥ 400 e arquivo acima do limite (declarado ou real) sem expor a URL", async () => {
    const gone = (async () => new Response("", { status: 404 })) as typeof fetch;
    await expect(
      new ZapiMessagingProvider(gone).downloadMedia({ url: "https://z-api.example/secret", maxBytes: 10 }),
    ).rejects.toThrow(/HTTP 404/);

    const big = (async () =>
      new Response(Buffer.alloc(20), { status: 200, headers: { "content-length": "20" } })) as typeof fetch;
    const error = (await new ZapiMessagingProvider(big)
      .downloadMedia({ url: "https://z-api.example/secret", maxBytes: 10 })
      .catch((e: unknown) => e)) as Error;
    expect(error.message).toMatch(/limite/);
    expect(error.message).not.toContain("secret");

    const lying = (async () => new Response(Buffer.alloc(20), { status: 200 })) as typeof fetch;
    await expect(
      new ZapiMessagingProvider(lying).downloadMedia({ url: "https://z-api.example/x", maxBytes: 10 }),
    ).rejects.toThrow(/limite/);
  });
});
