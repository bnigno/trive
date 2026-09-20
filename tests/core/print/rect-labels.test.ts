// O adesivo da sacola (15 × 10) na folha (puro): 2 por A4, centrados na
// altura da página, longe das marcas, e o DXF de cantos arredondados.
import { describe, expect, it } from "vitest";

import { PAGE_A4, silhouetteSafeArea, studioRegistrationMarks } from "@/core/catalog/silhouette";
import { QUARTER_BULGE } from "@/core/print/dxf";
import { BAG_STICKER, EDITION_CARD, EDITION_LETTER, gridPositions, PLAIN_SHEET_MARGIN_MM, printableArea, rectLabelCutDxf } from "@/core/print/round-labels";

const cell = { cellWidthMm: BAG_STICKER.widthMm, cellHeightMm: BAG_STICKER.heightMm, gapMm: BAG_STICKER.gapMm };

describe("gridPositions — adesivo da sacola", () => {
  it("papel comum: 1 × 2 = 2 por folha, centrados na página nos dois eixos", () => {
    const positions = gridPositions({ ...cell, area: printableArea(PAGE_A4, PLAIN_SHEET_MARGIN_MM) });
    expect(positions).toEqual([
      { row: 0, col: 0, xMm: 30, yMm: 45.5 },
      { row: 1, col: 0, xMm: 30, yMm: 151.5 },
    ]);
    expect(297 - (151.5 + 100)).toBeCloseTo(45.5, 2);
  });

  it("Silhouette: 2 por folha, centrados na ALTURA da página e na largura da área útil; a ≥ 5 mm da tinta das marcas com a sangria; dentro dos 203 mm", () => {
    const safe = silhouetteSafeArea(PAGE_A4);
    const positions = gridPositions({ ...cell, area: safe, centerIn: { xMm: safe.xMm, yMm: 0, widthMm: safe.widthMm, heightMm: PAGE_A4.heightMm } });
    expect(positions).toHaveLength(2);
    expect(positions.map((p) => p.yMm)).toEqual([45.5, 151.5]);
    expect(positions[0].xMm).toBeCloseTo(36.6, 1);
    const marks = studioRegistrationMarks(PAGE_A4);
    const t = marks.thicknessMm;
    const leg = (m: typeof marks.topRight) => [
      { x0: Math.min(m.cornerXMm, m.cornerXMm + m.xDirection * m.lengthMm), x1: Math.max(m.cornerXMm, m.cornerXMm + m.xDirection * m.lengthMm), y0: m.yDirection === 1 ? m.cornerYMm : m.cornerYMm - t, y1: m.yDirection === 1 ? m.cornerYMm + t : m.cornerYMm },
      { x0: m.xDirection === 1 ? m.cornerXMm : m.cornerXMm - t, x1: m.xDirection === 1 ? m.cornerXMm + t : m.cornerXMm, y0: Math.min(m.cornerYMm, m.cornerYMm + m.yDirection * m.lengthMm), y1: Math.max(m.cornerYMm, m.cornerYMm + m.yDirection * m.lengthMm) },
    ];
    const ink = [
      { x0: marks.square.xMm, y0: marks.square.yMm, x1: marks.square.xMm + marks.square.sizeMm, y1: marks.square.yMm + marks.square.sizeMm },
      ...leg(marks.topRight),
      ...leg(marks.bottomLeft),
    ];
    for (const p of positions) {
      const box = { x0: p.xMm - BAG_STICKER.bleedMm, y0: p.yMm - BAG_STICKER.bleedMm, x1: p.xMm + BAG_STICKER.widthMm + BAG_STICKER.bleedMm, y1: p.yMm + BAG_STICKER.heightMm + BAG_STICKER.bleedMm };
      expect(box.x1).toBeLessThanOrEqual(203);
      for (const mark of ink) {
        const dx = Math.max(mark.x0 - box.x1, 0, box.x0 - mark.x1);
        const dy = Math.max(mark.y0 - box.y1, 0, box.y0 - mark.y1);
        expect(Math.hypot(dx, dy)).toBeGreaterThanOrEqual(5);
      }
    }
  });
});

describe("rectLabelCutDxf", () => {
  it("uma POLYLINE fechada de 8 vértices (4 arcos de 90°, cantos convexos) por adesivo, com Y invertido, mais a PAGINA", () => {
    const positions = gridPositions({ ...cell, area: printableArea(PAGE_A4, PLAIN_SHEET_MARGIN_MM) });
    const dxf = rectLabelCutDxf({ page: PAGE_A4, positions, widthMm: 150, heightMm: 100, cornerRadiusMm: 6 });
    const lines = dxf.split("\n");
    expect(lines.filter((l) => l === "POLYLINE")).toHaveLength(3);
    expect(lines.filter((l) => l === "VERTEX")).toHaveLength(4 + 16);
    expect(lines.filter((l) => l === (-QUARTER_BULGE).toFixed(5))).toHaveLength(8);
    // O primeiro vértice do primeiro adesivo: (x0 + r, 297 − y0).
    const firstVertex = lines.indexOf("VERTEX", lines.indexOf("SEQEND"));
    expect(lines.slice(firstVertex, firstVertex + 9)).toEqual(["VERTEX", "8", "CORTE", "10", "36", "20", "251.5", "30", "0"]);
  });
});

describe("gridPositions — cartão da edição (90 × 120)", () => {
  const safe = silhouetteSafeArea(PAGE_A4);
  const centerIn = { xMm: safe.xMm, yMm: 0, widthMm: safe.widthMm, heightMm: PAGE_A4.heightMm };

  it("papel fotográfico comum: 2 × 2 = 4 por folha, simétricos na página", () => {
    const positions = gridPositions({ cellWidthMm: EDITION_CARD.widthMm, cellHeightMm: EDITION_CARD.heightMm, gapMm: EDITION_CARD.gapMm, area: printableArea(PAGE_A4, PLAIN_SHEET_MARGIN_MM) });
    expect(positions).toEqual([
      { row: 0, col: 0, xMm: 12, yMm: 25.5 },
      { row: 0, col: 1, xMm: 108, yMm: 25.5 },
      { row: 1, col: 0, xMm: 12, yMm: 151.5 },
      { row: 1, col: 1, xMm: 108, yMm: 151.5 },
    ]);
    expect(210 - (108 + 90)).toBe(12);
    expect(297 - (151.5 + 120)).toBeCloseTo(25.5, 2);
  });

  it("Silhouette: uma coluna (a área útil tem 165 mm), 2 por folha com calha 4, centrados na altura; com calha 6 não cabe", () => {
    const positions = gridPositions({ cellWidthMm: EDITION_CARD.widthMm, cellHeightMm: EDITION_CARD.heightMm, gapMm: EDITION_CARD.silhouetteGapMm, area: safe, centerIn });
    expect(positions).toHaveLength(2);
    expect(positions[0].xMm).toBeCloseTo(66.61, 2);
    expect(positions.map((p) => p.yMm)).toEqual([26.5, 150.5]);
    expect(() => gridPositions({ cellWidthMm: EDITION_CARD.widthMm, cellHeightMm: EDITION_CARD.heightMm, gapMm: 6, area: safe, centerIn })).toThrow(/não cabe/);
    // O corte fica dentro da área útil; a sangria pode passar meio milímetro embaixo, longe dos "L".
    for (const p of positions) {
      expect(p.xMm).toBeGreaterThanOrEqual(safe.xMm);
      expect(p.xMm + EDITION_CARD.widthMm).toBeLessThanOrEqual(safe.xMm + safe.widthMm + 0.01);
      expect(p.yMm).toBeGreaterThanOrEqual(safe.yMm);
      expect(p.yMm + EDITION_CARD.heightMm).toBeLessThanOrEqual(safe.yMm + safe.heightMm + 0.01);
    }
    const marks = studioRegistrationMarks(PAGE_A4);
    const t = marks.thicknessMm;
    const leg = (m: typeof marks.topRight) => [
      { x0: Math.min(m.cornerXMm, m.cornerXMm + m.xDirection * m.lengthMm), x1: Math.max(m.cornerXMm, m.cornerXMm + m.xDirection * m.lengthMm), y0: m.yDirection === 1 ? m.cornerYMm : m.cornerYMm - t, y1: m.yDirection === 1 ? m.cornerYMm + t : m.cornerYMm },
      { x0: m.xDirection === 1 ? m.cornerXMm : m.cornerXMm - t, x1: m.xDirection === 1 ? m.cornerXMm + t : m.cornerXMm, y0: Math.min(m.cornerYMm, m.cornerYMm + m.yDirection * m.lengthMm), y1: Math.max(m.cornerYMm, m.cornerYMm + m.yDirection * m.lengthMm) },
    ];
    const ink = [{ x0: marks.square.xMm, y0: marks.square.yMm, x1: marks.square.xMm + marks.square.sizeMm, y1: marks.square.yMm + marks.square.sizeMm }, ...leg(marks.topRight), ...leg(marks.bottomLeft)];
    for (const p of positions) {
      const box = { x0: p.xMm - EDITION_CARD.bleedMm, y0: p.yMm - EDITION_CARD.bleedMm, x1: p.xMm + EDITION_CARD.widthMm + EDITION_CARD.bleedMm, y1: p.yMm + EDITION_CARD.heightMm + EDITION_CARD.bleedMm };
      for (const mark of ink) {
        const dx = Math.max(mark.x0 - box.x1, 0, box.x0 - mark.x1);
        const dy = Math.max(mark.y0 - box.y1, 0, box.y0 - mark.y1);
        expect(Math.hypot(dx, dy)).toBeGreaterThanOrEqual(5);
      }
    }
  });

  it("DXF dos cartões: 2 POLYLINE r 5 + PAGINA; o da carta é byte a byte o do adesivo da sacola", () => {
    const positions = gridPositions({ cellWidthMm: EDITION_CARD.widthMm, cellHeightMm: EDITION_CARD.heightMm, gapMm: EDITION_CARD.silhouetteGapMm, area: safe, centerIn });
    const dxf = rectLabelCutDxf({ page: PAGE_A4, positions, widthMm: EDITION_CARD.widthMm, heightMm: EDITION_CARD.heightMm, cornerRadiusMm: EDITION_CARD.cornerRadiusMm });
    const lines = dxf.split("\n");
    expect(lines.filter((l) => l === "POLYLINE")).toHaveLength(3);
    expect(lines.filter((l) => l === (-QUARTER_BULGE).toFixed(5))).toHaveLength(8);
    // Primeiro vértice do primeiro cartão: (x0 + r, 297 − y0) = (71.61, 270.5).
    const firstVertex = lines.indexOf("VERTEX", lines.indexOf("SEQEND"));
    expect(lines.slice(firstVertex, firstVertex + 9)).toEqual(["VERTEX", "8", "CORTE", "10", "71.61", "20", "270.5", "30", "0"]);

    expect(EDITION_LETTER).toBe(BAG_STICKER);
    const letterPositions = gridPositions({ ...cell, area: safe, centerIn });
    const letterDxf = rectLabelCutDxf({ page: PAGE_A4, positions: [letterPositions[0]], widthMm: EDITION_LETTER.widthMm, heightMm: EDITION_LETTER.heightMm, cornerRadiusMm: EDITION_LETTER.cornerRadiusMm });
    const bagDxf = rectLabelCutDxf({ page: PAGE_A4, positions: [letterPositions[0]], widthMm: BAG_STICKER.widthMm, heightMm: BAG_STICKER.heightMm, cornerRadiusMm: BAG_STICKER.cornerRadiusMm });
    expect(letterDxf).toBe(bagDxf);
  });
});
