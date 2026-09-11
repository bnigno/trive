import type { TranscribeInput, Transcriber, Transcription } from "./index";
import { TranscriptionUnavailableError } from "./index";

/**
 * Transcritor roteirizável para testes/demos: cada chamada consome o próximo
 * texto da fila; `failNext()` simula o vendor fora do ar. Sem roteiro,
 * devolve um texto fixo com o tamanho do áudio.
 */
export class FakeTranscriber implements Transcriber {
  readonly calls: TranscribeInput[] = [];
  private readonly queue: (string | Error)[] = [];

  enqueueText(text: string): void {
    this.queue.push(text);
  }

  failNext(message = "vendor fora do ar (fake)"): void {
    this.queue.push(new TranscriptionUnavailableError(message));
  }

  async transcribe(input: TranscribeInput): Promise<Transcription> {
    this.calls.push(input);
    const next = this.queue.shift();
    if (next instanceof Error) throw next;
    return {
      text: next ?? `transcrição fake (${input.data.byteLength} bytes)`,
      model: "fake-transcribe",
    };
  }

  reset(): void {
    this.calls.length = 0;
    this.queue.length = 0;
  }
}
