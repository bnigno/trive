// A tag de cabide na Silhouette Portrait 3 (print & cut) — PURO. A folha é
// impressa AQUI, já com as MARCAS DE REGISTRO no padrão do Studio (quadrado
// + dois "L"); no Studio só se abre o arquivo de corte e manda cortar — a
// plotter lê as marcas impressas. As marcas comem as margens: com os valores
// padrão do Studio (recuo 0,625" em cima/esquerda/direita, 1,024" embaixo,
// faixas hachuradas ao lado das marcas) sobra em A4 uma área útil de
// ~165 × 251 mm — cabem 2 × 2 tags. Mexer nas marcas para ganhar área é o que
// mais causa "não leu as marcas": ficamos no padrão. Aqui ficam a geometria
// das marcas, as posições das tags nessa área e o arquivo de corte (DXF, que
// o Studio Basic abre) com o contorno arredondado e o furo.

export interface PageMm {
  widthMm: number;
  heightMm: number;
}

export const PAGE_A4: PageMm = { widthMm: 210, heightMm: 297 };

/**
 * Padrões do Silhouette Studio em mm: recuos 0,625" / 1,024", "L" de 0,787"
 * (20 mm) com traço de 0,020" (a plotter procura 20 mm × 0,5 mm), quadrado
 * de 5 mm. As faixas hachuradas: a área útil publicada para Letter
 * (6,73 × 9,2") desconta, além dos recuos, 0,52" na horizontal e 0,15" na
 * vertical.
 */
export const STUDIO_MARKS = {
  insetMm: 15.875,
  insetBottomMm: 26.0,
  lengthMm: 20,
  thicknessMm: 0.508,
  squareMm: 5,
  hatchLeftMm: 13.2,
  hatchTopMm: 3.8,
} as const;

export interface CornerMark {
  /** O canto externo do "L" (onde as duas pernas se encontram). */
  cornerXMm: number;
  cornerYMm: number;
  /** Para onde cada perna aponta: +1 cresce (direita/baixo), −1 diminui. */
  xDirection: 1 | -1;
  yDirection: 1 | -1;
  lengthMm: number;
}

export interface RegistrationMarks {
  square: { xMm: number; yMm: number; sizeMm: number };
  topRight: CornerMark;
  bottomLeft: CornerMark;
  thicknessMm: number;
}

/**
 * As três marcas que o Studio espera (valores padrão), na página em mm com
 * Y para baixo: quadrado cheio no canto superior esquerdo, "L" no superior
 * direito e "L" no inferior esquerdo, pernas apontando para dentro.
 */
export function studioRegistrationMarks(page: PageMm = PAGE_A4): RegistrationMarks {
  const { insetMm, insetBottomMm, lengthMm, thicknessMm, squareMm } = STUDIO_MARKS;
  return {
    square: { xMm: insetMm, yMm: insetMm, sizeMm: squareMm },
    topRight: { cornerXMm: round3(page.widthMm - insetMm), cornerYMm: insetMm, xDirection: -1, yDirection: 1, lengthMm },
    bottomLeft: { cornerXMm: insetMm, cornerYMm: round3(page.heightMm - insetBottomMm), xDirection: 1, yDirection: -1, lengthMm },
    thicknessMm,
  };
}

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

/**
 * As 4 posições (canto superior esquerdo de cada tag): grade centrada na
 * PÁGINA — não na área útil, que é assimétrica (a faixa hachurada só existe à
 * esquerda). Centrada na página, a folha virada na borda longa cai sobre si
 * mesma: a coluna da esquerda vira a da direita e o verso bate com a frente.
 * A grade tem de caber na área útil, senão lança.
 */
export function silhouetteTagPositions(tag: TagSizeMm, page: PageMm = PAGE_A4): TagPosition[] {
  const area = silhouetteSafeArea(page);
  const { columns, rows, gapMm } = SILHOUETTE_GRID;
  const gridWidth = columns * tag.widthMm + (columns - 1) * gapMm;
  const gridHeight = rows * tag.heightMm + (rows - 1) * gapMm;
  const originX = (page.widthMm - gridWidth) / 2;
  const originY = (page.heightMm - gridHeight) / 2;
  const fits = originX >= area.xMm && originY >= area.yMm && originX + gridWidth <= area.xMm + area.widthMm && originY + gridHeight <= area.yMm + area.heightMm;
  if (!fits) {
    throw new Error(`A grade ${columns} × ${rows} de ${tag.widthMm} × ${tag.heightMm} mm centrada na página não cabe na área útil da Silhouette.`);
  }
  const positions: TagPosition[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < columns; col += 1) {
      positions.push({ row, col, xMm: round2(originX + col * (tag.widthMm + gapMm)), yMm: round2(originY + row * (tag.heightMm + gapMm)) });
    }
  }
  return positions;
}

/**
 * O verso, impresso na mesma folha virada na borda longa: reflexão FÍSICA
 * da página (x' = largura − x − largura da tag), a linha fica. Com a grade
 * centrada na página isso é a troca de colunas — mas a conta é pela página,
 * para o verso cair sobre a frente mesmo que a grade mude.
 */
export function mirrorForBack(positions: readonly TagPosition[], tag: TagSizeMm, page: PageMm = PAGE_A4): TagPosition[] {
  return positions.map((p) => ({ ...p, xMm: round2(page.widthMm - p.xMm - tag.widthMm) }));
}

/** Contorno de corte: cantos arredondados e o furo do cordão (um pouco maior que o cartão pede: o cordão passa fácil). */
export const CUT = { cornerRadiusMm: 3, holeDiameterMm: 4.5 } as const;

/** tan(90°/4): o "bulge" de um arco de 90° numa LWPOLYLINE do DXF. */
const QUARTER_BULGE = Math.tan(Math.PI / 8);

/**
 * O arquivo de corte para o Silhouette Studio (DXF ASCII R12/AC1009 em mm —
 * o dialeto mais simples, sem handles, que toda cortadora lê): na camada
 * CORTE, uma POLYLINE fechada com cantos arredondados (bulge nos VERTEX)
 * por tag e um CIRCLE do furo; na camada PAGINA, o retângulo da folha
 * inteira — serve para conferir a escala (210 × 297) e alinhar o conjunto
 * com a página (X 0, Y 0), depois se apaga. Y do DXF cresce para cima:
 * yDxf = altura da página − y.
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
  push(0, "SECTION", 2, "HEADER", 9, "$ACADVER", 1, "AC1009", 9, "$INSUNITS", 70, 4);
  push(9, "$EXTMIN", 10, 0, 20, 0, 30, 0, 9, "$EXTMAX", 10, fmt(page.widthMm), 20, fmt(page.heightMm), 30, 0, 0, "ENDSEC");
  push(0, "SECTION", 2, "TABLES");
  push(0, "TABLE", 2, "LTYPE", 70, 1, 0, "LTYPE", 2, "CONTINUOUS", 70, 0, 3, "Solid line", 72, 65, 73, 0, 40, 0, 0, "ENDTAB");
  push(0, "TABLE", 2, "LAYER", 70, 2);
  push(0, "LAYER", 2, "CORTE", 70, 0, 62, 1, 6, "CONTINUOUS");
  push(0, "LAYER", 2, "PAGINA", 70, 0, 62, 8, 6, "CONTINUOUS");
  push(0, "ENDTAB", 0, "ENDSEC");
  push(0, "SECTION", 2, "ENTITIES");

  const polyline = (layer: string, vertices: readonly (readonly [number, number, number])[]) => {
    push(0, "POLYLINE", 8, layer, 66, 1, 70, 1, 10, 0, 20, 0, 30, 0);
    for (const [x, y, bulge] of vertices) {
      push(0, "VERTEX", 8, layer, 10, fmt(x), 20, fmt(y), 30, 0);
      if (bulge) push(42, bulge.toFixed(5));
    }
    push(0, "SEQEND", 8, layer);
  };

  // A folha: retângulo de referência (não é para cortar).
  polyline("PAGINA", [
    [0, up(0), 0],
    [page.widthMm, up(0), 0],
    [page.widthMm, up(page.heightMm), 0],
    [0, up(page.heightMm), 0],
  ]);

  const r = CUT.cornerRadiusMm;
  for (const p of input.positions) {
    const x0 = p.xMm;
    const y0 = p.yMm;
    const x1 = p.xMm + input.tag.widthMm;
    const y1 = p.yMm + input.tag.heightMm;
    // Sentido horário na página (que é anti-horário no DXF, com Y para cima):
    // cada canto é um vértice reto seguido de um arco de 90° (bulge no
    // vértice que abre o arco).
    // Bulge negativo = arco horário (com Y para cima): os cantos ficam convexos.
    polyline("CORTE", [
      [x0 + r, up(y0), 0],
      [x1 - r, up(y0), -QUARTER_BULGE],
      [x1, up(y0 + r), 0],
      [x1, up(y1 - r), -QUARTER_BULGE],
      [x1 - r, up(y1), 0],
      [x0 + r, up(y1), -QUARTER_BULGE],
      [x0, up(y1 - r), 0],
      [x0, up(y0 + r), -QUARTER_BULGE],
    ]);
    push(0, "CIRCLE", 8, "CORTE", 10, fmt(x0 + input.tag.holeCenterXMm), 20, fmt(up(y0 + input.tag.holeCenterYMm)), 30, 0, 40, fmt(CUT.holeDiameterMm / 2));
  }
  push(0, "ENDSEC", 0, "EOF");
  return lines.join("\n") + "\n";
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Coordenadas com 3 casas (milésimo de mm): sem assimetria entre os cantos. */
function fmt(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}
