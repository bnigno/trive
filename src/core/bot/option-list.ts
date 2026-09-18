// Limites da lista interativa da Z-API, compartilhados por quem monta lista no
// bot (catálogo de produtos e variações de um produto). Estourar qualquer um
// deles faz o menu falhar EM SILÊNCIO — o cliente fica sem botão nenhum.

/** A Z-API aceita no máximo 10 linhas por lista. */
export const OPTION_LIST_MAX_OPTIONS = 10;

/** Título de cada linha: 24 caracteres. */
export const OPTION_TITLE_MAX_CHARS = 24;

/** Id de cada linha: 64 caracteres (schema Zod de sendMediaMessage). */
export const OPTION_ID_MAX_CHARS = 64;

/** Texto do botão que abre a lista: 20 caracteres (limite do WhatsApp). */
export const OPTION_BUTTON_MAX_CHARS = 20;

/**
 * O catálogo inteiro sai em várias listas de uma vez (10 por lista), até
 * este teto por chamada: 3 listas = 30 peças. Acima disso, a Lia sugere
 * filtrar ou pede as próximas páginas.
 */
export const CATALOG_MAX_LISTS_PER_CALL = 3;

/** Janela em que o mesmo catálogo (mesmos filtros) não é reenviado inteiro: só a primeira lista. */
export const CATALOG_RESEND_GUARD_MS = 30 * 60 * 1000;

/** "Toque abaixo e veja o catálogo 👇 (11–20 de 25)"; sem a faixa quando tudo cabe numa lista. */
export function catalogListMessage(start: number, end: number, total: number): string {
  const base = "Toque abaixo e veja o catálogo 👇";
  return total <= OPTION_LIST_MAX_OPTIONS ? base : `${base} (${start}–${end} de ${total})`;
}

export function truncateOptionTitle(name: string): string {
  return name.length <= OPTION_TITLE_MAX_CHARS
    ? name
    : `${name.slice(0, OPTION_TITLE_MAX_CHARS - 1).trimEnd()}…`;
}
