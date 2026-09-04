// Smoke do desenho real do comprovante: PNG 1080×1350 com os assets
// embutidos e sem nenhuma ida à rede (fetch stubado para lançar).
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ReceiptData } from "@/core/receipts/types";
import { loadReceiptAssets } from "@/receipts/assets";
import {
  RECEIPT_HEIGHT,
  RECEIPT_WIDTH,
  renderReceiptPng,
} from "@/receipts/render";

const data: ReceiptData = {
  orderNumber: 1023,
  paidAt: new Date("2026-09-04T14:30:00-03:00"),
  paymentLabel: "Pix",
  items: [
    { name: "Vestido Ébano", sku: "VE-38", quantity: 1, unitPriceCents: 28900, totalCents: 28900 },
    { name: "Camiseta Essencial", sku: "CE-M", quantity: 2, unitPriceCents: 4490, totalCents: 8980 },
  ],
  subtotalCents: 37880,
  discountCents: 1000,
  shippingCents: 0,
  totalCents: 36880,
  storeName: "TRIVÉ",
  storeCnpj: "12.345.678/0001-90",
};

const originalFetch = globalThis.fetch;
// Toda chamada de rede falha; as de http(s) ficam registradas. (O loader do
// yoga.wasm tenta fetch de um caminho local e cai no fs quando falha — isso
// não é rede e é esperado.)
const networkCalls: string[] = [];

beforeEach(() => {
  networkCalls.length = 0;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    if (/^https?:/i.test(url)) networkCalls.push(url);
    return Promise.reject(new Error(`rede proibida no comprovante: ${url}`));
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("renderReceiptPng", () => {
  it("gera um PNG 1080×1350 com os assets embutidos, sem rede", async () => {
    const assets = await loadReceiptAssets();
    expect(assets.fonts).toHaveLength(4);
    expect(assets.lockupDarkPng.length).toBeGreaterThan(1000);

    const png = await renderReceiptPng(data, assets);
    const metadata = await sharp(png).metadata();
    expect(metadata.format).toBe("png");
    expect(metadata.width).toBe(RECEIPT_WIDTH);
    expect(metadata.height).toBe(RECEIPT_HEIGHT);

    // Faixa noir em cima, papel marfim embaixo: a imagem não está em branco.
    const { data: pixels, info } = await sharp(png)
      .raw()
      .toBuffer({ resolveWithObject: true });
    const pixelAt = (x: number, y: number) => {
      const offset = (y * info.width + x) * info.channels;
      return [pixels[offset], pixels[offset + 1], pixels[offset + 2]];
    };
    expect(pixelAt(20, 20)[0]).toBeLessThan(40);
    expect(pixelAt(20, RECEIPT_HEIGHT - 20)[0]).toBeGreaterThan(230);
    expect(networkCalls).toEqual([]);
  }, 30_000);

  it("um pedido com muitas peças e sem CNPJ também cabe", async () => {
    const assets = await loadReceiptAssets();
    const many: ReceiptData = {
      ...data,
      storeCnpj: null,
      items: Array.from({ length: 9 }, (_, index) => ({
        name: `Peça número ${index + 1} com um nome bem comprido para testar a quebra`,
        sku: `SKU-${index + 1}`,
        quantity: 1,
        unitPriceCents: 1000,
        totalCents: 1000,
      })),
    };
    const png = await renderReceiptPng(many, assets);
    const metadata = await sharp(png).metadata();
    expect(metadata.height).toBe(RECEIPT_HEIGHT);
    expect(networkCalls).toEqual([]);
  }, 30_000);
});
