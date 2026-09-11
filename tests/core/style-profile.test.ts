import { describe, expect, it } from "vitest";

import { swatchHex, swatchInk } from "@/core/style/colors";
import {
  EMPTY_PROFILE,
  isProfileEmpty,
  mergeStyleProfile,
  paletteName,
  renderProfileNote,
  sizeKeyForCategory,
  styleProfileSchema,
} from "@/core/style/profile";

describe("mergeStyleProfile", () => {
  it("campo ausente no patch não apaga; tamanhos somam; cor amada sai das evitadas", () => {
    const first = mergeStyleProfile(EMPTY_PROFILE, { sizes: { vestido: "M" }, colorsAvoid: ["Verde", "Amarelo"], fit: "fluido" });
    expect(first).toEqual({ sizes: { vestido: "M" }, colorsLove: [], colorsAvoid: ["Verde", "Amarelo"], fit: "fluido", occasions: [], buysFor: null });
    const second = mergeStyleProfile(first, { sizes: { calca: "40" }, colorsLove: ["verde", "Terracota", "terracota"], occasions: ["casamento", "casamento"] });
    expect(second.sizes).toEqual({ vestido: "M", calca: "40" });
    expect(second.colorsLove).toEqual(["verde", "Terracota"]);
    expect(second.colorsAvoid).toEqual(["Amarelo"]);
    expect(second.fit).toBe("fluido");
    expect(second.occasions).toEqual(["casamento"]);
    const third = mergeStyleProfile(second, { colorsAvoid: ["Terracota"] });
    expect(third.colorsLove).toEqual(["verde"]);
    expect(third.colorsAvoid).toEqual(["Terracota"]);
  });

  it("valida os enums e limita as listas", () => {
    expect(() => styleProfileSchema.parse({ fit: "apertado" })).toThrow();
    expect(styleProfileSchema.parse({ colorsLove: Array.from({ length: 8 }, (_, i) => `c${i}`) }).colorsLove).toHaveLength(8);
    expect(() => styleProfileSchema.parse({ colorsLove: Array.from({ length: 9 }, (_, i) => `c${i}`) })).toThrow();
    expect(isProfileEmpty(EMPTY_PROFILE)).toBe(true);
    expect(isProfileEmpty(mergeStyleProfile(EMPTY_PROFILE, { buysFor: "presente" }))).toBe(false);
  });
});

describe("paletteName", () => {
  it("é determinístico pela primeira cor amada e pelo caimento", () => {
    expect(paletteName(mergeStyleProfile(EMPTY_PROFILE, { colorsLove: ["Terracota"], fit: "fluido" }))).toBe("Terra fluida");
    expect(paletteName(mergeStyleProfile(EMPTY_PROFILE, { colorsLove: ["Preto"], fit: "justo" }))).toBe("Noite precisa");
    expect(paletteName(mergeStyleProfile(EMPTY_PROFILE, { colorsLove: ["Areia"] }))).toBe("Areia livre");
    expect(paletteName(mergeStyleProfile(EMPTY_PROFILE, { colorsLove: ["Magenta neon"] }))).toBe("Cor própria livre");
    expect(paletteName(mergeStyleProfile(EMPTY_PROFILE, { fit: "fluido" }))).toBe("Silhueta fluida");
    expect(paletteName(EMPTY_PROFILE)).toBe("Cartela em aberto");
  });
});

describe("sizeKeyForCategory / renderProfileNote", () => {
  it("mapeia a família da peça para a chave de tamanho", () => {
    expect(sizeKeyForCategory("Vestuário", "LONGO DUNAS")).toBe("vestido");
    expect(sizeKeyForCategory("Vestuário", "Camiseta Essencial")).toBe("blusa");
    expect(sizeKeyForCategory(null, "Blazer Alfaiataria")).toBe("blusa");
    expect(sizeKeyForCategory("Vestuário", "Calça Pantalona")).toBe("calca");
    expect(sizeKeyForCategory("Acessórios", "Bolsa Tote")).toBeNull();
    expect(sizeKeyForCategory("Casa", "Caneca")).toBeNull();
  });

  it("escreve a nota do caderninho numa linha, ou nada", () => {
    expect(renderProfileNote(EMPTY_PROFILE)).toEqual([]);
    const profile = mergeStyleProfile(EMPTY_PROFILE, {
      sizes: { vestido: "M", calca: "40" },
      colorsLove: ["Terracota"],
      colorsAvoid: ["Amarelo"],
      fit: "fluido",
      occasions: ["casamento", "dia_a_dia"],
      buysFor: "os_dois",
    });
    expect(renderProfileNote(profile, "Terra fluida")).toEqual([
      'Cartela de estilo "Terra fluida": veste vestidos M, calças/saias 40; ama Terracota; evita Amarelo; caimento mais fluido; ocasiões: casamento, dia a dia; compra para ela e para presentear — use o tamanho como filtro sem perguntar de novo.',
    ]);
  });
});

describe("swatches", () => {
  it("mapeia nomes de cor para hex e escolhe a tinta legível", () => {
    expect(swatchHex("Preto")).toBe("#141210");
    expect(swatchHex("verde militar")).toBe("#6b6f3f");
    expect(swatchHex("Azul Marinho")).toBe("#1f2a44");
    expect(swatchHex("Estampado floral")).toBe("#9c8b74");
    expect(swatchHex("Xyz")).toBeNull();
    expect(swatchInk("#f5f1e8")).toBe("#141210");
    expect(swatchInk("#141210")).toBe("#faf7f0");
  });
});
