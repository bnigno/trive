// Os cartões da edição e a carta de estreia na folha A4 — PURO. Decide em
// quais folhas cada imagem cai e onde: no papel fotográfico comum (tesoura)
// 4 cartões por folha e uma folha MISTA com a carta em cima e 2 cartões
// embaixo (poupa uma folha por primeira compra); na Silhouette 2 cartões por
// folha e a carta sozinha na sua folha — o layout misto não é simétrico na
// altura, e um DXF que o Studio importe invertido cortaria carta e cartão
// trocados. Só entra o que já tem imagem gerada.
import { PAGE_A4, silhouetteSafeArea } from "@/core/catalog/silhouette";
import { EDITION_CARD, EDITION_LETTER, gridPositions, PLAIN_SHEET_MARGIN_MM, printableArea, type AreaMm, type GridPosition } from "@/core/print/round-labels";
import type { PageMm } from "@/core/print/dxf";

export type EditionSheetFormat = "a4" | "silhouette";
export type EditionItemKind = "card" | "letter";

export interface EditionSheetItemInput {
  key: string;
  kind: EditionItemKind;
  /** Imagem publicada; null = ainda não gerada (fica fora da folha). */
  url: string | null;
  alt: string;
}

export interface PlacedEditionItem {
  key: string;
  kind: EditionItemKind;
  url: string;
  alt: string;
  /** Canto superior esquerdo da imagem na página, em mm. */
  xMm: number;
  yMm: number;
  widthMm: number;
  heightMm: number;
  /** Raio do corte na plotter (a base marfim ganha a sangria por cima). */
  cornerRadiusMm: number;
  bleedMm: number;
}

export interface EditionSheet {
  kind: "cards" | "letter" | "mixed";
  items: PlacedEditionItem[];
}

export interface EditionSheetLayout {
  format: EditionSheetFormat;
  /** Onde os cartões caem numa folha só de cartões (linha a linha). */
  cardPositions: GridPosition[];
  /** Onde a carta cai (a primeira célula da grade do adesivo da sacola). */
  letterPosition: GridPosition | null;
  /**
   * O corte da carta na plotter: a grade INTEIRA do adesivo da sacola (2
   * células, simétricas na altura) — o DXF sai byte a byte igual ao do
   * adesivo, o mesmo arquivo do Studio serve e um DXF importado invertido no
   * Y cai no mesmo lugar; a 2ª célula corta papel em branco.
   */
  letterCutPositions: GridPosition[];
  /** A4: os cartões da linha de baixo, que dividem a folha com a carta. */
  mixedCardPositions: GridPosition[];
}

/** As áreas e as posições fixas de cada formato (as mesmas regras do selo e do adesivo da sacola). */
export function editionSheetLayout(format: EditionSheetFormat, page: PageMm = PAGE_A4): EditionSheetLayout {
  const silhouette = format === "silhouette";
  const area: AreaMm = silhouette ? silhouetteSafeArea(page) : printableArea(page, PLAIN_SHEET_MARGIN_MM);
  // Na Silhouette a grade centra na ALTURA da página (DXF invertido no Y cai no lugar).
  const centerIn: AreaMm = silhouette ? { xMm: area.xMm, yMm: 0, widthMm: area.widthMm, heightMm: page.heightMm } : area;
  const cardPositions = gridPositions({
    cellWidthMm: EDITION_CARD.widthMm,
    cellHeightMm: EDITION_CARD.heightMm,
    gapMm: silhouette ? EDITION_CARD.silhouetteGapMm : EDITION_CARD.gapMm,
    area,
    centerIn,
  });
  const letterPositions = gridPositions({ cellWidthMm: EDITION_LETTER.widthMm, cellHeightMm: EDITION_LETTER.heightMm, gapMm: EDITION_LETTER.gapMm, area, centerIn });
  const lastRow = cardPositions.reduce((max, p) => Math.max(max, p.row), -1);
  return {
    format,
    cardPositions,
    letterPosition: letterPositions[0] ?? null,
    letterCutPositions: letterPositions,
    mixedCardPositions: silhouette ? [] : cardPositions.filter((p) => p.row === lastRow && lastRow > 0),
  };
}

function place(item: EditionSheetItemInput & { url: string }, position: GridPosition): PlacedEditionItem {
  const size = item.kind === "letter" ? EDITION_LETTER : EDITION_CARD;
  return {
    key: item.key,
    kind: item.kind,
    url: item.url,
    alt: item.alt,
    xMm: position.xMm,
    yMm: position.yMm,
    widthMm: size.widthMm,
    heightMm: size.heightMm,
    cornerRadiusMm: size.cornerRadiusMm,
    bleedMm: size.bleedMm,
  };
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * As folhas, na ordem de impressão: a carta primeiro (na mista, com os dois
 * primeiros cartões, no A4; sozinha na Silhouette), depois os cartões
 * restantes de 4 em 4 (A4) ou 2 em 2 (Silhouette), na ordem das peças.
 * Itens sem imagem ficam de fora — a tela já pede "gere de novo".
 */
export function planEditionSheets(input: { letter: EditionSheetItemInput | null; cards: readonly EditionSheetItemInput[]; format: EditionSheetFormat; page?: PageMm }): EditionSheet[] {
  const layout = editionSheetLayout(input.format, input.page);
  const hasUrl = (item: EditionSheetItemInput): item is EditionSheetItemInput & { url: string } => item.url !== null;
  const letter = input.letter && hasUrl(input.letter) ? input.letter : null;
  const cards = input.cards.filter(hasUrl);
  const sheets: EditionSheet[] = [];
  let rest = cards;

  if (letter && layout.letterPosition) {
    const onMixed = layout.mixedCardPositions.length > 0 ? rest.slice(0, layout.mixedCardPositions.length) : [];
    rest = rest.slice(onMixed.length);
    sheets.push({
      kind: onMixed.length > 0 ? "mixed" : "letter",
      items: [place(letter, layout.letterPosition), ...onMixed.map((card, index) => place(card, layout.mixedCardPositions[index]))],
    });
  }
  const perSheet = layout.cardPositions.length;
  if (perSheet > 0) {
    for (const group of chunk(rest, perSheet)) {
      sheets.push({ kind: "cards", items: group.map((card, index) => place(card, layout.cardPositions[index])) });
    }
  }
  return sheets;
}
