import { describe, expect, it } from "vitest";

import {
  buildSizeChart,
  columnsPresent,
  compareSizeLabels,
  findSizeAxis,
  isSizeChartEmpty,
  measurementsSchema,
  parseMeasurements,
  renderSizeChartLines,
} from "@/core/catalog/measurements";

describe("medidas", () => {
  it("schema aceita cm inteiros ou meio cm entre 1 e 300 e rejeita o resto", () => {
    expect(measurementsSchema.safeParse({ bust: 88, waist: 70.5 }).success).toBe(true);
    expect(measurementsSchema.safeParse({ bust: 0 }).success).toBe(false);
    expect(measurementsSchema.safeParse({ bust: -5 }).success).toBe(false);
    expect(measurementsSchema.safeParse({ bust: 301 }).success).toBe(false);
    expect(measurementsSchema.safeParse({ bust: 88.3 }).success).toBe(false);
    expect(measurementsSchema.safeParse({ bust: "88" }).success).toBe(false);
  });

  it("parse tolerante: nulo, torto ou vazio vira null; válido vira objeto compacto", () => {
    expect(parseMeasurements(null)).toBeNull();
    expect(parseMeasurements("x")).toBeNull();
    expect(parseMeasurements({})).toBeNull();
    expect(parseMeasurements({ bust: 88, waist: undefined })).toEqual({ bust: 88 });
  });

  it("ordem de tamanhos: PP<P<M<G<GG<XG<XGG, depois números, depois letras", () => {
    expect(["G", "PP", "M", "40", "38", "Único", "P"].sort(compareSizeLabels)).toEqual([
      "PP",
      "P",
      "M",
      "G",
      "38",
      "40",
      "Único",
    ]);
    expect(findSizeAxis(["cor", "Tamanho"])).toBe("Tamanho");
    expect(findSizeAxis(["cor"])).toBeNull();
  });

  it("tabela: uma linha por tamanho, cores compartilham, ordenada, só quem tem medida", () => {
    const chart = buildSizeChart(
      [
        { attributes: { cor: "Preto", tamanho: "M" }, measurements: { bust: 92, waist: 74 } },
        { attributes: { cor: "Areia", tamanho: "M" }, measurements: { bust: 999 } },
        { attributes: { cor: "Preto", tamanho: "P" }, measurements: { bust: 88, length: 110 } },
        { attributes: { cor: "Preto", tamanho: "G" }, measurements: null },
      ],
      ["cor", "tamanho"],
    );
    expect(chart).toEqual([
      { size: "P", measurements: { bust: 88, length: 110 } },
      { size: "M", measurements: { bust: 92, waist: 74 } },
    ]);
    expect(columnsPresent(chart)).toEqual(["bust", "waist", "length"]);
    expect(isSizeChartEmpty(chart)).toBe(false);
    expect(isSizeChartEmpty(buildSizeChart([{ attributes: {}, measurements: null }], []))).toBe(true);
  });

  it("sem eixo de tamanho a linha é 'Único'", () => {
    expect(buildSizeChart([{ attributes: { cor: "Preto" }, measurements: { length: 40 } }], ["cor"])).toEqual([
      { size: "Único", measurements: { length: 40 } },
    ]);
  });

  it("texto para a Lia, com vírgula decimal, e vazio quando não há tabela", () => {
    expect(
      renderSizeChartLines([
        { size: "P", measurements: { bust: 88, waist: 70.5 } },
        { size: "M", measurements: { bust: 92 } },
      ]),
    ).toEqual([
      "Tabela de medidas da peça (cm, peça deitada):",
      "P — busto 88, cintura 70,5",
      "M — busto 92",
    ]);
    expect(renderSizeChartLines([])).toEqual([]);
  });
});
