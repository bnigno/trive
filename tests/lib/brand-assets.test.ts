// Os assets de marca são gerados por scripts/generate-brand-assets.mjs e
// commitados; este teste segura o contrato que os componentes assumem:
// manifest com as dimensões reais dos arquivos (zero CLS), o mesmo desenho
// em todas as larguras do srcset, lockup na horizontal e o letreiro em paths.
import { statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { BRAND } from "@/components/store/brand/assets";
import {
  TAGLINE_LETTERING,
  WORDMARK_LETTERING,
  type Lettering,
} from "@/components/store/brand/lettering.generated";
import { isLetteringName } from "@/components/store/brand/wordmark";

const PUBLIC = path.join(process.cwd(), "public");

function sizeOf(src: string): number {
  return statSync(path.join(PUBLIC, src)).size;
}

describe("assets de marca (BRAND)", () => {
  for (const tone of ["light", "dark"] as const) {
    const { mark, lockup } = BRAND[tone];

    it(`${tone}: cada variante do monograma existe e a largura bate com o nome`, () => {
      expect(mark.length).toBeGreaterThanOrEqual(4);
      for (const variant of mark) {
        expect(variant.src).toBe(`/brand/mark-${tone}-${variant.width}.webp`);
        expect(sizeOf(variant.src)).toBeGreaterThan(500);
      }
      expect(sizeOf(lockup.src)).toBeGreaterThan(5000);
    });

    it(`${tone}: o srcset é o mesmo desenho (proporção igual, do menor para o maior)`, () => {
      const ratio = mark[0].height / mark[0].width;
      for (const variant of mark) {
        expect(Math.abs(variant.height / variant.width - ratio)).toBeLessThan(0.02);
      }
      const widths = mark.map((variant) => variant.width);
      expect(widths).toEqual([...widths].sort((a, b) => a - b));
    });

    it(`${tone}: o lockup é horizontal, na faixa que recibos e OG assumem`, () => {
      const ratio = lockup.width / lockup.height;
      expect(ratio).toBeGreaterThan(2);
      expect(ratio).toBeLessThan(3);
    });
  }
});

describe("letreiro do logo (lettering.generated)", () => {
  function expectLettering(lettering: Lettering, minGlyphs: number) {
    const box = lettering.viewBox.split(" ").map(Number);
    expect(box).toHaveLength(4);
    expect(box[2]).toBeCloseTo(lettering.width, 1);
    expect(box[3]).toBeCloseTo(lettering.height, 1);
    expect(lettering.width).toBeGreaterThan(0);
    expect(lettering.height).toBeGreaterThan(0);
    expect(lettering.glyphs.length).toBeGreaterThanOrEqual(minGlyphs);
    for (const glyph of lettering.glyphs) {
      expect(glyph.d).toMatch(/^M/);
      expect(glyph.d).not.toMatch(/\s{2,}/);
    }
  }

  it("TRIVÉ: 5 letras em path, mais largo do que alto", () => {
    expectLettering(WORDMARK_LETTERING, 5);
    expect(WORDMARK_LETTERING.width / WORDMARK_LETTERING.height).toBeGreaterThan(2.5);
  });

  it("MAISON FÉMININE: 14 letras em path (o espaço não é glifo)", () => {
    expectLettering(TAGLINE_LETTERING, 14);
    expect(TAGLINE_LETTERING.width / TAGLINE_LETTERING.height).toBeGreaterThan(6);
  });

  it("o letreiro vale para TRIVÉ em qualquer grafia do acento; outro nome cai no texto", () => {
    expect(isLetteringName("TRIVÉ")).toBe(true);
    expect(isLetteringName(" trivé ")).toBe(true);
    expect(isLetteringName("TRIVE\u0301")).toBe(true);
    expect(isLetteringName("TRIVË")).toBe(true);
    expect(isLetteringName("Trive")).toBe(true);
    expect(isLetteringName("Maison TRIVÉ")).toBe(false);
    expect(isLetteringName("TRIVÉ Store")).toBe(false);
    expect(isLetteringName("")).toBe(false);
  });
});
