// A impressão digital com o sharp: hex de 16, estável ao redimensionar e ao
// reencodar, diferente entre desenhos diferentes, null para lixo.
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { hammingDistance, hexToPhash } from "@/core/images/phash";
import { imagePhash } from "@/services/image-fingerprint";

/** Um "flatlay" sintético: fundo, uma faixa escura e um quadrado claro — com estrutura, não uniforme. */
function scene(width: number, height: number, variant: "a" | "b" = "a"): string {
  const band = variant === "a" ? `<rect x="0" y="${height * 0.55}" width="${width}" height="${height * 0.25}" fill="#3b2f2f"/>` : `<rect x="${width * 0.6}" y="0" width="${width * 0.4}" height="${height}" fill="#3b2f2f"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#b08968"/>${band}<rect x="${width * 0.1}" y="${height * 0.1}" width="${width * 0.3}" height="${height * 0.3}" fill="#f5efe6"/></svg>`;
}

describe("imagePhash", () => {
  it("devolve 16 hexadecimais; a mesma cena em 1600 px (webp), 400 px (webp) e JPEG fica a ≤ 3 bits", async () => {
    const full = await sharp(Buffer.from(scene(1200, 1600))).webp().toBuffer();
    const thumb = await sharp(Buffer.from(scene(1200, 1600))).resize(300).webp().toBuffer();
    const jpeg = await sharp(Buffer.from(scene(1200, 1600))).resize(1086).jpeg({ quality: 70 }).toBuffer();
    const [a, b, c] = await Promise.all([imagePhash(full), imagePhash(thumb), imagePhash(jpeg)]);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(hammingDistance(hexToPhash(a!)!, hexToPhash(b!)!)).toBeLessThanOrEqual(3);
    expect(hammingDistance(hexToPhash(a!)!, hexToPhash(c!)!)).toBeLessThanOrEqual(3);
  });

  it("cenas diferentes ficam longe (bem acima do limiar de 10)", async () => {
    const a = await imagePhash(await sharp(Buffer.from(scene(800, 1000, "a"))).png().toBuffer());
    const b = await imagePhash(await sharp(Buffer.from(scene(800, 1000, "b"))).png().toBuffer());
    expect(hammingDistance(hexToPhash(a!)!, hexToPhash(b!)!)).toBeGreaterThan(10);
  });

  it("imagem que o sharp não abre vira null (nunca lança)", async () => {
    expect(await imagePhash(Buffer.from("isto não é uma imagem"))).toBeNull();
    expect(await imagePhash(new Uint8Array(0))).toBeNull();
  });
});
