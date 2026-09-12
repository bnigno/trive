// A nota da curadora no texto da Lia — PURO. Quando a cliente pergunta de
// tecido, caimento ou calor, a Lia responde com o que a curadora disse, em
// vez de "confiro com a equipe". Entra no detalhar_produto logo depois da
// descrição, num teto curto para não inflar o contexto a cada peça.

import { normalizeCuratorNote } from "@/core/catalog/curator-note";

/** O que da nota vai para o modelo: cabe numa resposta de WhatsApp. */
export const CURATOR_NOTE_BOT_MAX = 700;

/**
 * Linhas para o texto da ferramenta: a nota entre aspas angulares (a Lia
 * cita, não reescreve) e, com áudio, o aviso de que a cliente pode ouvir a
 * curadora na página. Sem nota e sem áudio, nada — o prompt já diz o que
 * fazer quando a peça não tem ficha.
 */
export function curatorNoteLines(input: { note: string | null | undefined; hasAudio: boolean }): string[] {
  const note = normalizeCuratorNote(input.note);
  const lines: string[] = [];
  if (note) {
    // Parágrafos numa linha só; corte por pontos de código (emoji inteiro), na última palavra.
    const flat = note.replace(/\n+/g, " ");
    const chars = Array.from(flat);
    const fitted =
      chars.length > CURATOR_NOTE_BOT_MAX
        ? `${chars.slice(0, CURATOR_NOTE_BOT_MAX).join("").replace(/\s+\S*$/, "").replace(/[,;:.!?…-]+$/, "")}…`
        : flat;
    lines.push(`Nota da curadora (cite com as palavras dela): «${fitted}»`);
  }
  if (input.hasAudio) {
    lines.push(
      note
        ? "A nota também está em áudio, na voz da curadora, na página da peça."
        : "A curadora deixou uma nota em áudio na página da peça (sem transcrição): convide a cliente a ouvir pelo link.",
    );
  }
  return lines;
}
