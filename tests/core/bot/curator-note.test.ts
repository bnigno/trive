// A nota da curadora no texto da Lia (PURO): entre aspas angulares para ela
// citar, num teto curto, com o aviso do áudio — e nada quando a peça não tem.
import { describe, expect, it } from "vitest";

import { CURATOR_NOTE_BOT_MAX, curatorNoteLines } from "@/core/bot/curator-note";

describe("curatorNoteLines", () => {
  it("nota em texto vira uma linha citável; parágrafos numa linha só", () => {
    expect(curatorNoteLines({ note: "Escolhi pelo caimento no calor.\n\nVai bem de dia e de noite.", hasAudio: false })).toEqual([
      "Nota da curadora (cite com as palavras dela): «Escolhi pelo caimento no calor. Vai bem de dia e de noite.»",
    ]);
  });

  it("com áudio, diz onde ouvir; só áudio (sem transcrição) convida a ouvir pelo link", () => {
    expect(curatorNoteLines({ note: "Linho puro.", hasAudio: true })).toEqual([
      "Nota da curadora (cite com as palavras dela): «Linho puro.»",
      "A nota também está em áudio, na voz da curadora, na página da peça.",
    ]);
    expect(curatorNoteLines({ note: null, hasAudio: true })).toEqual([
      "A curadora deixou uma nota em áudio na página da peça (sem transcrição): convide a cliente a ouvir pelo link.",
    ]);
  });

  it("sem nota e sem áudio, nada; nota vazia ou só emoji também é nada", () => {
    expect(curatorNoteLines({ note: null, hasAudio: false })).toEqual([]);
    expect(curatorNoteLines({ note: "   ", hasAudio: false })).toEqual([]);
    expect(curatorNoteLines({ note: "🌞🌞", hasAudio: false })).toEqual([]);
  });

  it("nota longa é cortada na palavra, com reticências, sem partir emoji", () => {
    const longa = Array.from({ length: 200 }, () => "palavra 🌞").join(" ");
    const [line] = curatorNoteLines({ note: longa, hasAudio: false });
    const inside = line.slice(line.indexOf("«") + 1, line.lastIndexOf("»"));
    expect(Array.from(inside).length).toBeLessThanOrEqual(CURATOR_NOTE_BOT_MAX + 1);
    expect(inside.endsWith("…")).toBe(true);
    expect(inside).not.toContain("�");
    expect(inside).toMatch(/(palavra|🌞)…$/u);
  });
});
