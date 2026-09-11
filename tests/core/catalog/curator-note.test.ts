// A nota da curadora (PURO): formatos de áudio aceitos, limpeza do texto,
// caminho do arquivo e o relógio do player.
import { describe, expect, it } from "vitest";

import {
  CURATOR_AUDIO_MAX_BYTES,
  CURATOR_AUDIO_MAX_SECONDS,
  CURATOR_NOTE_MAX_CHARS,
  curatorAudioExtension,
  curatorAudioStoragePath,
  formatAudioSeconds,
  normalizeCuratorNote,
} from "@/core/catalog/curator-note";

describe("curatorAudioExtension", () => {
  it("aceita o que os navegadores gravam, com ou sem codecs no mime", () => {
    expect(curatorAudioExtension("audio/webm;codecs=opus")).toBe("webm");
    expect(curatorAudioExtension("audio/webm")).toBe("webm");
    // iPhone.
    expect(curatorAudioExtension("audio/mp4")).toBe("m4a");
    expect(curatorAudioExtension("audio/x-m4a")).toBe("m4a");
    expect(curatorAudioExtension("AUDIO/OGG; codecs=opus")).toBe("ogg");
    expect(curatorAudioExtension("audio/mpeg")).toBe("mp3");
  });

  it("recusa o que não é áudio conhecido", () => {
    expect(curatorAudioExtension("video/mp4")).toBeNull();
    expect(curatorAudioExtension("image/jpeg")).toBeNull();
    expect(curatorAudioExtension("")).toBeNull();
    expect(curatorAudioExtension("audio/flac")).toBeNull();
  });
});

describe("normalizeCuratorNote", () => {
  it("apara espaço, junta as linhas em parágrafos e devolve null para vazio", () => {
    expect(normalizeCuratorNote("  É um linho   que respira.  ")).toBe("É um linho que respira.");
    expect(normalizeCuratorNote("Primeira linha.\n\n\n  Segunda linha.  ")).toBe(
      "Primeira linha.\nSegunda linha.",
    );
    expect(normalizeCuratorNote("   ")).toBeNull();
    expect(normalizeCuratorNote(null)).toBeNull();
    expect(normalizeCuratorNote(undefined)).toBeNull();
  });

  it("corta no teto com reticências, sem cortar palavra no meio da frase", () => {
    const longo = normalizeCuratorNote("a".repeat(CURATOR_NOTE_MAX_CHARS + 50));
    expect(longo).toHaveLength(CURATOR_NOTE_MAX_CHARS);
    expect(longo?.endsWith("…")).toBe(true);
    // No teto exato, nada muda.
    const exato = "b".repeat(CURATOR_NOTE_MAX_CHARS);
    expect(normalizeCuratorNote(exato)).toBe(exato);
  });
});

describe("curatorAudioStoragePath / formatAudioSeconds", () => {
  it("o caminho é por peça e por gravação", () => {
    expect(curatorAudioStoragePath("p1", "tok", "webm")).toBe(
      "products/p1/nota-curadora-tok.webm",
    );
  });

  it("o relógio do player é minuto:segundo", () => {
    expect(formatAudioSeconds(0)).toBe("0:00");
    expect(formatAudioSeconds(9)).toBe("0:09");
    expect(formatAudioSeconds(47)).toBe("0:47");
    expect(formatAudioSeconds(CURATOR_AUDIO_MAX_SECONDS)).toBe("1:00");
    expect(formatAudioSeconds(-5)).toBe("0:00");
  });

  it("os limites são os que a tela promete", () => {
    expect(CURATOR_AUDIO_MAX_SECONDS).toBe(60);
    expect(CURATOR_AUDIO_MAX_BYTES).toBe(3 * 1024 * 1024);
  });
});
