// A malha da coleção é decidida por função pura; aqui garantimos que nenhuma
// largura deixa buraco e que o ciclo se repete.
import { describe, expect, it } from "vitest";

import { arrangeEdition, rhythmFor } from "@/lib/editorial-rhythm";

const lgSpan = (className: string) => Number(/lg:col-span-(\d)/.exec(className)![1]);
const mobileSpan = (className: string) => (/(^|\s)col-span-2(\s|$)/.test(className) ? 2 : 1);

/** Linhas do desktop: agrupa índices consecutivos até somar 12 colunas. */
function lgRows(total: number): number[][] {
  const rows: number[][] = [];
  let current: number[] = [];
  let used = 0;
  for (let index = 0; index < total; index += 1) {
    const { className } = rhythmFor(index, total);
    const span = lgSpan(className);
    const start = /lg:col-start-(\d)/.exec(className);
    const startsAt = start ? Number(start[1]) - 1 : used;
    if (startsAt + span > 12 || startsAt < used) {
      rows.push(current);
      current = [];
      used = 0;
    }
    current.push(index);
    used = (start ? Number(start[1]) - 1 : used) + span;
  }
  if (current.length) rows.push(current);
  return rows;
}

describe("rhythmFor — desktop", () => {
  it("segue 7/5 · 4/4/4 · 5/7 · 4/4/4 num ciclo completo", () => {
    const spans = Array.from({ length: 10 }, (_, i) => lgSpan(rhythmFor(i, 10).className));
    expect(spans).toEqual([7, 5, 4, 4, 4, 5, 7, 4, 4, 4]);
    expect(rhythmFor(1, 10).className).toContain("lg:pt-20");
    expect(rhythmFor(5, 10).className).toContain("lg:pt-20");
  });

  it("toda linha soma 12 colunas ou fica centrada, para 1 a 12 peças", () => {
    for (let total = 1; total <= 12; total += 1) {
      for (const row of lgRows(total)) {
        const sum = row.reduce((acc, index) => acc + lgSpan(rhythmFor(index, total).className), 0);
        if (row.length === 1 && sum === 6) {
          expect(rhythmFor(row[0], total).className).toContain("lg:col-start-4");
        } else {
          expect(sum, `total ${total}, linha ${row.join(",")}`).toBe(12);
        }
      }
    }
  });

  it("fecha a última linha sem o deslocamento vertical", () => {
    // 3 peças: 7/5 completa + a terceira centrada.
    expect(rhythmFor(2, 3).className).toBe("sm:col-span-1 sm:col-start-2 lg:col-span-6 lg:col-start-4");
    // 4 peças: 2/3 da segunda linha viram 6/6.
    expect(lgSpan(rhythmFor(2, 4).className)).toBe(6);
    expect(lgSpan(rhythmFor(3, 4).className)).toBe(6);
    // 6 peças: a posição 5 (com pt-20 no ciclo cheio) fica sozinha e centrada.
    expect(rhythmFor(5, 6).className).not.toContain("lg:pt-20");
    expect(rhythmFor(5, 6).className).toContain("lg:col-start-4");
  });

  it("repete o ciclo a cada 10", () => {
    expect(rhythmFor(10, 30)).toEqual(rhythmFor(0, 30));
    expect(rhythmFor(16, 30)).toEqual(rhythmFor(6, 30));
  });
});

describe("rhythmFor — celular", () => {
  it("nunca deixa buraco na grade de 2 colunas, para 1 a 12 peças", () => {
    for (let total = 1; total <= 12; total += 1) {
      let column = 0;
      for (let index = 0; index < total; index += 1) {
        const span = mobileSpan(rhythmFor(index, total).className);
        // Um item de 2 colunas só pode nascer no início da linha.
        expect(span === 2 && column === 1, `total ${total}, índice ${index}`).toBe(false);
        column = (column + span) % 2;
      }
      expect(column, `total ${total} termina com linha incompleta`).toBe(0);
    }
  });

  it("capas nas posições 0 e 5 têm largura total e pedem a rendição cover só onde há espaço", () => {
    expect(rhythmFor(0, 10)).toMatchObject({ size: "cover", className: expect.stringContaining("col-span-2") });
    expect(rhythmFor(5, 10)).toMatchObject({ size: "md", className: expect.stringContaining("col-span-2") });
    expect(rhythmFor(6, 10).size).toBe("cover");
    expect(rhythmFor(0, 10).sizes).toBe("(min-width: 1024px) 58vw, (min-width: 640px) 67vw, 100vw");
    expect(rhythmFor(2, 10).sizes).toBe("(min-width: 1024px) 33vw, (min-width: 640px) 33vw, 50vw");
  });

  it("rejeita índice fora do total", () => {
    expect(() => rhythmFor(3, 3)).toThrow(RangeError);
    expect(() => rhythmFor(-1, 3)).toThrow(RangeError);
  });
});

describe("arrangeEdition", () => {
  const p = (name: string, photo: boolean) => ({ name, imagePath: photo ? `${name}-full.webp` : null });

  it("traz a primeira peça com foto para a capa e preserva a ordem do resto", () => {
    const list = [p("a", false), p("b", false), p("c", true), p("d", true)];
    expect(arrangeEdition(list).map((item) => item.name)).toEqual(["c", "a", "b", "d"]);
  });

  it("não mexe quando as capas já têm foto nem quando ninguém tem", () => {
    const withPhotos = Array.from({ length: 8 }, (_, i) => p(String(i), true));
    expect(arrangeEdition(withPhotos)).toEqual(withPhotos);
    const none = [p("a", false), p("b", false)];
    expect(arrangeEdition(none)).toEqual(none);
  });

  it("preenche também as capas 5 e 6 quando há fotos mais adiante", () => {
    const list = [
      p("a", true), p("b", false), p("c", false), p("d", false), p("e", false),
      p("f", false), p("g", false), p("h", true), p("i", true), p("j", false),
    ];
    const names = arrangeEdition(list).map((item) => item.name);
    expect(names[0]).toBe("a");
    expect(names[5]).toBe("h");
    expect(names[6]).toBe("i");
    expect(names).toHaveLength(10);
    expect(names.filter((n) => !"ahi".includes(n))).toEqual(["b", "c", "d", "e", "f", "g", "j"]);
  });
});
