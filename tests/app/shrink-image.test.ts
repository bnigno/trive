// A parte pura de reduzir a foto no navegador: o encaixe no lado maior e a
// decisão "ainda passa do teto da Vercel → o que dizer para a dona".
import { describe, expect, it } from "vitest";

import { fitWithin, SHRINK_MAX_EDGE, UPLOAD_MAX_BYTES, uploadBlocker } from "@/components/admin/shrink-image";

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

describe("uploadBlocker", () => {
  it("cabe no teto: sobe; reduzida e ainda grande: outra foto; não reduzida (HEIC): converter", () => {
    expect(UPLOAD_MAX_BYTES).toBeLessThan(4.5 * 1024 * 1024);
    expect(uploadBlocker(UPLOAD_MAX_BYTES, true)).toBeNull();
    expect(uploadBlocker(300 * 1024, false)).toBeNull();
    expect(uploadBlocker(UPLOAD_MAX_BYTES + 1, true)).toMatch(/grande demais mesmo reduzida/);
    expect(uploadBlocker(6 * 1024 * 1024, false)).toMatch(/HEIC/);
    expect(uploadBlocker(6 * 1024 * 1024, false)).toMatch(/Mais compatível/);
  });
});
