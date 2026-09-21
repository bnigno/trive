// A linha de uma peça no resultado de listar_produtos: nome, tipo (ou
// categoria), preço, cores e tamanhos COM estoque e uma frase real da ficha
// — o que a Lia precisa para comentar 2 ou 3 peças com motivo, sem uma ida
// extra a detalhar_produto. PURO: quem busca os dados é services/bot/catalog.ts.

/** A frase da peça cabe numa linha; abaixo do mínimo ("diversos") não vira frase. */
export const BLURB_MAX_CHARS = 120;
export const BLURB_MIN_CHARS = 20;
/** Cores/tamanhos por linha antes do "e mais N". */
export const LINE_VALUES_MAX = 8;

export type CatalogLineInput = {
  name: string;
  /** Rótulo do tipo de peça ("Vestido"); null cai no nome da categoria. */
  typeLabel: string | null;
  categoryName: string | null;
  /** Preço já formatado ("R$ 289,00" ou "R$ 189,00 a R$ 459,00"). */
  price: string;
  available: boolean;
  colors: readonly string[];
  sizes: readonly string[];
  /** Descrição, "como veste" ou composição (o serviço já escolheu e cortou a 200). */
  blurbSource: string | null;
};

/**
 * Primeira frase do texto se couber em `max`; senão corte em palavra inteira
 * com "…". Null quando não há texto útil (menos de BLURB_MIN_CHARS).
 */
export function pieceBlurb(source: string | null, max = BLURB_MAX_CHARS): string | null {
  const text = (source ?? "").replace(/\s+/g, " ").trim();
  if (text.length < BLURB_MIN_CHARS) return null;
  const firstSentence = text.match(/^.+?[.!?](?=\s|$)/u)?.[0] ?? text;
  if (firstSentence.length <= max) return firstSentence;
  const cut = text.slice(0, max - 1);
  const atWord = cut.lastIndexOf(" ");
  const base = (atWord >= BLURB_MIN_CHARS ? cut.slice(0, atWord) : cut).replace(/[\s,;:—-]+$/u, "");
  return `${base}…`;
}

function limited(values: readonly string[]): string {
  if (values.length <= LINE_VALUES_MAX) return values.join(", ");
  return `${values.slice(0, LINE_VALUES_MAX).join(", ")} e mais ${values.length - LINE_VALUES_MAX}`;
}

/** `• Vestido Dunas · Vestido — R$ 289,00 · cores: Preto, Verde · tamanhos: P, M, G — "Linho leve…"`; partes vazias somem. */
export function formatCatalogLine(input: CatalogLineInput): string {
  const kind = input.typeLabel ?? input.categoryName;
  const parts = [`${input.name}${kind ? ` · ${kind}` : ""} — ${input.price}${input.available ? "" : " (esgotado)"}`];
  if (input.colors.length > 0) parts.push(`cores: ${limited(input.colors)}`);
  if (input.sizes.length > 0) parts.push(`tamanhos: ${limited(input.sizes)}`);
  const blurb = pieceBlurb(input.blurbSource);
  return `• ${parts.join(" · ")}${blurb ? ` — "${blurb}"` : ""}`;
}
