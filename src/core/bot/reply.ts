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

/**
 * Anotações internas que o modelo lê no histórico e nos resultados das
 * ferramentas — "[foto enviada ao cliente] …", "[lista tocável do catálogo
 * enviada ao cliente]", "[A foto da peça foi enviada ao cliente.]" — e que
 * ele às vezes copia na resposta (caso real em produção, 2026-09-11). Sai
 * qualquer bloco entre colchetes no começo de uma linha, e os marcadores
 * conhecidos em qualquer posição. Colchetes curtos no meio de uma frase
 * ("tamanho [M]") ficam.
 */
const KNOWN_MARKERS: ReadonlyArray<RegExp> = [
  /\[foto enviada ao cliente\]\s*/giu,
  /\s*\[sku:\s*[A-Za-z0-9._-]+\]/giu,
  /\[lista tocável do catálogo(?: \([^)]*\))? (?:enviada ao cliente|que NÃO chegou à cliente \(falhou\))\]\s*/giu,
  /\[mensagem enviada pela equipe da loja, não por você\]\s*/giu,
  /\[aviso automático[^\]]*\]\s*/giu,
  /\[áudio da cliente, transcrição automática\]\s*/giu,
];

export function stripInternalMarkers(text: string): string {
  let out = text;
  for (const pattern of KNOWN_MARKERS) out = out.replace(pattern, "");
  // Bloco entre colchetes que abre uma linha (≥ 12 caracteres, sem quebra).
  out = out.replace(/^[ \t]*\[[^\]\n]{12,}\][ \t]*\n?/gmu, "");
  return out;
}

/** Vocabulário da casa + sem anotações internas + respiro entre linhas. */
export function polishBotReply(text: string): string {
  return fixVocabulary(stripInternalMarkers(text))
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

// "Digitando…" antes de cada balão: a Z-API mostra o status por N segundos e
// só então entrega a mensagem. É sensação, não simulação — 1 s por ~40
// caracteres, curto no primeiro balão (ela já "pensou" enquanto o modelo
// rodava) e um pouco mais nos seguintes.
export const TYPING_CHARS_PER_SECOND = 40;
export const TYPING_FIRST_MAX_SECONDS = 2;
export const TYPING_NEXT_MAX_SECONDS = 3;
/** "Gravando áudio…" antes da nota da curadora. */
export const CURATOR_AUDIO_RECORDING_SECONDS = 3;

export function typingSecondsFor(text: string, position: "first" | "next"): number {
  const max = position === "first" ? TYPING_FIRST_MAX_SECONDS : TYPING_NEXT_MAX_SECONDS;
  const seconds = Math.ceil(text.trim().length / TYPING_CHARS_PER_SECOND);
  return Math.min(max, Math.max(1, seconds));
}
