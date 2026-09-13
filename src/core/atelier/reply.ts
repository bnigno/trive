// O que a dona lê de volta — PURO. As variáveis do template
// owner_atelier_draft ("Rascunho pronto · Longo Dunas · 3 fotos") e os
// motivos do owner_atelier_help (quando o envio não deu para cadastrar).

export function photosLabel(count: number): string {
  return count === 1 ? "1 foto" : `${count} fotos`;
}

export type AtelierDraftVars = { peca: string; fotos: string; link: string };

export function atelierDraftVars(input: { name: string; photos: number; link: string }): AtelierDraftVars {
  return { peca: input.name, fotos: photosLabel(input.photos), link: input.link };
}

export const ATELIER_HELP_REASONS = {
  sem_fotos: "Não achei fotos suas dos últimos 15 minutos — mande as fotos e repita o recado.",
  documento: "Essa veio como documento: mande pela galeria, como foto.",
  audio_sem_transcricao: "Não consigo ouvir áudio por aqui agora — mande o recado por texto.",
  fotos_indisponiveis: "As fotos já não estão mais disponíveis no WhatsApp — mande de novo, por favor.",
  erro: "Deu erro ao montar o rascunho; cadastre pelo painel ou mande de novo mais tarde.",
} as const;

export type AtelierHelpReason = keyof typeof ATELIER_HELP_REASONS;

export function atelierHelpReasonText(reason: AtelierHelpReason): string {
  return ATELIER_HELP_REASONS[reason];
}

export function isAtelierHelpReason(value: unknown): value is AtelierHelpReason {
  return typeof value === "string" && value in ATELIER_HELP_REASONS;
}
