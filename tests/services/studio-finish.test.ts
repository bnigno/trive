// Acabamento da foto gerada: sai JPEG no tamanho das fotos reais (sem
// aumentar foto pequena), com grão e vinheta aplicados — a imagem muda, a
// proporção não.
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { FINISH_PRESET } from "@/core/studio/finish";
import { finishStudioImage } from "@/services/studio-finish";

async function flatImage(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 120, g: 140, b: 160 } } }).png().toBuffer();
}

describe("finishStudioImage", () => {
  it("reduz ao maior lado do preset, mantém a proporção e devolve JPEG", async () => {
    const out = await finishStudioImage(await flatImage(2000, 3000));
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.height).toBe(FINISH_PRESET.maxEdge);
    expect(meta.width).toBe(Math.round((FINISH_PRESET.maxEdge * 2000) / 3000));
  });

  it("não aumenta foto menor que o teto", async () => {
    const out = await finishStudioImage(await flatImage(864, 1296));
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(864);
    expect(meta.height).toBe(1296);
  });

  it("grão e vinheta mudam os pixels; sem eles a imagem lisa continua lisa", async () => {
    const source = await flatImage(300, 400);
    const withGrain = await finishStudioImage(source);
    const stats = await sharp(withGrain).stats();
    // Imagem lisa teria desvio-padrão ~0; o grão e a vinheta o tiram do zero.
    expect(stats.channels[0]?.stdev ?? 0).toBeGreaterThan(1);
    const plain = await finishStudioImage(source, { ...FINISH_PRESET, grainSigma: 0, vignette: 0 });
    const plainStats = await sharp(plain).stats();
    expect(plainStats.channels[0]?.stdev ?? 99).toBeLessThan(1);
  });
});
