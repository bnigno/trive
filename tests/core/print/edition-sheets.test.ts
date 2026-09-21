// Os cartões da edição e a carta na folha (puro): 4 por A4 com a carta numa
// folha mista; 2 por folha na Silhouette com a carta sozinha; só quem tem
// imagem entra; a ordem das peças é preservada.
import { describe, expect, it } from "vitest";

import { editionSheetLayout, planEditionSheets, type EditionSheetItemInput } from "@/core/print/edition-sheets";

const card = (n: number, url: string | null = `https://cdn/c${n}.jpg`): EditionSheetItemInput => ({ key: `c${n}`, kind: "card", url, alt: `Cartão ${n}` });
const LETTER: EditionSheetItemInput = { key: "carta", kind: "letter", url: "https://cdn/carta.jpg", alt: "Carta" };
const cards = (n: number) => Array.from({ length: n }, (_, i) => card(i + 1));

describe("editionSheetLayout", () => {
  it("A4: 4 cartões (2 × 2) e a carta na posição do adesivo da sacola; a linha de baixo divide a folha com a carta", () => {
    const layout = editionSheetLayout("a4");
    expect(layout.cardPositions.map((p) => [p.xMm, p.yMm])).toEqual([
      [12, 25.5],
      [108, 25.5],
      [12, 151.5],
      [108, 151.5],
    ]);
    expect(layout.letterPosition).toEqual({ row: 0, col: 0, xMm: 30, yMm: 45.5 });
    expect(layout.mixedCardPositions.map((p) => [p.xMm, p.yMm])).toEqual([
      [12, 151.5],
      [108, 151.5],
    ]);
    // Carta (45,5 → 145,5) e cartões (151,5): calha de 6 mm entre eles.
    expect(151.5 - (45.5 + 100)).toBe(6);
  });

  it("Silhouette: 2 cartões (1 × 2, centrados na altura), carta na posição do adesivo, sem folha mista", () => {
    const layout = editionSheetLayout("silhouette");
    expect(layout.cardPositions).toHaveLength(2);
    expect(layout.cardPositions[0].xMm).toBeCloseTo(66.61, 2);
    expect(layout.cardPositions.map((p) => p.yMm)).toEqual([26.5, 150.5]);
    expect(297 - (150.5 + 120)).toBeCloseTo(26.5, 2);
    expect(layout.letterPosition?.yMm).toBe(45.5);
    expect(layout.letterPosition?.xMm).toBeCloseTo(36.61, 2);
    // O corte da carta é a grade inteira do adesivo (2 células, simétricas na altura: 45,5 e 151,5).
    expect(layout.letterCutPositions.map((p) => p.yMm)).toEqual([45.5, 151.5]);
    expect(layout.mixedCardPositions).toEqual([]);
  });
});

describe("planEditionSheets — A4", () => {
  it("carta + 5 cartões: folha mista (carta + 2) e uma folha com 3, na ordem das peças", () => {
    const sheets = planEditionSheets({ letter: LETTER, cards: cards(5), format: "a4" });
    expect(sheets.map((s) => [s.kind, s.items.map((i) => i.key)])).toEqual([
      ["mixed", ["carta", "c1", "c2"]],
      ["cards", ["c3", "c4", "c5"]],
    ]);
    const [mixed, rest] = sheets;
    expect(mixed.items[0]).toMatchObject({ kind: "letter", xMm: 30, yMm: 45.5, widthMm: 150, heightMm: 100, cornerRadiusMm: 6, bleedMm: 1, url: "https://cdn/carta.jpg" });
    expect(mixed.items.slice(1).map((i) => [i.xMm, i.yMm])).toEqual([
      [12, 151.5],
      [108, 151.5],
    ]);
    expect(rest.items.map((i) => [i.xMm, i.yMm])).toEqual([
      [12, 25.5],
      [108, 25.5],
      [12, 151.5],
    ]);
    expect(rest.items[0]).toMatchObject({ kind: "card", widthMm: 90, heightMm: 120, cornerRadiusMm: 5, bleedMm: 1 });
  });

  it("sem carta: folhas de 4; 9 cartões = 4 + 4 + 1; só a carta = folha 'letter'; nada = nenhuma folha", () => {
    expect(planEditionSheets({ letter: null, cards: cards(9), format: "a4" }).map((s) => [s.kind, s.items.length])).toEqual([
      ["cards", 4],
      ["cards", 4],
      ["cards", 1],
    ]);
    expect(planEditionSheets({ letter: LETTER, cards: [], format: "a4" }).map((s) => [s.kind, s.items.map((i) => i.key)])).toEqual([["letter", ["carta"]]]);
    expect(planEditionSheets({ letter: null, cards: [], format: "a4" })).toEqual([]);
  });

  it("itens sem imagem ficam de fora (carta escrita depois, peça nova) — a ordem dos demais não muda", () => {
    const sheets = planEditionSheets({ letter: { ...LETTER, url: null }, cards: [card(1), card(2, null), card(3)], format: "a4" });
    expect(sheets.map((s) => [s.kind, s.items.map((i) => i.key)])).toEqual([["cards", ["c1", "c3"]]]);
    expect(planEditionSheets({ letter: { ...LETTER, url: null }, cards: [card(1, null)], format: "a4" })).toEqual([]);
  });
});

describe("planEditionSheets — vales (15×10 como a carta)", () => {
  const vale = (key: string): EditionSheetItemInput => ({ key, kind: "letter", url: `https://cdn/${key}.jpg`, alt: key });

  it("A4: carta + 2 vales + 5 cartões = mista (carta + 2), uma folha com os 2 vales (grade do adesivo) e uma com 3 cartões", () => {
    const sheets = planEditionSheets({ letter: LETTER, letters: [vale("vale-voce"), vale("vale-amiga")], cards: cards(5), format: "a4" });
    expect(sheets.map((s) => [s.kind, s.items.map((i) => i.key)])).toEqual([
      ["mixed", ["carta", "c1", "c2"]],
      ["letter", ["vale-voce", "vale-amiga"]],
      ["cards", ["c3", "c4", "c5"]],
    ]);
    // Os dois vales caem nas duas células do adesivo da sacola.
    expect(sheets[1].items.map((i) => [i.xMm, i.yMm, i.widthMm, i.heightMm])).toEqual([
      [30, 45.5, 150, 100],
      [30, 151.5, 150, 100],
    ]);
  });

  it("sem carta: o primeiro vale vai na mista (A4); na Silhouette (e sem cartões) as 15×10 vão de 2 em 2", () => {
    expect(planEditionSheets({ letters: [vale("vale-voce"), vale("vale-amiga")], cards: cards(2), format: "a4" }).map((s) => [s.kind, s.items.map((i) => i.key)])).toEqual([
      ["mixed", ["vale-voce", "c1", "c2"]],
      ["letter", ["vale-amiga"]],
    ]);
    // Silhouette (e A4 sem cartões para a linha de baixo): as 15×10 de 2 em 2 desde a primeira.
    expect(planEditionSheets({ letters: [vale("a"), vale("b"), vale("c")], cards: [], format: "silhouette" }).map((s) => [s.kind, s.items.map((i) => i.key)])).toEqual([
      ["letter", ["a", "b"]],
      ["letter", ["c"]],
    ]);
    expect(planEditionSheets({ letter: LETTER, letters: [vale("a")], cards: [], format: "a4" }).map((s) => [s.kind, s.items.map((i) => i.key)])).toEqual([["letter", ["carta", "a"]]]);
  });
});

describe("planEditionSheets — Silhouette", () => {
  it("carta sozinha na primeira folha, depois os cartões de 2 em 2", () => {
    const sheets = planEditionSheets({ letter: LETTER, cards: cards(3), format: "silhouette" });
    expect(sheets.map((s) => [s.kind, s.items.map((i) => i.key)])).toEqual([
      ["letter", ["carta"]],
      ["cards", ["c1", "c2"]],
      ["cards", ["c3"]],
    ]);
    expect(sheets[0].items[0]).toMatchObject({ yMm: 45.5, widthMm: 150, heightMm: 100 });
    expect(sheets[0].items[0].xMm).toBeCloseTo(36.61, 2);
    expect(sheets[1].items.map((i) => i.yMm)).toEqual([26.5, 150.5]);
    expect(sheets[1].items[0].xMm).toBeCloseTo(66.61, 2);
  });

  it("sem carta: só folhas de 2", () => {
    expect(planEditionSheets({ letter: null, cards: cards(4), format: "silhouette" }).map((s) => [s.kind, s.items.length])).toEqual([
      ["cards", 2],
      ["cards", 2],
    ]);
  });
});
