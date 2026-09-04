// Acabamento da resposta do bot antes de ir ao WhatsApp — PURO.
//
// O modelo às vezes escreve "menu" ou "cardápio" (vocabulário de restaurante
// que ele traz de fábrica) onde a loja diz "catálogo". A regra está no
// prompt, mas a última palavra é do código: a troca aqui garante que a
// cliente nunca lê a palavra errada, mesmo num dia ruim do modelo.

const VOCABULARY: ReadonlyArray<[RegExp, string]> = [
  [/\bmenus\b/giu, "catálogos"],
  [/\bmenu\b/giu, "catálogo"],
  [/\bcard[áa]pios\b/giu, "catálogos"],
  [/\bcard[áa]pio\b/giu, "catálogo"],
];

/** Preserva a caixa da palavra original: "Menu" → "Catálogo", "MENU" → "CATÁLOGO". */
function matchCase(original: string, replacement: string): string {
  if (original === original.toUpperCase() && original.length > 1) {
    return replacement.toUpperCase();
  }
  if (original[0] === original[0]?.toUpperCase()) {
    return replacement[0].toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

export function fixVocabulary(text: string): string {
  let out = text;
  for (const [pattern, replacement] of VOCABULARY) {
    out = out.replace(pattern, (match) => matchCase(match, replacement));
  }
  return out;
}

/** Vocabulário da casa + respiro: nunca mais de uma linha em branco seguida. */
export function polishBotReply(text: string): string {
  return fixVocabulary(text)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export const MAX_BUBBLES = 3;

/**
 * Divide a resposta em até 3 balões quando o modelo separou blocos com uma
 * linha contendo só "---". Mais de 3 blocos: o excedente é colado ao último
 * (a cliente nunca perde texto). Sem separador, um balão só.
 */
export function splitBotReply(text: string): string[] {
  const partes = polishBotReply(text)
    .split(/\n[ \t]*-{3,}[ \t]*\n/)
    .map((parte) => parte.trim())
    .filter((parte) => parte !== "");
  if (partes.length === 0) return [];
  if (partes.length <= MAX_BUBBLES) return partes;
  return [
    ...partes.slice(0, MAX_BUBBLES - 1),
    partes.slice(MAX_BUBBLES - 1).join("\n\n"),
  ];
}
