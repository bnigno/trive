// Etiquetas REDONDAS numa folha (o selo de embalagem de 50 mm) — PURO.
// Grade de círculos com calha, centrada na área disponível: no papel
// adesivo comum a área é a folha menos a margem; na Silhouette é a área
// útil que as marcas de registro deixam livre. O selo é de um lado só, então
// não precisa centrar na página (o espelho do verso não existe aqui).
import { DXF_LAYERS, dxfDocument, type DxfEntity, type PageMm } from "@/core/print/dxf";

export interface AreaMm {
  xMm: number;
  yMm: number;
  widthMm: number;
  heightMm: number;
}

/** O selo da embalagem: 50 mm, calha de 6 mm; na Silhouette a arte sangra 1 mm além do corte. */
export const SEAL = { diameterMm: 50, gapMm: 6, bleedMm: 1 } as const;

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

/**
 * Quantos círculos cabem (colunas × linhas) e onde: a grade fica centrada,
 * ordem linha a linha. `area` diz quantos cabem e onde é permitido;
 * `centerIn` (opcional) diz onde centrar — a Silhouette centra na ALTURA da
 * página, não na área útil (que é assimétrica): assim um DXF que o Studio
 * importe invertido no Y cai nas mesmas posições e não corta fora do lugar.
 * Lança se a grade centrada não couber na área. Área sem espaço → lista vazia.
 */
export function roundLabelPositions(input: { diameterMm: number; gapMm: number; area: AreaMm; centerIn?: AreaMm }): RoundLabelPosition[] {
  const { diameterMm, gapMm, area } = input;
  const pitch = diameterMm + gapMm;
  const columns = Math.floor((area.widthMm + gapMm) / pitch);
  const rows = Math.floor((area.heightMm + gapMm) / pitch);
  if (columns < 1 || rows < 1) return [];
  const gridWidth = columns * diameterMm + (columns - 1) * gapMm;
  const gridHeight = rows * diameterMm + (rows - 1) * gapMm;
  const center = input.centerIn ?? area;
  const left = center.xMm + (center.widthMm - gridWidth) / 2;
  const top = center.yMm + (center.heightMm - gridHeight) / 2;
  if (left < area.xMm - 0.01 || top < area.yMm - 0.01 || left + gridWidth > area.xMm + area.widthMm + 0.01 || top + gridHeight > area.yMm + area.heightMm + 0.01) {
    throw new Error(`A grade ${columns} × ${rows} de ${diameterMm} mm centrada não cabe na área disponível.`);
  }
  const originX = left + diameterMm / 2;
  const originY = top + diameterMm / 2;
  const positions: RoundLabelPosition[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < columns; col += 1) {
      positions.push({ row, col, cxMm: round2(originX + col * pitch), cyMm: round2(originY + row * pitch) });
    }
  }
  return positions;
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
