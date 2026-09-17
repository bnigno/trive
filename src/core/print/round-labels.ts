// Etiquetas numa folha — PURO: a grade de células (selo redondo de 50 mm,
// adesivo da sacola de 15 × 10) com calha, centrada na área disponível: no
// papel adesivo comum a área é a folha menos a margem; na Silhouette é a
// área útil que as marcas de registro deixam livre. Tudo de um lado só, então
// não há espelho de verso.
import { DXF_LAYERS, dxfDocument, roundedRectEntity, type DxfEntity, type PageMm } from "@/core/print/dxf";

export interface AreaMm {
  xMm: number;
  yMm: number;
  widthMm: number;
  heightMm: number;
}

/** O selo da embalagem: 50 mm, calha de 6 mm; a arte sangra 1 mm além do corte. */
export const SEAL = { diameterMm: 50, gapMm: 6, bleedMm: 1 } as const;

/** O adesivo da sacola: 15 × 10 cm (paisagem), cantos arredondados no corte da plotter; 2 por A4 é o máximo físico. */
export const BAG_STICKER = { widthMm: 150, heightMm: 100, gapMm: 6, bleedMm: 1, cornerRadiusMm: 6 } as const;

/** Margem do papel comum: dá folga para a tesoura e fica dentro da área imprimível (3 mm) de qualquer jato de tinta. */
export const PLAIN_SHEET_MARGIN_MM = 8.5;

export interface RoundLabelPosition {
  row: number;
  col: number;
  /** Centro do círculo na página, em mm (Y para baixo). */
  cxMm: number;
  cyMm: number;
}

/** A folha menos uma margem igual dos quatro lados. */
export function printableArea(page: PageMm, marginMm: number): AreaMm {
  return { xMm: marginMm, yMm: marginMm, widthMm: page.widthMm - 2 * marginMm, heightMm: page.heightMm - 2 * marginMm };
}

export interface GridPosition {
  row: number;
  col: number;
  /** Canto superior esquerdo da célula na página, em mm (Y para baixo). */
  xMm: number;
  yMm: number;
}

/**
 * Quantas células cabem (colunas × linhas) e onde: a grade fica centrada,
 * ordem linha a linha. `area` diz quantas cabem e onde é permitido;
 * `centerIn` (opcional) diz onde centrar — a Silhouette centra na ALTURA da
 * página, não na área útil (que é assimétrica): assim um DXF que o Studio
 * importe invertido no Y cai nas mesmas posições e não corta fora do lugar.
 * Lança se a grade centrada não couber na área. Área sem espaço → lista vazia.
 */
export function gridPositions(input: { cellWidthMm: number; cellHeightMm: number; gapMm: number; area: AreaMm; centerIn?: AreaMm }): GridPosition[] {
  const { cellWidthMm, cellHeightMm, gapMm, area } = input;
  const columns = Math.floor((area.widthMm + gapMm) / (cellWidthMm + gapMm));
  const rows = Math.floor((area.heightMm + gapMm) / (cellHeightMm + gapMm));
  if (columns < 1 || rows < 1) return [];
  const gridWidth = columns * cellWidthMm + (columns - 1) * gapMm;
  const gridHeight = rows * cellHeightMm + (rows - 1) * gapMm;
  const center = input.centerIn ?? area;
  const left = center.xMm + (center.widthMm - gridWidth) / 2;
  const top = center.yMm + (center.heightMm - gridHeight) / 2;
  if (left < area.xMm - 0.01 || top < area.yMm - 0.01 || left + gridWidth > area.xMm + area.widthMm + 0.01 || top + gridHeight > area.yMm + area.heightMm + 0.01) {
    throw new Error(`A grade ${columns} × ${rows} de ${cellWidthMm} × ${cellHeightMm} mm centrada não cabe na área disponível.`);
  }
  const positions: GridPosition[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < columns; col += 1) {
      positions.push({ row, col, xMm: round2(left + col * (cellWidthMm + gapMm)), yMm: round2(top + row * (cellHeightMm + gapMm)) });
    }
  }
  return positions;
}

/** Os selos redondos: a grade de células quadradas, devolvida pelos CENTROS. */
export function roundLabelPositions(input: { diameterMm: number; gapMm: number; area: AreaMm; centerIn?: AreaMm }): RoundLabelPosition[] {
  const r = input.diameterMm / 2;
  return gridPositions({ cellWidthMm: input.diameterMm, cellHeightMm: input.diameterMm, gapMm: input.gapMm, area: input.area, centerIn: input.centerIn }).map((p) => ({
    row: p.row,
    col: p.col,
    cxMm: round2(p.xMm + r),
    cyMm: round2(p.yMm + r),
  }));
}

/** O arquivo de corte: um CIRCLE por selo na camada CORTE (Y invertido: o DXF cresce para cima). */
export function roundLabelCutDxf(input: { page: PageMm; positions: readonly RoundLabelPosition[]; diameterMm: number }): string {
  const entities: DxfEntity[] = input.positions.map((p) => ({
    kind: "circle",
    layer: DXF_LAYERS.cut,
    cx: p.cxMm,
    cy: input.page.heightMm - p.cyMm,
    r: input.diameterMm / 2,
  }));
  return dxfDocument({ page: input.page, entities });
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** O arquivo de corte dos adesivos retangulares: uma POLYLINE fechada com cantos arredondados por adesivo. */
export function rectLabelCutDxf(input: { page: PageMm; positions: readonly GridPosition[]; widthMm: number; heightMm: number; cornerRadiusMm: number }): string {
  const entities: DxfEntity[] = input.positions.map((p) =>
    roundedRectEntity({
      layer: DXF_LAYERS.cut,
      x0: p.xMm,
      y0: p.yMm,
      x1: p.xMm + input.widthMm,
      y1: p.yMm + input.heightMm,
      radiusMm: input.cornerRadiusMm,
      pageHeightMm: input.page.heightMm,
    }),
  );
  return dxfDocument({ page: input.page, entities });
}
