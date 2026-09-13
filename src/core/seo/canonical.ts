// URL canônica da coleção — PURO. A sala é uma página de verdade
// (/produtos?categoria=slug); a busca (?q=) nunca vira página indexável:
// canonical em /produtos e noindex, para o Google não duplicar a coleção.

export type CollectionCanonical = {
  canonical: string;
  noindex: boolean;
};

export function collectionCanonical(input: {
  categoria?: string | null;
  q?: string | null;
  /** Chip de uma Edição de Belém: a página canônica é /belem/<slug>. */
  edicao?: string | null;
}): CollectionCanonical {
  const q = (input.q ?? "").trim();
  const categoria = (input.categoria ?? "").trim();
  const edicao = (input.edicao ?? "").trim();
  if (q !== "") return { canonical: "/produtos", noindex: true };
  if (edicao !== "") return { canonical: `/belem/${encodeURIComponent(edicao)}`, noindex: true };
  if (categoria !== "") {
    return { canonical: `/produtos?categoria=${encodeURIComponent(categoria)}`, noindex: false };
  }
  return { canonical: "/produtos", noindex: false };
}
