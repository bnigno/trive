// A tag de cabide na Silhouette Portrait 3 (print & cut) — PURO. O Studio
// imprime a folha com as MARCAS DE REGISTRO dele (quadrado + dois "L") e a
// plotter lê as marcas para cortar. As marcas comem as margens: com os
// valores padrão do Studio (recuo 0,625" em cima/esquerda/direita, 1,024"
// embaixo, faixas hachuradas ao lado das marcas) sobra em A4 uma área útil
// de ~165 × 251 mm — cabem 2 × 2 tags. Mexer nas marcas para ganhar área é o
// que mais causa "não leu as marcas": ficamos no padrão. Aqui ficam as
// posições das tags nessa área e o arquivo de corte (DXF, que o Studio Basic
// abre) com o contorno arredondado e o furo.

export interface PageMm {
  widthMm: number;
  heightMm: number;
}

export const PAGE_A4: PageMm = { widthMm: 210, heightMm: 297 };

/**
 * Padrões do Silhouette Studio em mm (0,625" / 1,024") e as faixas
 * hachuradas: a área útil publicada para Letter (6,73 × 9,2") desconta, além
 * dos recuos, 0,52" na horizontal e 0,15" na vertical.
 */
export const STUDIO_MARKS = {
  insetMm: 15.875,
  insetBottomMm: 26.0,
  hatchLeftMm: 13.2,
  hatchTopMm: 3.8,
} as const;

export interface SafeArea {
  xMm: number;
  yMm: number;
  widthMm: number;
  heightMm: number;
}

/** Onde a arte pode ficar com as marcas de registro no padrão. */
export function silhouetteSafeArea(page: PageMm = PAGE_A4): SafeArea {
  const xMm = STUDIO_MARKS.insetMm + STUDIO_MARKS.hatchLeftMm;
  const yMm = STUDIO_MARKS.insetMm + STUDIO_MARKS.hatchTopMm;
  return {
    xMm: round2(xMm),
    yMm: round2(yMm),
    widthMm: round2(page.widthMm - xMm - STUDIO_MARKS.insetMm),
    heightMm: round2(page.heightMm - yMm - STUDIO_MARKS.insetBottomMm),
  };
}

export const SILHOUETTE_GRID = { columns: 2, rows: 2, gapMm: 6 } as const;

export interface TagSizeMm {
  widthMm: number;
  heightMm: number;
}

export interface TagPosition {
  /** Linha e coluna na grade (0-based), na ordem de leitura. */
  row: number;
  col: number;
  xMm: number;
  yMm: number;
}

/** As 4 posições (canto superior esquerdo de cada tag), grade centrada na área útil. */
export function silhouetteTagPositions(tag: TagSizeMm, page: PageMm = PAGE_A4): TagPosition[] {
  const area = silhouetteSafeArea(page);
  const { columns, rows, gapMm } = SILHOUETTE_GRID;
  const gridWidth = columns * tag.widthMm + (columns - 1) * gapMm;
  const gridHeight = rows * tag.heightMm + (rows - 1) * gapMm;
  if (gridWidth > area.widthMm || gridHeight > area.heightMm) {
    throw new Error(`A grade ${columns} × ${rows} de ${tag.widthMm} × ${tag.heightMm} mm não cabe na área útil da Silhouette.`);
  }
  const originX = area.xMm + (area.widthMm - gridWidth) / 2;
  const originY = area.yMm + (area.heightMm - gridHeight) / 2;
  const positions: TagPosition[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < columns; col += 1) {
      positions.push({ row, col, xMm: round2(originX + col * (tag.widthMm + gapMm)), yMm: round2(originY + row * (tag.heightMm + gapMm)) });
    }
  }
  return positions;
}

/**
 * O verso, impresso na mesma folha virada na borda longa: a coluna espelha
 * (a tag da esquerda na frente é a da direita no verso), a linha fica.
 */
export function mirrorForBack(positions: readonly TagPosition[]): TagPosition[] {
  const byCell = new Map(positions.map((p) => [`${p.row}:${p.col}`, p]));
  return positions.map((p) => {
    const mirrored = byCell.get(`${p.row}:${SILHOUETTE_GRID.columns - 1 - p.col}`);
    if (!mirrored) throw new Error("Grade incompleta para espelhar.");
    return { ...p, xMm: mirrored.xMm };
  });
}

/** Contorno de corte: cantos arredondados e o furo do cordão (um pouco maior que o cartão pede: o cordão passa fácil). */
export const CUT = { cornerRadiusMm: 3, holeDiameterMm: 4.5 } as const;

/** tan(90°/4): o "bulge" de um arco de 90° numa LWPOLYLINE do DXF. */
const QUARTER_BULGE = Math.tan(Math.PI / 8);

/**
 * O arquivo de corte para o Silhouette Studio (DXF ASCII em mm): na camada
 * CORTE, uma polilinha fechada com cantos arredondados por tag e um círculo
 * do furo; na camada PAGINA, o retângulo da folha inteira — só para alinhar
 * o conjunto com a página (X 0, Y 0) e depois apagar. Y do DXF cresce para
 * cima: yDxf = altura da página − y.
 */
export function hangTagCutDxf(input: {
  page?: PageMm;
  positions: readonly TagPosition[];
  tag: TagSizeMm & { holeCenterXMm: number; holeCenterYMm: number };
}): string {
  const page = input.page ?? PAGE_A4;
  const up = (yMm: number) => page.heightMm - yMm;
  const lines: string[] = [];
  const push = (...pairs: (string | number)[]) => {
    for (let i = 0; i < pairs.length; i += 2) lines.push(String(pairs[i]), String(pairs[i + 1]));
  };
  push(0, "SECTION", 2, "HEADER", 9, "$ACADVER", 1, "AC1015", 9, "$INSUNITS", 70, 4, 0, "ENDSEC");
  push(0, "SECTION", 2, "TABLES", 0, "TABLE", 2, "LAYER", 70, 2);
  push(0, "LAYER", 2, "CORTE", 70, 0, 62, 1, 6, "CONTINUOUS");
  push(0, "LAYER", 2, "PAGINA", 70, 0, 62, 8, 6, "CONTINUOUS");
  push(0, "ENDTAB", 0, "ENDSEC");
  push(0, "SECTION", 2, "ENTITIES");

  // A folha: retângulo de referência (não é para cortar).
  push(0, "LWPOLYLINE", 8, "PAGINA", 90, 4, 70, 1);
  for (const [x, y] of [
    [0, up(0)],
    [page.widthMm, up(0)],
    [page.widthMm, up(page.heightMm)],
    [0, up(page.heightMm)],
  ]) {
    push(10, fmt(x), 20, fmt(y));
  }

  const r = CUT.cornerRadiusMm;
  for (const p of input.positions) {
    const x0 = p.xMm;
    const y0 = p.yMm;
    const x1 = p.xMm + input.tag.widthMm;
    const y1 = p.yMm + input.tag.heightMm;
    // Sentido horário na página (que é anti-horário no DXF, com Y para cima):
    // cada canto é um vértice reto seguido de um arco de 90° (bulge no
    // vértice que abre o arco).
    const vertices: [number, number, number][] = [
      [x0 + r, y0, 0],
      [x1 - r, y0, QUARTER_BULGE],
      [x1, y0 + r, 0],
      [x1, y1 - r, QUARTER_BULGE],
      [x1 - r, y1, 0],
      [x0 + r, y1, QUARTER_BULGE],
      [x0, y1 - r, 0],
      [x0, y0 + r, QUARTER_BULGE],
    ];
    push(0, "LWPOLYLINE", 8, "CORTE", 90, vertices.length, 70, 1);
    for (const [x, y, bulge] of vertices) {
      push(10, fmt(x), 20, fmt(up(y)));
      if (bulge) push(42, (-bulge).toFixed(5));
    }
    push(0, "CIRCLE", 8, "CORTE", 10, fmt(x0 + input.tag.holeCenterXMm), 20, fmt(up(y0 + input.tag.holeCenterYMm)), 40, fmt(CUT.holeDiameterMm / 2));
  }
  push(0, "ENDSEC", 0, "EOF");
  return lines.join("\n") + "\n";
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Coordenadas com 3 casas (milésimo de mm): sem assimetria entre os cantos. */
function fmt(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}
