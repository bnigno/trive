// Etiqueta dupla ("38/40") é UMA peça que veste os dois: a leitura casa
// qualquer um dos tamanhos e a ordem põe a dupla logo depois do primeiro.
import { describe, expect, it } from "vitest";

import { compareSizeLabels, findSizeAxis, sizeMatches, sizeTokens } from "@/core/catalog/sizes";

describe("sizeTokens", () => {
  it("separa a etiqueta dupla por barra ou hífen; simples fica inteiro", () => {
    expect(sizeTokens("38/40")).toEqual(["38", "40"]);
    expect(sizeTokens("P/M")).toEqual(["P", "M"]);
    expect(sizeTokens("38-40")).toEqual(["38", "40"]);
    expect(sizeTokens(" 38 / 40 ")).toEqual(["38", "40"]);
    expect(sizeTokens("38")).toEqual(["38"]);
    expect(sizeTokens("Único")).toEqual(["Único"]);
    expect(sizeTokens("")).toEqual([]);
  });
});

describe("sizeMatches", () => {
  it("a dupla serve quem pede qualquer um dos dois, ou a própria etiqueta", () => {
    expect(sizeMatches("38/40", "38")).toBe(true);
    expect(sizeMatches("38/40", "40")).toBe(true);
    expect(sizeMatches("38/40", "38/40")).toBe(true);
    expect(sizeMatches("38/40", "42")).toBe(false);
    expect(sizeMatches("P/M", "m")).toBe(true);
    expect(sizeMatches("38", "38")).toBe(true);
    expect(sizeMatches("38", "40")).toBe(false);
    expect(sizeMatches("Único", "unico")).toBe(true);
    expect(sizeMatches("38", "")).toBe(false);
  });
});

describe("compareSizeLabels", () => {
  it("letras, depois números, depois o resto — a dupla logo depois do primeiro tamanho", () => {
    expect(["40", "38/40", "36", "38", "36/38", "P/M", "P", "M", "Único"].sort(compareSizeLabels)).toEqual([
      "P",
      "P/M",
      "M",
      "36",
      "36/38",
      "38",
      "38/40",
      "40",
      "Único",
    ]);
  });

  it("acha o eixo de tamanho sem diferenciar caixa", () => {
    expect(findSizeAxis(["cor", "Tamanho"])).toBe("Tamanho");
    expect(findSizeAxis(["cor"])).toBeNull();
  });
});
