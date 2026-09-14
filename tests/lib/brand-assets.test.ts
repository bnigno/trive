// Os assets de marca são gerados por scripts/generate-brand-assets.mjs e
// commitados; este teste segura o contrato que os componentes assumem:
// manifest com as dimensões reais dos arquivos (zero CLS), o mesmo desenho
// em todas as larguras do srcset, lockup na horizontal, o PNG que o Satori
// embute igual ao gerado e o letreiro em paths dentro da própria caixa.
import { readFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { BRAND, type BrandImage } from "@/components/store/brand/assets";
import {
  TAGLINE_LETTERING,
  WORDMARK_LETTERING,
  type Lettering,
} from "@/components/store/brand/lettering.generated";
import { isLetteringName } from "@/components/store/brand/wordmark";
import { RECEIPT_ASSETS_B64 } from "@/receipts/assets.generated";

const ROOT = process.cwd();

async function realSize(image: BrandImage): Promise<{ width: number; height: number }> {
  const { width, height } = await sharp(path.join(ROOT, "public", image.src)).metadata();
  return { width: width ?? 0, height: height ?? 0 };
}

describe("assets de marca (BRAND)", () => {
  for (const tone of ["light", "dark"] as const) {
    const { mark, lockup } = BRAND[tone];

    it(`${tone}: o manifest traz as dimensões reais de cada arquivo (zero CLS)`, async () => {
      expect(mark.length).toBeGreaterThanOrEqual(4);
      for (const variant of mark) {
        expect(variant.src).toBe(`/brand/mark-${tone}-${variant.width}.webp`);
        expect(await realSize(variant)).toEqual({ width: variant.width, height: variant.height });
      }
      expect(await realSize(lockup)).toEqual({ width: lockup.width, height: lockup.height });
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

describe("lockup embutido no Satori", () => {
  it("é o PNG 900×400 que o pipeline gerou (recibos e cartões não ficam com logo velho)", async () => {
    const generated = readFileSync(path.join(ROOT, "brand-source/generated/lockup-dark-900.png"));
    expect(RECEIPT_ASSETS_B64.lockupDarkPng).toBe(generated.toString("base64"));
    const { width, height } = await sharp(generated).metadata();
    expect({ width, height }).toEqual({ width: 900, height: 400 });
  });
});

describe("letreiro do logo (lettering.generated)", () => {
  function expectLettering(lettering: Lettering, minGlyphs: number) {
    const [x, y, width, height] = lettering.viewBox.split(" ").map(Number);
    expect(width).toBeCloseTo(lettering.width, 1);
    expect(height).toBeCloseTo(lettering.height, 1);
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
    expect(lettering.capHeight).toBeGreaterThan(height / 2);
    expect(lettering.capHeight).toBeLessThan(height);
    expect(lettering.glyphs.length).toBeGreaterThanOrEqual(minGlyphs);
    // A caixa vem do raster e os glifos do XML: a origem de cada glifo (o
    // pé da letra, na linha de base) tem que cair dentro dela — se o gerador
    // medir a caixa em outro espaço, o letreiro some e este teste acusa.
    for (const glyph of lettering.glyphs) {
      expect(glyph.d).toMatch(/^M/);
      expect(glyph.d).not.toMatch(/\s{2,}/);
      expect(glyph.x).toBeGreaterThanOrEqual(x - 5);
      expect(glyph.x).toBeLessThan(x + width);
      expect(glyph.y).toBeGreaterThan(y);
      expect(glyph.y).toBeLessThanOrEqual(y + height + 1);
    }
    const first = lettering.glyphs[0]!;
    const last = lettering.glyphs[lettering.glyphs.length - 1]!;
    expect(last.x - first.x).toBeGreaterThan(width * 0.6);
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
