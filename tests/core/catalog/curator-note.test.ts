// A nota da curadora (PURO): formatos de áudio aceitos, limpeza do texto,
// caminho do arquivo e o relógio do player.
import { describe, expect, it } from "vitest";

import {
  CURATOR_AUDIO_CANONICAL_MIMES,
  CURATOR_AUDIO_MAX_BYTES,
  CURATOR_AUDIO_MAX_SECONDS,
  CURATOR_NOTE_MAX_CHARS,
  curatorAudioExtension,
  curatorAudioFormat,
  curatorAudioStoragePath,
  fitCuratorNote,
  formatAudioSeconds,
  normalizeCuratorNote,
  resolveCuratorAudioFormat,
} from "@/core/catalog/curator-note";

describe("curatorAudioFormat / curatorAudioExtension", () => {
  it("aceita o que os navegadores gravam, com ou sem codecs no mime, e devolve o mime canônico", () => {
    expect(curatorAudioFormat("audio/webm;codecs=opus")).toEqual({ mime: "audio/webm", extension: "webm" });
    expect(curatorAudioExtension("audio/webm")).toBe("webm");
    // iPhone e os apelidos do AAC.
    expect(curatorAudioFormat("audio/mp4")).toEqual({ mime: "audio/mp4", extension: "m4a" });
    expect(curatorAudioFormat("audio/x-m4a")?.mime).toBe("audio/mp4");
    expect(curatorAudioFormat("audio/m4a")?.mime).toBe("audio/mp4");
    expect(curatorAudioFormat("audio/aac")?.mime).toBe("audio/mp4");
    expect(curatorAudioFormat("AUDIO/OGG; codecs=opus")).toEqual({ mime: "audio/ogg", extension: "ogg" });
    expect(curatorAudioFormat("audio/mp3")?.mime).toBe("audio/mpeg");
    expect(curatorAudioExtension("audio/mpeg")).toBe("mp3");
  });

  it("todo mime canônico está na lista que o bucket precisa aceitar (o Supabase compara por igualdade)", () => {
    for (const mime of ["audio/webm;codecs=opus", "audio/x-m4a", "audio/aac", "audio/mp3", "audio/opus"]) {
      const format = curatorAudioFormat(mime)!;
      expect(CURATOR_AUDIO_CANONICAL_MIMES).toContain(format.mime);
      expect(format.mime).not.toContain(";");
    }
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

  it("corta no teto com reticências, na última palavra inteira", () => {
    // Palavras de 6 letras + espaço: o corte cai no meio de uma delas e volta para a anterior.
    const fala = Array.from({ length: 200 }, () => "linhos").join(" ");
    const longo = normalizeCuratorNote(fala)!;
    expect(longo.length).toBeLessThanOrEqual(CURATOR_NOTE_MAX_CHARS);
    expect(longo.endsWith("linhos…")).toBe(true);
    expect(longo).not.toMatch(/linho…$/);
    // Pontuação pendurada antes das reticências some ("respira,…" não).
    const virgula = normalizeCuratorNote(Array.from({ length: 200 }, () => "respira,").join(" "))!;
    expect(virgula.endsWith("respira…")).toBe(true);
    // Sem espaço nenhum (não é fala): corta onde dá, dentro do teto.
    const semEspaco = normalizeCuratorNote("a".repeat(CURATOR_NOTE_MAX_CHARS + 50))!;
    expect(semEspaco).toHaveLength(CURATOR_NOTE_MAX_CHARS);
    // No teto exato, nada muda.
    const exato = "b".repeat(CURATOR_NOTE_MAX_CHARS);
    expect(normalizeCuratorNote(exato)).toBe(exato);
  });

  it("silêncio e ruído (só pontuação) não viram nota", () => {
    expect(normalizeCuratorNote("...")).toBeNull();
    expect(normalizeCuratorNote(" . , ! ")).toBeNull();
    expect(normalizeCuratorNote("… hum.")).toBe("… hum.");
  });
});

describe("resolveCuratorAudioFormat", () => {
  it("usa o mime do navegador; sem mime útil, a extensão do nome; senão, recusa", () => {
    expect(resolveCuratorAudioFormat("audio/webm;codecs=opus", "nota.webm")?.mime).toBe("audio/webm");
    expect(resolveCuratorAudioFormat("", "Gravação 3.m4a")).toEqual({ mime: "audio/mp4", extension: "m4a" });
    expect(resolveCuratorAudioFormat("", "nota.MP3")?.mime).toBe("audio/mpeg");
    expect(resolveCuratorAudioFormat("application/octet-stream", "nota.ogg")?.mime).toBe("audio/ogg");
    expect(resolveCuratorAudioFormat("", "foto.jpg")).toBeNull();
    expect(resolveCuratorAudioFormat("image/png", "nota.png")).toBeNull();
  });
});

describe("fitCuratorNote", () => {
  it("avisa quando cortou e não corta emoji ao meio", () => {
    expect(fitCuratorNote("Linho puro.")).toEqual({ text: "Linho puro.", truncated: false });
    const longa = fitCuratorNote(Array.from({ length: 300 }, () => "linhos").join(" "));
    expect(longa.truncated).toBe(true);
    expect(longa.text!.endsWith("linhos…")).toBe(true);
    // Emoji exatamente na fronteira do corte (sem espaço para voltar): não pode ficar pela metade.
    const emoji = fitCuratorNote(`${"x".repeat(CURATOR_NOTE_MAX_CHARS - 2)}😀${"y".repeat(50)}`);
    expect(emoji.truncated).toBe(true);
    expect(emoji.text!.isWellFormed()).toBe(true);
    expect(Array.from(emoji.text!).length).toBeLessThanOrEqual(CURATOR_NOTE_MAX_CHARS);
    expect(emoji.text!.endsWith("😀…")).toBe(true);
    expect(fitCuratorNote("...")).toEqual({ text: null, truncated: false });
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
