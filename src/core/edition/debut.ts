// A carta de estreia — PURO. Quem compra pela primeira vez recebe, dentro da
// caixa, uma carta assinada pela dona. Aqui mora a regra do que é "primeira
// compra", a limpeza do texto da carta e o corpo da letra pelo tamanho.

/** Status que contam como compra de verdade (pedido pago em diante). */
export const COUNTED_STATUSES = ["paid", "preparing", "shipped", "delivered"] as const;
export type CountedStatus = (typeof COUNTED_STATUSES)[number];

export function isCountedStatus(status: string): status is CountedStatus {
  return (COUNTED_STATUSES as readonly string[]).includes(status);
}

/** Primeira compra = nenhum outro pedido pago desta cliente antes deste. */
export function isFirstPurchase(input: { priorCountedOrders: number }): boolean {
  return input.priorCountedOrders === 0;
}

/** Cabe em 15 × 10 cm com a assinatura: 12 linhas curtas ou ~900 caracteres. */
export const DEBUT_LETTER_MAX = 900;
export const DEBUT_LETTER_MAX_LINES = 12;
export const DEBUT_SIGNATURE_MAX = 60;

/**
 * Texto da carta como cabe no papel: só latino (o desenho não pode buscar
 * fonte pela rede), linhas vazias em sequência viram uma, no máximo 12
 * linhas e 900 caracteres. Vazio vira null = a carta está desligada.
 */
export function normalizeDebutLetter(value: string | null | undefined): string | null {
  const lines = (value ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) =>
      line
        .replace(/[^\p{Script=Latin}\p{N}\p{P}\p{Zs}]/gu, "")
        .replace(/\s{2,}/g, " ")
        .trim(),
    );
  const compact: string[] = [];
  for (const line of lines) {
    if (line === "" && (compact.length === 0 || compact[compact.length - 1] === "")) continue;
    compact.push(line);
  }
  while (compact.length > 0 && compact[compact.length - 1] === "") compact.pop();
  const text = compact.slice(0, DEBUT_LETTER_MAX_LINES).join("\n").slice(0, DEBUT_LETTER_MAX).trim();
  return text !== "" && /[\p{L}\p{N}]/u.test(text) ? text : null;
}

/** Assinatura numa linha só, sem emoji; vazio = "A curadora". */
export function normalizeDebutSignature(value: string | null | undefined): string {
  const clean = (value ?? "")
    .replace(/\s+/g, " ")
    .replace(/[^\p{Script=Latin}\p{N}\p{P}\p{Zs}]/gu, "")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, DEBUT_SIGNATURE_MAX);
  return clean !== "" ? clean : "A curadora";
}

/** "PARA ANA" — o primeiro nome da cliente, em caixa alta na faixa. */
export function debutFirstName(fullName: string | null | undefined): string {
  const first = (fullName ?? "").trim().split(/\s+/)[0] ?? "";
  return first ? first.charAt(0).toUpperCase() + first.slice(1).toLowerCase() : "você";
}

/** A carta desce de corpo conforme cresce: 12 linhas cabem em 15 × 10 cm. */
export function debutLetterFontSize(text: string): number {
  const length = text.length;
  const lines = text.split("\n").length;
  if (length <= 160 && lines <= 3) return 40;
  if (length <= 320 && lines <= 6) return 34;
  if (length <= 560 && lines <= 9) return 29;
  return 25;
}

/** Ordem de impressão: a carta primeiro, depois um cartão por peça. */
export function editionPrintSet<T>(input: { letter: T | null; cards: readonly T[] }): T[] {
  return input.letter ? [input.letter, ...input.cards] : [...input.cards];
}
