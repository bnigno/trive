// Acabamento da resposta do vendedor antes de sair pelo WhatsApp — PURO.
//
// Vocabulário da casa: o que o cliente vê é o CATÁLOGO da maison (nunca
// "menu" nem "cardápio", palavras de restaurante que o modelo pega das
// ferramentas e dos próprios hábitos). O prompt já pede isso; este filtro é a
// rede de segurança para a palavra errada nunca chegar ao cliente.

const VOCABULARY: ReadonlyArray<{ pattern: RegExp; singular: string; plural: string }> = [
  { pattern: /\b(cardápios?|cardapios?)\b/giu, singular: "catálogo", plural: "catálogos" },
  { pattern: /\b(menus?)\b/giu, singular: "catálogo", plural: "catálogos" },
];

function matchCase(source: string, replacement: string): string {
  if (source === source.toUpperCase() && source.length > 1) return replacement.toUpperCase();
  if (source[0] === source[0]?.toUpperCase()) {
    return replacement.charAt(0).toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

/** "menu" → "catálogo", "Cardápios" → "Catálogos", preservando a caixa. */
export function fixVocabulary(text: string): string {
  let out = text;
  for (const { pattern, singular, plural } of VOCABULARY) {
    out = out.replace(pattern, (word) => {
      const isPlural = /s$/iu.test(word);
      return matchCase(word, isPlural ? plural : singular);
    });
  }
  return out;
}

/**
 * Resposta pronta para o cliente: vocabulário da casa, sem linhas em branco
 * em excesso (o WhatsApp mostra cada uma) e sem espaços nas pontas.
 */
export function polishBotReply(text: string): string {
  return fixVocabulary(text)
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}
