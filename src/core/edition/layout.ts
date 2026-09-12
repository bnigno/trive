// O orçamento de altura do cartão da edição — PURO. Os tetos por texto
// (text.ts) garantem cada bloco; aqui a soma dos blocos fecha nos 1440 px:
// escolhe o corpo da frase e dos quadros (os elásticos) e, se ainda assim
// não couber, encurta a frase da curadora. As larguras vêm medidas nas
// fontes embutidas (Jost 0,504 em por unidade; Cormorant itálica 0,404).

import { fitEditionNote, textWidthUnits, type WidthFont } from "@/core/edition/text";

/** A geometria do desenho (px numa imagem 1080×1440 ≈ 9×12 cm a 300 dpi). */
export const EDITION_GEOMETRY = {
  width: 1080,
  height: 1440,
  /** Miolo entre as molduras: 1080 − 2×(30 + 1 + 6 + 2 + 56). */
  contentWidth: 890,
  /** Da faixa da edição ao pé da faixa noir: 1440 − 2×(30 + 1 + 6 + 2) − 40 de cima. */
  contentHeight: 1322,
  eyebrow: { size: 26, lineHeight: 1.2 },
  title: { sizes: [84, 68, 56, 46] as const, lineHeight: 1.08, maxLines: 2, marginTop: 22 },
  rule: { marginTop: 18, height: 2 },
  quote: { sizes: [44, 38, 36, 34] as const, lineHeight: 1.26, maxLines: 5, marginTop: 22, gap: 12 },
  byline: { size: 24, lineHeight: 1.2 },
  boxes: { marginTopWithQuote: 20, marginTopAlone: 32, gap: 36, paddingBottom: 16 },
  label: { size: 26, lineHeight: 1.2, gap: 8 },
  body: { sizes: [30, 28, 26] as const, lineHeight: 1.4, maxLines: 3 },
  footer: { paddingBottom: 20 },
  band: { lockupHeight: 98, padding: 14 },
} as const;

/** Advance médio por unidade de largura, em "em", medido nas fontes embutidas. */
const EM_PER_UNIT: Record<WidthFont, number> = { sans: 0.504, serif: 0.404 };
/** A quebra por palavra desperdiça o fim de cada linha: contamos com 90% da largura. */
const WRAP_SLACK = 0.9;

/** Linhas estimadas de um texto numa largura, num corpo e numa fonte. */
export function estimateLines(text: string, font: WidthFont, fontSize: number, width = EDITION_GEOMETRY.contentWidth): number {
  const unitsPerLine = (width * WRAP_SLACK) / (EM_PER_UNIT[font] * fontSize);
  return Math.max(1, Math.ceil(textWidthUnits(text, font) / unitsPerLine));
}

/** Capacidade em bytes por versão do QR em correção "M" (modo byte). */
const QR_BYTES_M = [0, 14, 26, 42, 62, 84, 106, 122, 152, 180, 213, 251, 287, 331, 362, 412, 450, 504, 560, 624, 666];

/** A versão (1–20) que um endereço pede em correção "M". */
export function qrVersionForText(text: string): number {
  const bytes = new TextEncoder().encode(text).length;
  const version = QR_BYTES_M.findIndex((capacity, index) => index > 0 && bytes <= capacity);
  return version === -1 ? QR_BYTES_M.length - 1 : version;
}

/**
 * O lado do QR em px: cada módulo com ≥ 5 px (≈ 0,42 mm impresso, o que um
 * celular lê a um palmo) contando a zona de silêncio; nunca menor que 220
 * (≈ 1,8 cm) nem maior que 300.
 */
export function editionQrSize(qrUrl: string): number {
  const modules = 17 + 4 * qrVersionForText(qrUrl) + 2;
  return Math.min(300, Math.max(220, modules * 5));
}

/**
 * Os corpos e as linhas que o orçamento assumiu. O desenho trava cada bloco
 * nessas linhas: se a estimativa errar para menos, some a última linha do
 * bloco (inteira) — e nunca o rodapé.
 */
export type EditionLayout = {
  titleSize: number;
  titleLines: number;
  quoteSize: number;
  quoteLines: number;
  bodySize: number;
  wearLines: number;
  careLines: number;
  qrSize: number;
  /** Altura estimada dos blocos, para os testes. */
  estimatedHeight: number;
};

type LayoutInput = {
  title: string;
  curatorNote: string | null;
  wearNote: string;
  careNote: string;
  qrUrl: string;
};

type Sizes = { titleSize: number; quoteSize: number; bodySize: number; qrSize: number };

function linesOf(input: LayoutInput, sizes: Sizes): Pick<EditionLayout, "titleLines" | "quoteLines" | "wearLines" | "careLines"> {
  const g = EDITION_GEOMETRY;
  return {
    titleLines: Math.min(g.title.maxLines, estimateLines(input.title, "serif", sizes.titleSize)),
    quoteLines: input.curatorNote ? Math.min(g.quote.maxLines, estimateLines(`“${input.curatorNote}”`, "serif", sizes.quoteSize)) : 0,
    wearLines: Math.min(g.body.maxLines, estimateLines(input.wearNote, "sans", sizes.bodySize)),
    careLines: Math.min(g.body.maxLines, estimateLines(input.careNote, "sans", sizes.bodySize)),
  };
}

function estimateHeight(input: LayoutInput, sizes: Sizes): number {
  const g = EDITION_GEOMETRY;
  const lines = linesOf(input, sizes);
  let height = g.eyebrow.size * g.eyebrow.lineHeight;
  height += g.title.marginTop + lines.titleLines * sizes.titleSize * g.title.lineHeight;
  height += g.rule.marginTop + g.rule.height;
  if (input.curatorNote) {
    height += g.quote.marginTop + lines.quoteLines * sizes.quoteSize * g.quote.lineHeight + g.quote.gap + g.byline.size * g.byline.lineHeight;
  }
  height += input.curatorNote ? g.boxes.marginTopWithQuote : g.boxes.marginTopAlone;
  for (const bodyLines of [lines.wearLines, lines.careLines]) {
    height += g.label.size * g.label.lineHeight + g.label.gap + bodyLines * sizes.bodySize * g.body.lineHeight;
  }
  height += g.boxes.gap + g.boxes.paddingBottom;
  height += sizes.qrSize + g.footer.paddingBottom;
  height += g.band.lockupHeight + 2 * g.band.padding;
  return height;
}

/** O maior corpo em que o texto cabe nas linhas do bloco. */
function largestFitting(text: string, font: WidthFont, sizes: readonly number[], maxLines: number): number {
  for (const size of sizes) if (estimateLines(text, font, size) <= maxLines) return size;
  return sizes[sizes.length - 1];
}

/**
 * O título prefere MENOS linhas a corpo maior: "Cropped Íris em Suplex com
 * Recorte Lateral" sai numa linha a 46 px, não em duas a 84 px.
 */
function titleSizeFor(title: string): number {
  const g = EDITION_GEOMETRY;
  for (let lines = 1; lines <= g.title.maxLines; lines += 1) {
    for (const size of g.title.sizes) if (estimateLines(title, "serif", size) <= lines) return size;
  }
  return g.title.sizes[g.title.sizes.length - 1];
}

/**
 * Escolhe os corpos: título e quadros no maior corpo em que cabem nas suas
 * linhas; a frase idem; depois, enquanto a soma não couber, desce os
 * quadros, desce a frase e, por fim, encurta a frase (avisando).
 */
export function editionLayout(input: LayoutInput): EditionLayout & { curatorNote: string | null; curatorShortened: boolean } {
  const g = EDITION_GEOMETRY;
  const qrSize = editionQrSize(input.qrUrl);
  const titleSize = titleSizeFor(input.title);
  let bodySize = Math.min(
    largestFitting(input.wearNote, "sans", g.body.sizes, g.body.maxLines),
    largestFitting(input.careNote, "sans", g.body.sizes, g.body.maxLines),
  );
  let curatorNote = input.curatorNote;
  let quoteSize = curatorNote ? largestFitting(`“${curatorNote}”`, "serif", g.quote.sizes, g.quote.maxLines) : g.quote.sizes[0];
  let curatorShortened = false;

  const fits = () => estimateHeight({ ...input, curatorNote }, { titleSize, quoteSize, bodySize, qrSize }) <= g.contentHeight;
  const bodyLadder = [...g.body.sizes].filter((size) => size < bodySize);
  const quoteLadder = [...g.quote.sizes].filter((size) => size < quoteSize);
  while (!fits()) {
    if (bodyLadder.length > 0) {
      bodySize = bodyLadder.shift() as number;
    } else if (quoteLadder.length > 0) {
      quoteSize = quoteLadder.shift() as number;
    } else if (curatorNote) {
      // Um quarto a menos por vez, até caber: o corte cai no fim de uma frase quando dá.
      const target = Math.floor(textWidthUnits(curatorNote, "serif") * 0.75);
      const shorter = fitEditionNote(curatorNote, Math.max(40, target), { quotes: true });
      curatorShortened = true;
      if (shorter.text === null || shorter.text === curatorNote) {
        curatorNote = null;
        break;
      }
      curatorNote = shorter.text;
    } else {
      break;
    }
  }
  const sizes = { titleSize, quoteSize, bodySize, qrSize };
  const finalInput = { ...input, curatorNote };
  return {
    ...sizes,
    ...linesOf(finalInput, sizes),
    curatorNote,
    curatorShortened,
    estimatedHeight: estimateHeight(finalInput, sizes),
  };
}
