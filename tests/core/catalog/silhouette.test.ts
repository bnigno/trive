// A tag na Silhouette (puro): as marcas de registro no padrão do Studio, a
// área útil, as 4 posições, o espelho do verso e o DXF de corte.
import { describe, expect, it } from "vitest";

import {
  CUT,
  hangTagCutDxf,
  mirrorForBack,
  PAGE_A4,
  SILHOUETTE_GRID,
  silhouetteSafeArea,
  silhouetteTagPositions,
  STUDIO_MARKS,
  studioRegistrationMarks,
} from "@/core/catalog/silhouette";
import { LABELS_PER_SILHOUETTE_SHEET, labelsMaxTotal, labelsPerSheet } from "@/core/catalog/labels";

const TAG = { widthMm: 55, heightMm: 90, holeCenterXMm: 27.5, holeCenterYMm: 8 };

describe("marcas de registro (padrão do Studio, impressas por nós)", () => {
  const marks = studioRegistrationMarks(PAGE_A4);

  it("quadrado de 5 mm com o canto externo a 0,625\" das bordas; dois \"L\" de 20 mm × 0,5 mm com as pernas para dentro", () => {
    expect(marks.square).toEqual({ xMm: 15.875, yMm: 15.875, sizeMm: 5 });
    expect(marks.topRight).toEqual({ cornerXMm: 194.125, cornerYMm: 15.875, xDirection: -1, yDirection: 1, lengthMm: 20 });
    // Embaixo o recuo padrão é maior (1,024"): a marca fica a 26 mm da borda.
    expect(marks.bottomLeft).toEqual({ cornerXMm: 15.875, cornerYMm: 271, xDirection: 1, yDirection: -1, lengthMm: 20 });
    expect(marks.thicknessMm).toBeCloseTo(0.508, 3);
    expect(STUDIO_MARKS.lengthMm).toBe(20);
  });

  it("as marcas cabem na largura de corte da Portrait (203 mm) e na área imprimível da Epson (3 mm de margem)", () => {
    expect(marks.topRight.cornerXMm + marks.thicknessMm).toBeLessThanOrEqual(203);
    expect(marks.square.xMm).toBeGreaterThanOrEqual(3);
    expect(marks.bottomLeft.cornerYMm + marks.thicknessMm).toBeLessThanOrEqual(PAGE_A4.heightMm - 3);
  });

  it("nenhuma marca chega a 5 mm de uma tag (a plotter varre em volta das marcas)", () => {
    const clearance = 5;
    const boxes = [
      { x0: marks.square.xMm, y0: marks.square.yMm, x1: marks.square.xMm + marks.square.sizeMm, y1: marks.square.yMm + marks.square.sizeMm },
      { x0: marks.topRight.cornerXMm - marks.topRight.lengthMm, y0: marks.topRight.cornerYMm, x1: marks.topRight.cornerXMm, y1: marks.topRight.cornerYMm + marks.topRight.lengthMm },
      { x0: marks.bottomLeft.cornerXMm, y0: marks.bottomLeft.cornerYMm - marks.bottomLeft.lengthMm, x1: marks.bottomLeft.cornerXMm + marks.bottomLeft.lengthMm, y1: marks.bottomLeft.cornerYMm },
    ];
    for (const box of boxes) {
      for (const p of silhouetteTagPositions(TAG)) {
        const tooClose =
          box.x1 + clearance > p.xMm && box.x0 - clearance < p.xMm + TAG.widthMm && box.y1 + clearance > p.yMm && box.y0 - clearance < p.yMm + TAG.heightMm;
        expect(tooClose).toBe(false);
      }
    }
  });
});

describe("área útil e posições", () => {
  it("em A4, com as marcas no padrão do Studio, sobra ~165 × 251 mm a partir de (29, 20)", () => {
    const area = silhouetteSafeArea(PAGE_A4);
    expect(area.xMm).toBeCloseTo(29.08, 1);
    expect(area.yMm).toBeCloseTo(19.68, 1);
    expect(area.widthMm).toBeCloseTo(165.05, 1);
    expect(area.heightMm).toBeCloseTo(251.32, 1);
    // 3 colunas de 55 mm não cabem: por isso 2 × 2.
    expect(3 * 55 + 2 * SILHOUETTE_GRID.gapMm).toBeGreaterThan(area.widthMm);
  });

  it("4 tags de 55 × 90 centradas na área útil, sem sobreposição, dentro da área e da largura de corte de 203 mm", () => {
    const positions = silhouetteTagPositions(TAG);
    expect(positions).toHaveLength(4);
    expect(positions.map((p) => [p.row, p.col])).toEqual([
      [0, 0],
      [0, 1],
      [1, 0],
      [1, 1],
    ]);
    const area = silhouetteSafeArea();
    for (const p of positions) {
      expect(p.xMm).toBeGreaterThanOrEqual(area.xMm);
      expect(p.yMm).toBeGreaterThanOrEqual(area.yMm);
      expect(p.xMm + TAG.widthMm).toBeLessThanOrEqual(area.xMm + area.widthMm + 0.01);
      expect(p.yMm + TAG.heightMm).toBeLessThanOrEqual(area.yMm + area.heightMm + 0.01);
      expect(p.xMm + TAG.widthMm).toBeLessThanOrEqual(203);
    }
    expect(positions[1].xMm - positions[0].xMm).toBeCloseTo(55 + SILHOUETTE_GRID.gapMm, 2);
    expect(positions[2].yMm - positions[0].yMm).toBeCloseTo(90 + SILHOUETTE_GRID.gapMm, 2);
    // Centrada: mesma folga dos dois lados.
    expect(positions[0].xMm - area.xMm).toBeCloseTo(area.xMm + area.widthMm - (positions[1].xMm + TAG.widthMm), 1);
  });

  it("tag que não cabe lança", () => {
    expect(() => silhouetteTagPositions({ widthMm: 90, heightMm: 90 })).toThrow(/não cabe/);
  });

  it("o verso espelha as colunas (virar na borda longa) e mantém as linhas", () => {
    const front = silhouetteTagPositions(TAG);
    const back = mirrorForBack(front);
    expect(back[0].xMm).toBe(front[1].xMm);
    expect(back[1].xMm).toBe(front[0].xMm);
    expect(back[0].yMm).toBe(front[0].yMm);
    expect(back[2].xMm).toBe(front[3].xMm);
    expect(back.map((p) => [p.row, p.col])).toEqual(front.map((p) => [p.row, p.col]));
  });

  it("capacidade: 4 por folha no formato silhouette, 9 no a4; teto de 80", () => {
    expect(LABELS_PER_SILHOUETTE_SHEET).toBe(4);
    expect(labelsPerSheet("cabide", "silhouette")).toBe(4);
    expect(labelsPerSheet("cabide", "a4")).toBe(9);
    expect(labelsPerSheet("adesiva", "silhouette")).toBe(27);
    expect(labelsMaxTotal("cabide", "silhouette")).toBe(80);
  });
});

describe("hangTagCutDxf", () => {
  const dxf = hangTagCutDxf({ positions: silhouetteTagPositions(TAG), tag: TAG });
  const lines = dxf.split("\n");

  it("é DXF ASCII R12 em milímetros com as camadas CORTE e PAGINA e a extensão da folha", () => {
    expect(lines.slice(0, 4)).toEqual(["0", "SECTION", "2", "HEADER"]);
    expect(dxf).toContain("$ACADVER\n1\nAC1009\n");
    expect(dxf).toContain("$INSUNITS\n70\n4\n");
    expect(dxf).toContain("$EXTMAX\n10\n210\n20\n297\n");
    expect(dxf).toMatch(/0\nLAYER\n2\nCORTE\n/);
    expect(dxf).toMatch(/0\nLAYER\n2\nPAGINA\n/);
    expect(dxf.trimEnd().endsWith("0\nEOF")).toBe(true);
  });

  it("4 contornos fechados (POLYLINE de 8 VERTEX com bulge de 90° nos cantos) + 4 furos na camada CORTE, e o retângulo da página", () => {
    const polylines = dxf.match(/0\nPOLYLINE\n8\nCORTE\n66\n1\n70\n1\n/g) ?? [];
    expect(polylines).toHaveLength(4);
    expect(dxf.match(/0\nVERTEX\n8\nCORTE\n/g)).toHaveLength(32);
    expect(dxf.match(/0\nSEQEND\n/g)).toHaveLength(5);
    const circles = dxf.match(/0\nCIRCLE\n8\nCORTE\n/g) ?? [];
    expect(circles).toHaveLength(4);
    expect(dxf.match(/0\nPOLYLINE\n8\nPAGINA\n/g)).toHaveLength(1);
    expect(dxf.match(/0\nVERTEX\n8\nPAGINA\n/g)).toHaveLength(4);
    const bulges = lines.filter((line, i) => lines[i - 1] === "42" && line !== "");
    expect(bulges).toHaveLength(16);
    for (const b of bulges) expect(Number(b)).toBeCloseTo(-Math.tan(Math.PI / 8), 4);
  });

  it("os cantos são convexos: reconstruindo os arcos pelo bulge, o centro de cada canto fica a (r, r) para dentro da tag", () => {
    const [first] = silhouetteTagPositions(TAG);
    const r = CUT.cornerRadiusMm;
    // Primeiro arco: do vértice (x1 − r, topo) ao (x1, topo − r), bulge negativo (horário) → centro em (x1 − r, topo − r).
    const x1 = first.xMm + TAG.widthMm;
    const top = PAGE_A4.heightMm - first.yMm;
    const a = { x: x1 - r, y: top };
    const b = { x: x1, y: top - r };
    const bulge = -Math.tan(Math.PI / 8);
    const theta = 4 * Math.atan(Math.abs(bulge));
    const chord = Math.hypot(b.x - a.x, b.y - a.y);
    const radius = chord / (2 * Math.sin(theta / 2));
    expect(radius).toBeCloseTo(r, 6);
    // Centro: ponto médio da corda deslocado perpendicularmente; para bulge negativo (horário) fica à direita da corda.
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const d = Math.sqrt(radius * radius - (chord / 2) ** 2);
    const nx = (b.y - a.y) / chord;
    const ny = -(b.x - a.x) / chord;
    const center = { x: mid.x + nx * d, y: mid.y + ny * d };
    expect(center.x).toBeCloseTo(x1 - r, 6);
    expect(center.y).toBeCloseTo(top - r, 6);
  });

  it("o furo fica a 27,5 mm da borda esquerda e 8 mm do topo da tag, com raio 2,25; Y do DXF cresce para cima", () => {
    const [first] = silhouetteTagPositions(TAG);
    const holeX = Math.round((first.xMm + 27.5) * 1000) / 1000;
    const holeY = Math.round((PAGE_A4.heightMm - (first.yMm + 8)) * 1000) / 1000;
    expect(dxf).toContain(`0\nCIRCLE\n8\nCORTE\n10\n${holeX}\n20\n${holeY}\n30\n0\n40\n${CUT.holeDiameterMm / 2}\n`);
    // O primeiro vértice do primeiro contorno: (x + r, topo) — topo em Y "para cima".
    const firstVertex = `0\nVERTEX\n8\nCORTE\n10\n${Math.round((first.xMm + CUT.cornerRadiusMm) * 1000) / 1000}\n20\n${Math.round((PAGE_A4.heightMm - first.yMm) * 1000) / 1000}\n`;
    expect(dxf).toContain(firstVertex);
  });
});
