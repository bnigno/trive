// A parte pura de reduzir a foto no navegador: o encaixe no lado maior e a
// decisão "ainda passa do teto da Vercel → o que dizer para a dona".
import { describe, expect, it } from "vitest";

import { fitWithin, looksLikeHeic, SHRINK_MAX_EDGE, UPLOAD_MAX_BYTES, uploadBlocker } from "@/components/admin/shrink-image";

describe("fitWithin", () => {
  it("reduz pelo lado maior mantendo a proporção; não amplia; nunca abaixo de 1 px", () => {
    expect(fitWithin(4032, 3024, SHRINK_MAX_EDGE)).toEqual({ width: 1600, height: 1200 });
    expect(fitWithin(3024, 4032, SHRINK_MAX_EDGE)).toEqual({ width: 1200, height: 1600 });
    expect(fitWithin(800, 600, SHRINK_MAX_EDGE)).toEqual({ width: 800, height: 600 });
    expect(fitWithin(1600, 1, SHRINK_MAX_EDGE)).toEqual({ width: 1600, height: 1 });
    expect(fitWithin(10000, 1, SHRINK_MAX_EDGE)).toEqual({ width: 1600, height: 1 });
    expect(fitWithin(0, 0, SHRINK_MAX_EDGE)).toEqual({ width: 1, height: 1 });
  });
});

const jpg = (size: number) => ({ name: "foto.jpg", type: "image/jpeg", size });
const heic = (size: number) => ({ name: "IMG_9299.heic", type: "", size });

describe("uploadBlocker", () => {
  it("cabe no teto: sobe; reduzida e ainda grande: outra foto; não reduzida: exportar JPEG", () => {
    expect(UPLOAD_MAX_BYTES).toBeLessThan(4.5 * 1024 * 1024);
    expect(uploadBlocker({ file: jpg(UPLOAD_MAX_BYTES), shrunk: true })).toBeNull();
    expect(uploadBlocker({ file: jpg(300 * 1024), shrunk: false })).toBeNull();
    expect(uploadBlocker({ file: jpg(UPLOAD_MAX_BYTES + 1), shrunk: true })).toMatch(/grande demais mesmo reduzida/);
    expect(uploadBlocker({ file: jpg(6 * 1024 * 1024), shrunk: false })).toMatch(/exportar como JPEG/);
  });

  it("HEIC que não abriu nem no WASM nunca vai ao servidor (o sharp também não lê), mesmo pequeno", () => {
    expect(uploadBlocker({ file: heic(900 * 1024), shrunk: false })).toMatch(/HEIC/);
    expect(uploadBlocker({ file: heic(900 * 1024), shrunk: false })).toMatch(/Mais compatível/);
    // Convertido (virou .jpg): segue normal.
    expect(uploadBlocker({ file: jpg(900 * 1024), shrunk: true })).toBeNull();
  });
});

describe("looksLikeHeic", () => {
  it("pelo nome ou pelo tipo; o Chrome entrega HEIC com type vazio", () => {
    expect(looksLikeHeic({ name: "IMG_9299.heic", type: "" })).toBe(true);
    expect(looksLikeHeic({ name: "IMG_9299.HEIF", type: "" })).toBe(true);
    expect(looksLikeHeic({ name: "blob", type: "image/heic" })).toBe(true);
    expect(looksLikeHeic({ name: "foto.jpg", type: "image/jpeg" })).toBe(false);
  });
});
