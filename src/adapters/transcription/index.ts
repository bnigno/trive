// Transcrição de áudio (a vendedora "ouve" os áudios das clientes). Vendor
// atrás de interface própria: real = OpenAI (client.ts), fake = roteirizável
// (fake.ts). Seleção por ADAPTER_MODE, como os demais adapters.
import { getAdapterMode } from "../adapter-mode";
import { OpenAiTranscriber } from "./client";
import { FakeTranscriber } from "./fake";

export type TranscribeInput = {
  data: Buffer;
  /** Ex.: "audio/ogg; codecs=opus" (o que a Z-API entrega). */
  mimeType: string;
  languageHint?: "pt";
};

export type Transcription = {
  text: string;
  model: string;
};

export interface Transcriber {
  transcribe(input: TranscribeInput): Promise<Transcription>;
}

/**
 * Por que não transcreveu — quem chama escolhe a mensagem: sem chave é
 * configuração; recusado é o áudio; cota e fora do ar passam com o tempo.
 */
export type TranscriptionFailureReason = "no_key" | "rejected" | "rate_limited" | "unavailable";

/** Vendor fora do ar, sem chave ou resposta inválida: quem chama decide o fallback. */
export class TranscriptionUnavailableError extends Error {
  readonly reason: TranscriptionFailureReason;

  constructor(message: string, reason: TranscriptionFailureReason = "unavailable") {
    super(message);
    this.name = "TranscriptionUnavailableError";
    this.reason = reason;
  }
}

/** Há como transcrever neste ambiente? (fake: sempre; real: com OPENAI_API_KEY). */
export function isTranscriptionConfigured(): boolean {
  if (getAdapterMode() !== "real") return true;
  return typeof process.env.OPENAI_API_KEY === "string" && process.env.OPENAI_API_KEY.trim() !== "";
}

let instance: Transcriber | undefined;

export function getTranscriber(): Transcriber {
  if (!instance) {
    instance = getAdapterMode() === "real" ? new OpenAiTranscriber() : new FakeTranscriber();
  }
  return instance;
}
