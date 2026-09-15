// A tag na Silhouette (puro): a área útil com as marcas do Studio, as 4
// posições, o espelho do verso e o DXF de corte.
import { describe, expect, it } from "vitest";

import {
  CUT,
  hangTagCutDxf,
  mirrorForBack,
  PAGE_A4,
  SILHOUETTE_GRID,
  silhouetteSafeArea,
  silhouetteTagPositions,
} from "@/core/catalog/silhouette";
import { LABELS_PER_SILHOUETTE_SHEET, labelsMaxTotal, labelsPerSheet } from "@/core/catalog/labels";

const TAG = { widthMm: 55, heightMm: 90, holeCenterXMm: 27.5, holeCenterYMm: 8 };

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

  it("é DXF ASCII em milímetros com as camadas CORTE e PAGINA", () => {
    expect(lines.slice(0, 4)).toEqual(["0", "SECTION", "2", "HEADER"]);
    expect(dxf).toContain("$INSUNITS\n70\n4\n");
    expect(dxf).toMatch(/0\nLAYER\n2\nCORTE\n/);
    expect(dxf).toMatch(/0\nLAYER\n2\nPAGINA\n/);
    expect(dxf.trimEnd().endsWith("0\nEOF")).toBe(true);
  });

  it("4 contornos fechados com cantos arredondados (bulge de 90°) + 4 furos na camada CORTE, e o retângulo da página", () => {
    const polylines = dxf.match(/0\nLWPOLYLINE\n8\nCORTE\n90\n8\n70\n1\n/g) ?? [];
    expect(polylines).toHaveLength(4);
    const circles = dxf.match(/0\nCIRCLE\n8\nCORTE\n/g) ?? [];
    expect(circles).toHaveLength(4);
    expect(dxf.match(/0\nLWPOLYLINE\n8\nPAGINA\n90\n4\n70\n1\n/g)).toHaveLength(1);
    const bulges = lines.filter((line, i) => lines[i - 1] === "42" && line !== "");
    expect(bulges).toHaveLength(16);
    for (const b of bulges) expect(Number(b)).toBeCloseTo(-Math.tan(Math.PI / 8), 4);
  });

  it("o furo fica a 27,5 mm da borda esquerda e 8 mm do topo da tag, com raio 2,25; Y do DXF cresce para cima", () => {
    const [first] = silhouetteTagPositions(TAG);
    const holeX = Math.round((first.xMm + 27.5) * 1000) / 1000;
    const holeY = Math.round((PAGE_A4.heightMm - (first.yMm + 8)) * 1000) / 1000;
    expect(dxf).toContain(`0\nCIRCLE\n8\nCORTE\n10\n${holeX}\n20\n${holeY}\n40\n${CUT.holeDiameterMm / 2}\n`);
    // O primeiro vértice do primeiro contorno: (x + r, topo) — topo em Y "para cima".
    const firstVertex = `10\n${Math.round((first.xMm + CUT.cornerRadiusMm) * 1000) / 1000}\n20\n${Math.round((PAGE_A4.heightMm - first.yMm) * 1000) / 1000}\n`;
    expect(dxf).toContain(firstVertex);
  });
});
