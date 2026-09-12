// A carta de estreia — PURO. Quem compra pela primeira vez recebe, dentro da
// caixa, uma carta assinada pela dona. Aqui mora a regra do que é "primeira
// compra", a limpeza do texto da carta, o orçamento do papel (15 × 10 cm) e
// o corpo da letra que faz a carta caber nele.

import { estimateLines } from "@/core/edition/layout";
import { textWidthUnits } from "@/core/edition/text";
import { normalizeReceiptText } from "@/core/receipts/types";

/**
 * Status que contam como compra de verdade: pedido pago em diante. Um
 * pedido reembolsado depois de entregue também conta — a cliente já abriu
 * uma caixa (e já recebeu a carta); a troca não é uma nova estreia.
 */
export const COUNTED_STATUSES = ["paid", "preparing", "shipped", "delivered", "refunded"] as const;
export type CountedStatus = (typeof COUNTED_STATUSES)[number];

export function isCountedStatus(status: string): status is CountedStatus {
  return (COUNTED_STATUSES as readonly string[]).includes(status);
}

/**
 * Primeira compra = nenhum outro pedido pago desta cliente ANTES deste (pela
 * ordem de pagamento, não de criação: um Pix antigo pago depois não rouba a
 * estreia de quem já foi embalado). Presente não é estreia: a caixa vai para
 * outra pessoa, e a carta esperaria a primeira compra para ela mesma.
 */
export function isFirstPurchase(input: { priorCountedOrders: number; isGift: boolean }): boolean {
  return !input.isGift && input.priorCountedOrders === 0;
}

/** Cabe em 15 × 10 cm com a assinatura: 12 linhas curtas ou ~900 caracteres. */
export const DEBUT_LETTER_MAX = 900;
export const DEBUT_LETTER_MAX_LINES = 12;
/** A assinatura: uma linha, em unidades de largura (serifa). */
export const DEBUT_SIGNATURE_MAX = 60;

/**
 * Texto da carta como cabe no papel: a mesma limpeza do cartão (só o que as
 * fontes têm, NFC, aspas e traços tipográficos), linhas vazias em sequência
 * viram uma, sem linhas vazias nas pontas. Vazio vira null = a carta está
 * desligada. Os tetos (linhas, caracteres, altura) são conferidos ao salvar
 * por `debutLetterLayout`, para a dona ver na hora o que não cabe.
 */
export function normalizeDebutLetter(value: string | null | undefined): string | null {
  const lines = (value ?? "").replace(/\r\n?/g, "\n").split("\n").map(normalizeReceiptText);
  const compact: string[] = [];
  for (const line of lines) {
    if (line === "" && (compact.length === 0 || compact[compact.length - 1] === "")) continue;
    compact.push(line);
  }
  while (compact.length > 0 && compact[compact.length - 1] === "") compact.pop();
  const text = compact.join("\n").trim();
  return text !== "" && /[\p{L}\p{N}]/u.test(text) ? text : null;
}

/** Assinatura numa linha só, sem emoji, no teto de largura; vazio = "A curadora". */
export function normalizeDebutSignature(value: string | null | undefined): string {
  const clean = normalizeReceiptText((value ?? "").replace(/\s+/g, " "));
  if (clean === "" || !/[\p{L}\p{N}]/u.test(clean)) return "A curadora";
  if (textWidthUnits(clean, "serif") <= DEBUT_SIGNATURE_MAX) return clean;
  let out = "";
  for (const char of clean) {
    if (textWidthUnits(out + char, "serif") > DEBUT_SIGNATURE_MAX) break;
    out += char;
  }
  return out.replace(/[\s,;:.!?…-]+$/u, "");
}

/** "Maria Eduarda" → "Maria"; "D'ÁVILA" → "D'Ávila"; "🌸 Ana" → "Ana"; sem nome, "você". */
export function debutFirstName(fullName: string | null | undefined): string {
  const first = (fullName ?? "")
    .trim()
    .split(/\s+/)
    .find((token) => /\p{L}/u.test(token));
  if (!first) return "você";
  return first
    .toLowerCase()
    .replace(/(^|['’-])(\p{L})/gu, (_match, sep: string, letter: string) => `${sep}${letter.toUpperCase()}`);
}

/** O papel da carta (px numa imagem 1080×720 ≈ 15×10 cm a ~183 dpi). */
export const DEBUT_LETTER_GEOMETRY = {
  width: 1080,
  height: 720,
  /** Miolo entre as molduras: 1080 − 2×(28 + 1 + 6 + 1 + 64). */
  contentWidth: 880,
  /** O que sobra para as linhas da carta depois da faixa, do "PARA", da assinatura e da faixa noir. */
  linesHeight: 396,
  sizes: [40, 34, 29, 25, 22] as const,
  lineHeight: 1.22,
  /** Uma linha em branco (um respiro entre parágrafos) vale 0,45 linha. */
  blankLine: 0.45,
} as const;

export type DebutLetterLayout = {
  fontSize: number;
  /** Linhas desenhadas (com as quebras que a largura impõe), no corpo escolhido. */
  lines: number;
  /** A carta cabe no papel neste corpo. */
  fits: boolean;
};

/** Linhas que um parágrafo ocupa no papel, num corpo. */
function paragraphLines(paragraph: string, fontSize: number): number {
  if (paragraph === "") return DEBUT_LETTER_GEOMETRY.blankLine;
  return estimateLines(paragraph, "serif", fontSize, DEBUT_LETTER_GEOMETRY.contentWidth);
}

/**
 * O corpo da letra: o maior em que a carta inteira, com as quebras de
 * linha que a largura do papel impõe, cabe na altura reservada. Se nem o
 * menor serve, `fits` é false — a tela recusa a carta ao salvar.
 */
export function debutLetterLayout(text: string): DebutLetterLayout {
  const g = DEBUT_LETTER_GEOMETRY;
  const paragraphs = text.split("\n");
  let last: DebutLetterLayout = { fontSize: g.sizes[g.sizes.length - 1], lines: 0, fits: false };
  for (const fontSize of g.sizes) {
    const lines = paragraphs.reduce((sum, paragraph) => sum + paragraphLines(paragraph, fontSize), 0);
    const height = lines * fontSize * g.lineHeight;
    last = { fontSize, lines, fits: height <= g.linesHeight };
    if (last.fits) return last;
  }
  return last;
}

/** O corpo da letra da carta (o do orçamento; o menor quando nem ele cabe). */
export function debutLetterFontSize(text: string): number {
  return debutLetterLayout(text).fontSize;
}

/**
 * Por que a carta não cabe, para a tela: linhas, caracteres ou altura. Null
 * quando cabe.
 */
export function debutLetterProblem(text: string | null): string | null {
  if (text === null) return null;
  const lines = text.split("\n").length;
  if (lines > DEBUT_LETTER_MAX_LINES) {
    return `A carta tem ${lines} linhas e o papel comporta ${DEBUT_LETTER_MAX_LINES}: junte ou tire ${lines - DEBUT_LETTER_MAX_LINES}.`;
  }
  if (text.length > DEBUT_LETTER_MAX) {
    return `A carta tem ${text.length} caracteres e o papel comporta ${DEBUT_LETTER_MAX}: encurte ${text.length - DEBUT_LETTER_MAX}.`;
  }
  const layout = debutLetterLayout(text);
  if (!layout.fits) {
    return `A carta não cabe no papel de 15 × 10 cm nem na letra menor (${layout.lines} linhas desenhadas): encurte o texto ou junte parágrafos.`;
  }
  return null;
}

/** Ordem de impressão: a carta primeiro, depois um cartão por peça. */
export function editionPrintSet<T>(input: { letter: T | null; cards: readonly T[] }): T[] {
  return input.letter ? [input.letter, ...input.cards] : [...input.cards];
}
