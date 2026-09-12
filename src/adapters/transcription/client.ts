import { z } from "zod";

import type { TranscribeInput, Transcriber, Transcription } from "./index";
import { TranscriptionUnavailableError } from "./index";

const ENDPOINT = "https://api.openai.com/v1/audio/transcriptions";
export const TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";
const TIMEOUT_MS = 20_000;

const responseSchema = z.looseObject({ text: z.string() });

/** Extensão do arquivo pelo mime — a API decide o decodificador pelo nome. */
function fileNameFor(mimeType: string): string {
  const type = mimeType.toLowerCase();
  // O contêiner decide o nome, antes do codec: o Chrome grava
  // "audio/webm;codecs=opus" e isso é webm, não ogg.
  if (type.includes("webm")) return "audio.webm";
  if (type.includes("ogg") || type.includes("opus")) return "audio.ogg";
  if (type.includes("mpeg") || type.includes("mp3")) return "audio.mp3";
  if (type.includes("mp4") || type.includes("m4a") || type.includes("aac")) return "audio.m4a";
  if (type.includes("wav")) return "audio.wav";
  return "audio.ogg";
}

/**
 * Transcrição REAL com a API da OpenAI via fetch nativo (multipart). O áudio
 * da Z-API já vem em OGG/Opus, aceito direto; `language: "pt"` evita a
 * detecção automática errar em áudios curtos. Sem SDK: um endpoint só.
 */
export class OpenAiTranscriber implements Transcriber {
  private readonly fetchFn: typeof fetch;

  constructor(fetchFn: typeof fetch = fetch) {
    this.fetchFn = fetchFn;
  }

  async transcribe(input: TranscribeInput): Promise<Transcription> {
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) {
      throw new TranscriptionUnavailableError("OPENAI_API_KEY não configurada.", "no_key");
    }

    const form = new FormData();
    form.append(
      "file",
      new Blob([new Uint8Array(input.data)], { type: input.mimeType }),
      fileNameFor(input.mimeType),
    );
    form.append("model", TRANSCRIPTION_MODEL);
    form.append("language", input.languageHint ?? "pt");
    form.append("response_format", "json");

    let response: Response;
    try {
      response = await this.fetchFn(ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new TranscriptionUnavailableError(
        `Transcrição indisponível (rede/tempo): ${error instanceof Error ? error.message : "erro"}`,
      );
    }
    if (response.status >= 400) {
      // Nunca o corpo: pode ecoar o conteúdo do áudio. 4xx (menos cota) é o
      // vendor recusando ESTE pedido — formato, chave inválida —, não uma queda.
      const reason =
        response.status === 429 ? "rate_limited" : response.status < 500 ? "rejected" : "unavailable";
      throw new TranscriptionUnavailableError(`Transcrição respondeu HTTP ${response.status}.`, reason);
    }

    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      throw new TranscriptionUnavailableError("Transcrição devolveu resposta inválida.");
    }
    const parsed = responseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new TranscriptionUnavailableError("Transcrição devolveu resposta sem texto.");
    }
    return { text: parsed.data.text, model: TRANSCRIPTION_MODEL };
  }
}
