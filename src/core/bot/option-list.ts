// Limites da lista interativa da Z-API, compartilhados por quem monta menu no
// bot (catálogo de produtos e variações de um produto). Estourar qualquer um
// deles faz o menu falhar EM SILÊNCIO — o cliente fica sem botão nenhum.

/** A Z-API aceita no máximo 10 linhas por lista. */
export const OPTION_LIST_MAX_OPTIONS = 10;

/** Título de cada linha: 24 caracteres. */
export const OPTION_TITLE_MAX_CHARS = 24;

/** Id de cada linha: 64 caracteres (schema Zod de sendMediaMessage). */
export const OPTION_ID_MAX_CHARS = 64;

export function truncateOptionTitle(name: string): string {
  return name.length <= OPTION_TITLE_MAX_CHARS
    ? name
    : `${name.slice(0, OPTION_TITLE_MAX_CHARS - 1).trimEnd()}…`;
}
