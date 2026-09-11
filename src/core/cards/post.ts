// A legenda do post da peça — PURA. O que a dona cola no Instagram: duas
// linhas no tom da maison, as hashtags de Belém e o link da peça no fim.
// Sem IA: template estável, do mesmo jeito toda vez (o post é dela, não do
// modelo).

const MAX_CAPTION = 2200;

/** Hashtags fixas da praça — ordem estável, sem repetição. */
export const BELEM_HASHTAGS = [
  "#Belém",
  "#ModaBelém",
  "#BelémPA",
  "#ModaFemininaBelém",
  "#LojaDeBelém",
] as const;

/** "Edição Círio" → "#EdiçãoCírio"; vazio → nada. */
export function hashtagFrom(text: string): string | null {
  const words = text
    .trim()
    .split(/\s+/)
    .map((word) => word.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter((word) => word !== "");
  if (words.length === 0) return null;
  return `#${words.map((word) => word[0].toUpperCase() + word.slice(1)).join("")}`;
}

/** Linha pequena da faixa noir: a edição em caixa alta, ou a assinatura da casa. */
export function postEyebrow(editionName: string | null | undefined): string {
  const edition = (editionName ?? "").trim();
  return edition !== "" ? edition.toUpperCase().slice(0, 40) : "NOITE DE ESTREIA";
}

export type PostCaptionInput = {
  name: string;
  /** "R$ 289,00" ou "a partir de R$ 189,00". */
  priceLabel: string;
  categoryName: string | null;
  editionName: string | null;
  storeName: string;
  productUrl: string;
};

/**
 * Legenda pronta: peça, preço, convite, hashtags e link. O link entra SEMPRE
 * no fim — se a legenda passar do limite do Instagram, o que se corta são as
 * hashtags, nunca o endereço da peça.
 */
export function buildPostCaption(input: PostCaptionInput): string {
  const name = input.name.trim();
  const category = (input.categoryName ?? "").trim();
  const edition = (input.editionName ?? "").trim();

  const abertura = edition !== "" ? `${name} — ${edition}.` : `${name}.`;
  const segunda =
    category !== ""
      ? `${category} para o calor de Belém, ${input.priceLabel}.`
      : `Para o calor de Belém, ${input.priceLabel}.`;
  const convite = "Toque no link para ver a peça inteira e falar com a gente.";

  const tags = [
    ...BELEM_HASHTAGS,
    hashtagFrom(input.storeName),
    edition !== "" ? hashtagFrom(edition) : null,
  ].filter((tag): tag is string => tag !== null);
  const unique = [...new Set(tags)];

  const fim = input.productUrl.trim();
  const cabeca = [abertura, segunda, convite].join("\n");
  let caption = [cabeca, unique.join(" "), fim].join("\n\n");

  while (caption.length > MAX_CAPTION && unique.length > 0) {
    unique.pop();
    caption = [cabeca, unique.join(" "), fim].join("\n\n");
  }
  if (caption.length > MAX_CAPTION) {
    // Sem hashtags ainda passou (nome gigante): corta a cabeça, guarda o link.
    const espaco = MAX_CAPTION - fim.length - 2;
    caption = [cabeca.slice(0, Math.max(0, espaco)).trimEnd(), fim].join("\n\n");
  }
  return caption;
}

export const POST_CAPTION_MAX = MAX_CAPTION;
