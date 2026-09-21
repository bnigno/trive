// Tipo de peça: o que a cliente pede ("um corset", "vestidos") e a loja só
// tinha em duas categorias largas (Vestuário, Acessórios). Lista fixa em
// código — a Lia e o painel falam a mesma língua; sinônimos cobrem o jeito
// de a cliente e da dona escreverem (o plural dos sinônimos é derivado por
// pluralizePieceTerm; rótulo e plural são explícitos). PURO: sem I/O.
//
// Tipo novo = uma linha aqui (slug sem acento, rótulo, plural, sinônimos) +
// um caso em tests/core/catalog/piece-types.test.ts. Sem migração: a coluna
// products.piece_type é texto livre garantido por Zod no service. Depois,
// `scripts/sugerir-tipo-de-peca.ts` para as peças que ainda estão sem tipo.
// Um mesmo termo não pode pertencer a dois tipos — o teste de guarda acusa.

export const PIECE_TYPES = [
  { slug: "vestido", label: "Vestido", plural: "Vestidos", synonyms: ["longo", "midi", "curto"] },
  { slug: "blusa", label: "Blusa", plural: "Blusas", synonyms: ["bata", "regata", "camiseta", "t-shirt", "baby look", "baby-look"] },
  { slug: "cropped", label: "Cropped", plural: "Croppeds", synonyms: ["cropp"] },
  { slug: "top", label: "Top", plural: "Tops", synonyms: [] },
  { slug: "body", label: "Body", plural: "Bodies", synonyms: ["bodys"] },
  { slug: "corset", label: "Corset", plural: "Corsets", synonyms: ["corselet", "espartilho"] },
  { slug: "camisa", label: "Camisa", plural: "Camisas", synonyms: ["camisao", "chemise"] },
  { slug: "saia", label: "Saia", plural: "Saias", synonyms: [] },
  { slug: "calca", label: "Calça", plural: "Calças", synonyms: ["pantalona", "legging"] },
  { slug: "short", label: "Short", plural: "Shorts", synonyms: [] },
  { slug: "bermuda", label: "Bermuda", plural: "Bermudas", synonyms: [] },
  { slug: "macacao", label: "Macacão", plural: "Macacões", synonyms: ["macaquinho"] },
  { slug: "conjunto", label: "Conjunto", plural: "Conjuntos", synonyms: ["set"] },
  { slug: "kimono", label: "Kimono", plural: "Kimonos", synonyms: ["quimono"] },
  { slug: "casaco", label: "Casaco", plural: "Casacos", synonyms: ["jaqueta", "cardigan", "colete", "blazer"] },
  { slug: "bolsa", label: "Bolsa", plural: "Bolsas", synonyms: ["clutch", "necessaire"] },
  { slug: "cinto", label: "Cinto", plural: "Cintos", synonyms: [] },
  { slug: "brinco", label: "Brinco", plural: "Brincos", synonyms: ["argola"] },
  { slug: "colar", label: "Colar", plural: "Colares", synonyms: ["gargantilha", "choker"] },
  { slug: "pulseira", label: "Pulseira", plural: "Pulseiras", synonyms: ["bracelete"] },
  { slug: "relogio", label: "Relógio", plural: "Relógios", synonyms: [] },
  { slug: "oculos", label: "Óculos", plural: "Óculos", synonyms: [] },
  { slug: "chapeu", label: "Chapéu", plural: "Chapéus", synonyms: ["bone", "bucket"] },
  { slug: "lenco", label: "Lenço", plural: "Lenços", synonyms: ["bandana", "echarpe"] },
  { slug: "outro", label: "Outro", plural: "Outros", synonyms: [] },
] as const;

export type PieceType = (typeof PIECE_TYPES)[number]["slug"];

export const PIECE_TYPE_SLUGS = PIECE_TYPES.map((type) => type.slug) as [PieceType, ...PieceType[]];

/** Minúsculas, sem acento, sem pontas — a mesma régua para o que a cliente escreve e para o nome da peça. */
export function normalizePieceTerm(term: string): string {
  return term
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .trim();
}

/**
 * Plural de um sinônimo já normalizado, pelas regras simples do português e
 * dos estrangeirismos que a moda usa: bermuda → bermudas, camisao → camisoes,
 * clutch → clutches, cardigan → cardigans; o que termina em s/x/z não muda
 * (oculos). Não cobre exceções (-l → -is, -ao → -aes): para essas, escreva
 * o plural como sinônimo explícito.
 */
export function pluralizePieceTerm(term: string): string {
  const word = normalizePieceTerm(term);
  if (word === "") return word;
  if (word.endsWith("ao")) return `${word.slice(0, -2)}oes`;
  if (word.endsWith("m")) return `${word.slice(0, -1)}ns`;
  if (word.endsWith("ch") || word.endsWith("sh")) return `${word}es`;
  if (/[sxz]$/u.test(word)) return word;
  return `${word}s`;
}

/** Rótulo, plural, slug, sinônimos e o plural de cada sinônimo — normalizados, sem repetição, nesta ordem. */
function termsOf(type: (typeof PIECE_TYPES)[number]): string[] {
  const synonyms = [...type.synonyms].map((term) => normalizePieceTerm(term));
  return [...new Set([type.label, type.plural, type.slug].map((term) => normalizePieceTerm(term)).concat(synonyms, synonyms.map(pluralizePieceTerm)))];
}

const BY_TERM: ReadonlyMap<string, PieceType> = (() => {
  const map = new Map<string, PieceType>();
  for (const type of PIECE_TYPES) {
    for (const term of termsOf(type)) map.set(term, type.slug);
  }
  return map;
})();

/** Tudo o que pode aparecer no NOME de uma peça deste tipo: rótulo, plural, slug, sinônimos (e seus plurais) — a mesma régua de suggestPieceType. */
export function pieceTypeTerms(slug: PieceType): string[] {
  const type = PIECE_TYPES.find((entry) => entry.slug === slug);
  if (!type) return [slug];
  return termsOf(type);
}

export function pieceTypeLabel(slug: PieceType): string {
  return PIECE_TYPES.find((type) => type.slug === slug)?.label ?? slug;
}

export function pieceTypePlural(slug: PieceType): string {
  return PIECE_TYPES.find((type) => type.slug === slug)?.plural ?? slug;
}

/** "Vestidos", "corselet", "ÓCULOS" → o tipo; null quando o termo não é um tipo de peça. */
export function parsePieceType(term: string): PieceType | null {
  const normalized = normalizePieceTerm(term);
  if (normalized === "") return null;
  return BY_TERM.get(normalized) ?? null;
}

/**
 * Sugere o tipo pelo NOME da peça ("CORSET DOMINIQUE" → corset; "Longo Dunas"
 * → vestido; "CONJUNTO SAIA E TOP" → conjunto). Conjunto ganha de qualquer
 * outra palavra do nome; fora isso, vale o primeiro termo reconhecido. Nunca
 * sugere "outro" — isso é decisão da dona. Null quando nada bate ("Aurora").
 */
export function suggestPieceType(name: string): PieceType | null {
  const normalized = normalizePieceTerm(name);
  if (normalized === "") return null;
  const words = normalized.split(/[^a-z0-9-]+/u).filter((word) => word !== "");
  // Termos compostos ("baby look") antes das palavras soltas.
  const compound = [...BY_TERM.entries()].find(([term, slug]) => term.includes(" ") && slug !== "outro" && normalized.includes(term));
  const hits: PieceType[] = compound ? [compound[1]] : [];
  for (const word of words) {
    const hit = BY_TERM.get(word);
    if (hit && hit !== "outro" && !hits.includes(hit)) hits.push(hit);
  }
  if (hits.length === 0) return null;
  return hits.includes("conjunto") ? "conjunto" : hits[0];
}
