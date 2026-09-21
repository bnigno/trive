// Desenho real do vale de papel: PNG 1080×720, sem rede, os dois tipos.
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { VoucherCardData } from "@/core/edition/voucher";
import { loadReceiptAssets } from "@/receipts/assets";
import { renderVoucherPng, VOUCHER_HEIGHT, VOUCHER_WIDTH } from "@/receipts/render-voucher";

const originalFetch = globalThis.fetch;
const networkCalls: string[] = [];

beforeEach(() => {
  networkCalls.length = 0;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    if (/^https?:/i.test(url)) networkCalls.push(url);
    return Promise.reject(new Error(`rede proibida no vale: ${url}`));
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const base: VoucherCardData = {
  kind: "para_voce",
  code: "MARIA-K7X2M",
  percent: 10,
  expiresLabel: "até 05/11",
  firstName: "Maria",
  storeName: "TRIVÉ",
  editionName: "Edição Círio",
  qrUrl: "https://wa.me/5591999990000?text=Oi%2C%20Lia!%20Tenho%20o%20vale%20MARIA-K7X2M",
};

async function check(png: Buffer) {
  const image = sharp(png);
  const metadata = await image.metadata();
  expect(metadata.format).toBe("png");
  expect(metadata.width).toBe(VOUCHER_WIDTH);
  expect(metadata.height).toBe(VOUCHER_HEIGHT);
  const raw = await image.raw().toBuffer({ resolveWithObject: true });
  const pixel = (x: number, y: number) => {
    const offset = (y * raw.info.width + x) * raw.info.channels;
    return [raw.data[offset], raw.data[offset + 1], raw.data[offset + 2]];
  };
  // Papel marfim no canto e faixa noir embaixo.
  const [r, g] = pixel(60, 60);
  expect(r).toBeGreaterThan(235);
  expect(g).toBeGreaterThan(235);
  const [nr, ng, nb] = pixel(540, VOUCHER_HEIGHT - 60);
  expect(nr + ng + nb).toBeLessThan(60);
  expect(networkCalls).toEqual([]);
}

describe("renderVoucherPng", () => {
  it("para você e para uma amiga: 1080×720, marfim, faixa noir, sem rede", async () => {
    const assets = await loadReceiptAssets();
    await check(await renderVoucherPng(base, assets));
    await check(await renderVoucherPng({ ...base, kind: "para_uma_amiga", code: "AMIGA-K7X2M", percent: 15, editionName: null }, assets));
  }, 60_000);
});
