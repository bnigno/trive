// A nota da curadora no texto da Lia — PURO. Quando a cliente pergunta de
// tecido, caimento ou calor, a Lia responde com o que a curadora disse, em
// vez de "confiro com a equipe". Entra no detalhar_produto logo depois da
// descrição, num teto curto para não inflar o contexto a cada peça.

import { normalizeCuratorNote } from "@/core/catalog/curator-note";

/** O que da nota vai para o modelo: cabe numa resposta de WhatsApp. */
export const CURATOR_NOTE_BOT_MAX = 700;

/**
 * Linhas para o texto da ferramenta: a nota entre aspas angulares (a Lia
 * cita, não reescreve) e, com áudio, onde ouvir a curadora — com o link da
 * página quando ela está aberta ao público (na janela VIP, não). Sem nota e
 * sem áudio, nada — o prompt já diz o que fazer quando a peça não tem ficha.
 */
export function curatorNoteLines(input: { note: string | null | undefined; hasAudio: boolean; pageUrl: string | null }): string[] {
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
    const where = input.pageUrl ? `na página da peça (${input.pageUrl})` : "na página da peça";
    lines.push(
      note
        ? `A nota também está em áudio, na voz da curadora, ${where}.`
        : input.pageUrl
          ? `A curadora deixou uma nota em áudio ${where}, sem transcrição: convide a cliente a ouvir por esse link.`
          : "A curadora deixou uma nota em áudio na página da peça, sem transcrição; a página ainda não está aberta ao público, então não prometa o link.",
    );
  }
  return lines;
}
