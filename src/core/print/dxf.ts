// Escritor de DXF de corte — PURO. DXF ASCII R12/AC1009 em milímetros: o
// dialeto mais simples, sem handles, que toda cortadora (Silhouette Studio
// Basic inclusive) abre. Camada CORTE com o que a plotter corta e camada
// PAGINA com o retângulo da folha inteira — serve para conferir a escala
// (210 × 297) e alinhar o conjunto com a página (X 0, Y 0), depois se
// apaga. Y do DXF cresce para cima: quem chama converte (yDxf = altura − y).

export interface PageMm {
  widthMm: number;
  heightMm: number;
}

/** Um vértice de POLYLINE; `bulge` ≠ 0 abre um arco até o vértice seguinte (tan(ângulo/4)). */
export type DxfVertex = readonly [x: number, y: number, bulge: number];

export type DxfEntity =
  | { kind: "polyline"; layer: string; vertices: readonly DxfVertex[] }
  | { kind: "circle"; layer: string; cx: number; cy: number; r: number };

export const DXF_LAYERS = { cut: "CORTE", page: "PAGINA" } as const;

/** Coordenadas com 3 casas (milésimo de mm): sem assimetria entre os cantos. */
export function dxfNumber(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

/** O documento inteiro: cabeçalho, tabelas, retângulo da página e as entidades de corte. */
export function dxfDocument(input: { page: PageMm; entities: readonly DxfEntity[] }): string {
  const lines: string[] = [];
  const push = (...pairs: (string | number)[]) => {
    for (let i = 0; i < pairs.length; i += 2) lines.push(String(pairs[i]), String(pairs[i + 1]));
  };
  const { page } = input;
  push(0, "SECTION", 2, "HEADER", 9, "$ACADVER", 1, "AC1009", 9, "$INSUNITS", 70, 4);
  push(9, "$EXTMIN", 10, 0, 20, 0, 30, 0, 9, "$EXTMAX", 10, dxfNumber(page.widthMm), 20, dxfNumber(page.heightMm), 30, 0, 0, "ENDSEC");
  push(0, "SECTION", 2, "TABLES");
  push(0, "TABLE", 2, "LTYPE", 70, 1, 0, "LTYPE", 2, "CONTINUOUS", 70, 0, 3, "Solid line", 72, 65, 73, 0, 40, 0, 0, "ENDTAB");
  push(0, "TABLE", 2, "LAYER", 70, 2);
  push(0, "LAYER", 2, DXF_LAYERS.cut, 70, 0, 62, 1, 6, "CONTINUOUS");
  push(0, "LAYER", 2, DXF_LAYERS.page, 70, 0, 62, 8, 6, "CONTINUOUS");
  push(0, "ENDTAB", 0, "ENDSEC");
  push(0, "SECTION", 2, "ENTITIES");

  const polyline = (layer: string, vertices: readonly DxfVertex[]) => {
    push(0, "POLYLINE", 8, layer, 66, 1, 70, 1, 10, 0, 20, 0, 30, 0);
    for (const [x, y, bulge] of vertices) {
      push(0, "VERTEX", 8, layer, 10, dxfNumber(x), 20, dxfNumber(y), 30, 0);
      if (bulge) push(42, bulge.toFixed(5));
    }
    push(0, "SEQEND", 8, layer);
  };

  // A folha: retângulo de referência (não é para cortar). Y do DXF para cima.
  polyline(DXF_LAYERS.page, [
    [0, page.heightMm, 0],
    [page.widthMm, page.heightMm, 0],
    [page.widthMm, 0, 0],
    [0, 0, 0],
  ]);

  for (const entity of input.entities) {
    if (entity.kind === "polyline") polyline(entity.layer, entity.vertices);
    else push(0, "CIRCLE", 8, entity.layer, 10, dxfNumber(entity.cx), 20, dxfNumber(entity.cy), 30, 0, 40, dxfNumber(entity.r));
  }
  push(0, "ENDSEC", 0, "EOF");
  return lines.join("\n") + "\n";
}
