// O QR em vetor: o path cobre os módulos escuros e, desenhado com a zona de
// silêncio, um leitor devolve o endereço.
import jsQR from "jsqr";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { qrSvgPath, qrVersion } from "@/receipts/qr";

const URL_PECA = "https://trivemaison.com.br/produto/longo-dunas-areia";

describe("qrSvgPath", () => {
  it("versão 4 (33 módulos) para o endereço de uma peça; path determinístico", () => {
    const qr = qrSvgPath(URL_PECA);
    expect(qrVersion(URL_PECA)).toBe(4);
    expect(qr.size).toBe(33);
    expect(qr.d.startsWith("M")).toBe(true);
    expect(qr.d).toBe(qrSvgPath(URL_PECA).d);
    // O padrão de localização do canto: 7 módulos escuros na primeira linha.
    expect(qr.d.startsWith("M0 0h7v1h-7z")).toBe(true);
  });

  it("desenhado em SVG com 4 módulos de folga, o leitor devolve o endereço", async () => {
    const { size, d } = qrSvgPath(URL_PECA);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-4 -4 ${size + 8} ${size + 8}" width="${(size + 8) * 8}" height="${(size + 8) * 8}"><rect x="-4" y="-4" width="${size + 8}" height="${size + 8}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
    const { data, info } = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const decoded = jsQR(new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), info.width, info.height);
    expect(decoded?.data).toBe(URL_PECA);
  });
});
