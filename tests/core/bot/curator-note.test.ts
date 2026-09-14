// A nota da curadora no texto da Lia (PURO): entre aspas angulares para ela
// citar, num teto curto, com o aviso do áudio (e o link da página quando ela
// está aberta) — e nada quando a peça não tem.
import { describe, expect, it } from "vitest";

import { CURATOR_NOTE_BOT_MAX, curatorNoteLines } from "@/core/bot/curator-note";

const URL = "https://trivemaison.com.br/produto/longo-dunas";

describe("curatorNoteLines", () => {
  it("nota em texto vira uma linha citável; parágrafos numa linha só", () => {
    expect(curatorNoteLines({ note: "Escolhi pelo caimento no calor.\n\nVai bem de dia e de noite.", hasAudio: false, pageUrl: URL })).toEqual([
      "Nota da curadora (cite com as palavras dela): «Escolhi pelo caimento no calor. Vai bem de dia e de noite.»",
    ]);
  });

  it("com áudio, diz onde ouvir, com o link quando a página está aberta; só áudio convida a ouvir por ele", () => {
    expect(curatorNoteLines({ note: "Linho puro.", hasAudio: true, pageUrl: URL })).toEqual([
      "Nota da curadora (cite com as palavras dela): «Linho puro.»",
      `A nota também está em áudio, na voz da curadora, na página da peça (${URL}).`,
    ]);
    expect(curatorNoteLines({ note: null, hasAudio: true, pageUrl: URL })).toEqual([
      `A curadora deixou uma nota em áudio na página da peça (${URL}), sem transcrição: convide a cliente a ouvir por esse link.`,
    ]);
    // Janela VIP (página ainda fechada ao público): sem link, e sem prometer um.
    expect(curatorNoteLines({ note: null, hasAudio: true, pageUrl: null })[0]).toContain("não prometa o link");
    expect(curatorNoteLines({ note: "Linho puro.", hasAudio: true, pageUrl: null })[1]).toBe(
      "A nota também está em áudio, na voz da curadora, na página da peça.",
    );
  });

  it("com o envio de áudio ligado, a linha aponta para enviar_nota_da_curadora em vez do link", () => {
    const withNote = curatorNoteLines({ note: "Linho puro.", hasAudio: true, pageUrl: URL, audioEnabled: true });
    expect(withNote).toHaveLength(2);
    expect(withNote[1]).toContain("enviar_nota_da_curadora");
    expect(withNote[1]).not.toContain(URL);
    const onlyAudio = curatorNoteLines({ note: null, hasAudio: true, pageUrl: null, audioEnabled: true });
    expect(onlyAudio).toEqual([
      "A curadora deixou uma nota em áudio, sem transcrição: se ela perguntar de tecido, caimento ou calor, chame enviar_nota_da_curadora — a voz chega no WhatsApp dela.",
    ]);
    // Ligado mas sem áudio: nada muda.
    expect(curatorNoteLines({ note: "Linho puro.", hasAudio: false, pageUrl: URL, audioEnabled: true })).toHaveLength(1);
  });

  it("sem nota e sem áudio, nada; nota vazia ou só emoji também é nada", () => {
    expect(curatorNoteLines({ note: null, hasAudio: false, pageUrl: URL })).toEqual([]);
    expect(curatorNoteLines({ note: "   ", hasAudio: false, pageUrl: URL })).toEqual([]);
    expect(curatorNoteLines({ note: "🌞🌞", hasAudio: false, pageUrl: URL })).toEqual([]);
  });

  it("nota longa é cortada na palavra, com reticências, sem partir emoji", () => {
    const longa = Array.from({ length: 200 }, () => "palavra 🌞").join(" ");
    const [line] = curatorNoteLines({ note: longa, hasAudio: false, pageUrl: null });
    const inside = line.slice(line.indexOf("«") + 1, line.lastIndexOf("»"));
    expect(Array.from(inside).length).toBeLessThanOrEqual(CURATOR_NOTE_BOT_MAX + 1);
    expect(inside.endsWith("…")).toBe(true);
    // Nenhum par substituto solto (metade de um emoji) em lugar nenhum.
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    expect(inside).not.toMatch(lone);
    expect(inside).toMatch(/(palavra|🌞)…$/u);
    // Só emoji depois de uma letra, além do teto: o corte cai entre emojis inteiros.
    const [emojiLine] = curatorNoteLines({ note: `a ${"🌞".repeat(CURATOR_NOTE_BOT_MAX + 5)}`, hasAudio: false, pageUrl: null });
    expect(emojiLine).not.toMatch(lone);
  });
});
