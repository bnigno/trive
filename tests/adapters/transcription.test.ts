// Adapter de transcrição: o client real com fetch fake (multipart, chave,
// erros sem vazar corpo) e o fake roteirizável.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getTranscriber,
  isTranscriptionConfigured,
  TranscriptionUnavailableError,
} from "@/adapters/transcription";
import { OpenAiTranscriber, TRANSCRIPTION_MODEL } from "@/adapters/transcription/client";
import { FakeTranscriber } from "@/adapters/transcription/fake";

function createFakeFetch(payload: unknown, status = 200) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(payload), { status });
  }) as typeof fetch;
  return { calls, fetchFn };
}

describe("OpenAiTranscriber (client real com fetch fake)", () => {
  beforeEach(() => {
    vi.stubEnv("OPENAI_API_KEY", "sk-teste");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("manda multipart com o arquivo, o modelo e language=pt e devolve o texto", async () => {
    const { calls, fetchFn } = createFakeFetch({ text: "quero o vestido no M" });
    const result = await new OpenAiTranscriber(fetchFn).transcribe({
      data: Buffer.from("OggS"),
      mimeType: "audio/ogg; codecs=opus",
      languageHint: "pt",
    });
    expect(result).toEqual({ text: "quero o vestido no M", model: TRANSCRIPTION_MODEL });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/audio/transcriptions");
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-teste");
    const form = calls[0]?.init?.body as FormData;
    expect(form.get("model")).toBe(TRANSCRIPTION_MODEL);
    expect(form.get("language")).toBe("pt");
    const file = form.get("file") as File;
    expect(file.name).toBe("audio.ogg");
    expect(file.size).toBe(4);

    // O webm/opus do Chrome (nota da curadora) vai como webm, não como ogg.
    const webm = createFakeFetch({ text: "ok" });
    await new OpenAiTranscriber(webm.fetchFn).transcribe({ data: Buffer.alloc(2), mimeType: "audio/webm;codecs=opus" });
    expect(((webm.calls[0]?.init?.body as FormData).get("file") as File).name).toBe("audio.webm");
    const m4a = createFakeFetch({ text: "ok" });
    await new OpenAiTranscriber(m4a.fetchFn).transcribe({ data: Buffer.alloc(2), mimeType: "audio/mp4" });
    expect(((m4a.calls[0]?.init?.body as FormData).get("file") as File).name).toBe("audio.m4a");
  });

  it("sem chave, HTTP ≥ 400 ou resposta sem texto → TranscriptionUnavailableError sem o corpo", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    await expect(
      new OpenAiTranscriber(createFakeFetch({}).fetchFn).transcribe({ data: Buffer.alloc(1), mimeType: "audio/ogg" }),
    ).rejects.toBeInstanceOf(TranscriptionUnavailableError);

    vi.stubEnv("OPENAI_API_KEY", "sk-teste");
    const error = await new OpenAiTranscriber(createFakeFetch({ error: "segredo do corpo" }, 429).fetchFn)
      .transcribe({ data: Buffer.alloc(1), mimeType: "audio/ogg" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TranscriptionUnavailableError);
    // O motivo distingue cota, recusa deste pedido e queda.
    expect((error as TranscriptionUnavailableError).reason).toBe("rate_limited");
    const reasonOf = async (status: number) =>
      new OpenAiTranscriber(createFakeFetch({}, status).fetchFn)
        .transcribe({ data: Buffer.alloc(1), mimeType: "audio/ogg" })
        .then(() => "ok")
        .catch((e: unknown) => (e as TranscriptionUnavailableError).reason);
    expect(await reasonOf(400)).toBe("rejected");
    expect(await reasonOf(503)).toBe("unavailable");
    // Chave inválida ou revogada é configuração, não o áudio da dona.
    expect(await reasonOf(401)).toBe("no_key");
    expect(await reasonOf(403)).toBe("no_key");
    vi.stubEnv("OPENAI_API_KEY", "   ");
    const semChave = await new OpenAiTranscriber(createFakeFetch({}).fetchFn)
      .transcribe({ data: Buffer.alloc(1), mimeType: "audio/ogg" })
      .catch((e: unknown) => (e as TranscriptionUnavailableError).reason);
    expect(semChave).toBe("no_key");
    vi.stubEnv("OPENAI_API_KEY", "sk-teste");
    // Corpo que não é JSON (página de erro do provedor) é "fora do ar", sem vazar o corpo.
    const html = await new OpenAiTranscriber(async () => new Response("<html>erro</html>", { status: 200 }))
      .transcribe({ data: Buffer.alloc(1), mimeType: "audio/ogg" })
      .then(() => null)
      .catch((e: unknown) => e as TranscriptionUnavailableError);
    expect(html?.reason).toBe("unavailable");
    expect(html?.message).not.toContain("<html>");
    expect((error as Error).message).toContain("429");
    expect((error as Error).message).not.toContain("segredo");

    await expect(
      new OpenAiTranscriber(createFakeFetch({ nope: 1 }).fetchFn).transcribe({ data: Buffer.alloc(1), mimeType: "audio/ogg" }),
    ).rejects.toBeInstanceOf(TranscriptionUnavailableError);
  });

  it("rede caída vira TranscriptionUnavailableError", async () => {
    const fetchFn = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    await expect(
      new OpenAiTranscriber(fetchFn).transcribe({ data: Buffer.alloc(1), mimeType: "audio/ogg" }),
    ).rejects.toBeInstanceOf(TranscriptionUnavailableError);
  });
});

describe("FakeTranscriber + seleção por ADAPTER_MODE", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("consome o roteiro, simula falha e grava as chamadas", async () => {
    const fake = new FakeTranscriber();
    fake.enqueueText("oi, tem no P?");
    fake.failNext();
    expect(await fake.transcribe({ data: Buffer.alloc(3), mimeType: "audio/ogg" })).toEqual({
      text: "oi, tem no P?",
      model: "fake-transcribe",
    });
    await expect(fake.transcribe({ data: Buffer.alloc(3), mimeType: "audio/ogg" })).rejects.toBeInstanceOf(
      TranscriptionUnavailableError,
    );
    expect((await fake.transcribe({ data: Buffer.alloc(3), mimeType: "audio/ogg" })).text).toContain("3 bytes");
    expect(fake.calls).toHaveLength(3);
    fake.reset();
    expect(fake.calls).toHaveLength(0);
  });

  it("em modo fake está sempre configurado e devolve o fake; em real depende da chave", () => {
    vi.stubEnv("ADAPTER_MODE", "fake");
    expect(isTranscriptionConfigured()).toBe(true);
    expect(getTranscriber()).toBeInstanceOf(FakeTranscriber);
    vi.stubEnv("ADAPTER_MODE", "real");
    vi.stubEnv("OPENAI_API_KEY", "");
    expect(isTranscriptionConfigured()).toBe(false);
    vi.stubEnv("OPENAI_API_KEY", "sk-x");
    expect(isTranscriptionConfigured()).toBe(true);
  });
});
