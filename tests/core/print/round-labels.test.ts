// Selos redondos na folha (puro): quantos cabem, onde, e o DXF de corte.
import { describe, expect, it } from "vitest";

import { PAGE_A4, silhouetteSafeArea, studioRegistrationMarks } from "@/core/catalog/silhouette";
import { dxfDocument, DXF_LAYERS } from "@/core/print/dxf";
import { PLAIN_SHEET_MARGIN_MM, printableArea, roundLabelCutDxf, roundLabelPositions, SEAL } from "@/core/print/round-labels";

describe("roundLabelPositions", () => {
  it("papel adesivo A4 com 8,5 mm de margem: 3 × 5 = 15 selos de 50 mm, grade centrada, ordem linha a linha", () => {
    const positions = roundLabelPositions({ diameterMm: SEAL.diameterMm, gapMm: SEAL.gapMm, area: printableArea(PAGE_A4, PLAIN_SHEET_MARGIN_MM) });
    expect(positions).toHaveLength(15);
    expect(positions.slice(0, 4).map((p) => [p.row, p.col])).toEqual([
      [0, 0],
      [0, 1],
      [0, 2],
      [1, 0],
    ]);
    // Centrada: mesma folga à esquerda e à direita, em cima e embaixo.
    const first = positions[0];
    const last = positions[14];
    expect(first.cxMm - 25).toBeCloseTo(210 - (last.cxMm + 25), 2);
    expect(first.cyMm - 25).toBeCloseTo(297 - (last.cyMm + 25), 2);
    expect(positions[1].cxMm - positions[0].cxMm).toBeCloseTo(56, 2);
    expect(positions[3].cyMm - positions[0].cyMm).toBeCloseTo(56, 2);
    // Dentro da margem.
    for (const p of positions) {
      expect(p.cxMm - 25).toBeGreaterThanOrEqual(PLAIN_SHEET_MARGIN_MM - 0.01);
      expect(p.cyMm + 25).toBeLessThanOrEqual(297 - PLAIN_SHEET_MARGIN_MM + 0.01);
    }
  });

  it("Silhouette: 3 × 4 = 12 na área útil das marcas, a ≥ 5 mm das três marcas e dentro dos 203 mm de corte", () => {
    const positions = roundLabelPositions({ diameterMm: SEAL.diameterMm, gapMm: SEAL.gapMm, area: silhouetteSafeArea(PAGE_A4) });
    expect(positions).toHaveLength(12);
    const marks = studioRegistrationMarks(PAGE_A4);
    const t = marks.thicknessMm;
    // A tinta de cada marca: o quadrado e as DUAS pernas de cada "L" (o miolo
    // do "L" é papel em branco — a grade pode chegar perto dele).
    const leg = (m: typeof marks.topRight) => [
      { x0: Math.min(m.cornerXMm, m.cornerXMm + m.xDirection * m.lengthMm), x1: Math.max(m.cornerXMm, m.cornerXMm + m.xDirection * m.lengthMm), y0: m.yDirection === 1 ? m.cornerYMm : m.cornerYMm - t, y1: m.yDirection === 1 ? m.cornerYMm + t : m.cornerYMm },
      { x0: m.xDirection === 1 ? m.cornerXMm : m.cornerXMm - t, x1: m.xDirection === 1 ? m.cornerXMm + t : m.cornerXMm, y0: Math.min(m.cornerYMm, m.cornerYMm + m.yDirection * m.lengthMm), y1: Math.max(m.cornerYMm, m.cornerYMm + m.yDirection * m.lengthMm) },
    ];
    const ink = [
      { x0: marks.square.xMm, y0: marks.square.yMm, x1: marks.square.xMm + marks.square.sizeMm, y1: marks.square.yMm + marks.square.sizeMm },
      ...leg(marks.topRight),
      ...leg(marks.bottomLeft),
    ];
    const clearance = SEAL.diameterMm / 2 + SEAL.bleedMm + 5;
    const area = silhouetteSafeArea(PAGE_A4);
    for (const p of positions) {
      expect(p.cxMm + 25).toBeLessThanOrEqual(203);
      // Dentro da área útil (com a sangria).
      expect(p.cxMm - 25 - SEAL.bleedMm).toBeGreaterThanOrEqual(area.xMm - 0.01);
      expect(p.cyMm - 25 - SEAL.bleedMm).toBeGreaterThanOrEqual(area.yMm - 0.01);
      expect(p.cyMm + 25 + SEAL.bleedMm).toBeLessThanOrEqual(area.yMm + area.heightMm + 0.01);
      for (const box of ink) {
        const dx = Math.max(box.x0 - p.cxMm, 0, p.cxMm - box.x1);
        const dy = Math.max(box.y0 - p.cyMm, 0, p.cyMm - box.y1);
        expect(Math.hypot(dx, dy), `selo (${p.cxMm}, ${p.cyMm}) perto da marca`).toBeGreaterThanOrEqual(clearance);
      }
    }
  });

  it("área pequena demais: nenhum selo", () => {
    expect(roundLabelPositions({ diameterMm: 50, gapMm: 6, area: { xMm: 0, yMm: 0, widthMm: 40, heightMm: 100 } })).toEqual([]);
  });
});

describe("roundLabelCutDxf", () => {
  it("um CIRCLE de raio 25 por selo na camada CORTE, com Y invertido, mais a PAGINA", () => {
    const positions = roundLabelPositions({ diameterMm: 50, gapMm: 6, area: silhouetteSafeArea(PAGE_A4) });
    const dxf = roundLabelCutDxf({ page: PAGE_A4, positions, diameterMm: 50 });
    const lines = dxf.split("\n");
    expect(lines.filter((l) => l === "CIRCLE")).toHaveLength(12);
    expect(lines.filter((l) => l === "POLYLINE")).toHaveLength(1);
    const first = lines.indexOf("CIRCLE");
    expect(lines.slice(first, first + 14)).toEqual(["CIRCLE", "8", DXF_LAYERS.cut, "10", String(positions[0].cxMm), "20", String(Math.round((297 - positions[0].cyMm) * 1000) / 1000), "30", "0", "40", "25", "0", "CIRCLE", "8"]);
    expect(dxf.startsWith(dxfDocument({ page: PAGE_A4, entities: [] }).split("ENTITIES")[0])).toBe(true);
    expect(dxf.trimEnd().endsWith("EOF")).toBe(true);
  });
});
