// Desenho real do cartão da edição: PNG 1080×1440, sem rede, com e sem a
// frase da curadora, nome longo, e o QR de fato desenhado no canto.
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_CARE, DEFAULT_WEAR } from "@/core/edition/text";
import type { EditionCardData } from "@/core/edition/types";
import { loadReceiptAssets } from "@/receipts/assets";
import { qrPngDataUrl, QR_PNG_SIZE } from "@/receipts/qr";
import {
  EDITION_CARD_HEIGHT,
  EDITION_CARD_WIDTH,
  editionQuoteFontSize,
  editionTitleFontSize,
  renderEditionCardPng,
} from "@/receipts/render-edition-card";

const originalFetch = globalThis.fetch;
const networkCalls: string[] = [];

beforeEach(() => {
  networkCalls.length = 0;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    if (/^https?:/i.test(url)) networkCalls.push(url);
    return Promise.reject(new Error(`rede proibida no cartão: ${url}`));
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function check(png: Buffer) {
  const image = sharp(png);
  const metadata = await image.metadata();
  expect(metadata.format).toBe("png");
  expect(metadata.width).toBe(EDITION_CARD_WIDTH);
  expect(metadata.height).toBe(EDITION_CARD_HEIGHT);
  const raw = await image.raw().toBuffer({ resolveWithObject: true });
  const pixel = (x: number, y: number) => {
    const offset = (y * raw.info.width + x) * raw.info.channels;
    return [raw.data[offset], raw.data[offset + 1], raw.data[offset + 2]];
  };
  // Papel marfim no alto; faixa noir embaixo.
  const [r, g] = pixel(80, 300);
  expect(r).toBeGreaterThan(235);
  expect(g).toBeGreaterThan(235);
  const [nr, ng, nb] = pixel(120, EDITION_CARD_HEIGHT - 60);
  expect(nr + ng + nb).toBeLessThan(60);
  // O QR existe no canto inferior esquerdo: há pixels escuros na região dele.
  let dark = 0;
  for (let y = EDITION_CARD_HEIGHT - 360; y < EDITION_CARD_HEIGHT - 160; y += 4) {
    for (let x = 100; x < 300; x += 4) {
      const [qr, qg, qb] = pixel(x, y);
      if (qr + qg + qb < 150) dark++;
    }
  }
  expect(dark).toBeGreaterThan(200);
  expect(networkCalls).toEqual([]);
}

const base: EditionCardData = {
  storeName: "TRIVÉ",
  editionName: "Edição Círio",
  productName: "Longo Dunas",
  curatorNote: "Escolhi este linho pelo caimento no calor: ele acompanha o corpo sem grudar.",
  wearNote: DEFAULT_WEAR.vestido,
  careNote: "Lavar à mão · Secar à sombra",
  productUrl: "https://trivemaison.com.br/produto/longo-dunas",
};

describe("renderEditionCardPng", () => {
  it("com a frase da curadora", async () => {
    await check(await renderEditionCardPng(base, await loadReceiptAssets()));
  });

  it("sem frase, sem edição e com nome longo (o corpo do título desce)", async () => {
    expect(editionTitleFontSize("Longo Dunas")).toBeGreaterThan(editionTitleFontSize("Cropped Íris em Suplex com Recorte Lateral"));
    expect(editionQuoteFontSize("curta")).toBeGreaterThan(editionQuoteFontSize("x".repeat(200)));
    await check(
      await renderEditionCardPng(
        {
          ...base,
          editionName: null,
          curatorNote: null,
          productName: "Cropped Íris em Suplex com Recorte Lateral",
          careNote: DEFAULT_CARE.blusa,
        },
        await loadReceiptAssets(),
      ),
    );
  });

  it("emoji no texto não derruba nem busca fonte pela rede", async () => {
    await check(
      await renderEditionCardPng(
        { ...base, productName: "Longo Dunas 🌞", curatorNote: "Amei ❤️ esta peça." },
        await loadReceiptAssets(),
      ),
    );
  });
});

describe("qrPngDataUrl", () => {
  it("devolve um PNG em data URL, quadrado, do tamanho pedido", async () => {
    const url = await qrPngDataUrl("https://trivemaison.com.br/produto/longo-dunas");
    expect(url.startsWith("data:image/png;base64,")).toBe(true);
    const png = Buffer.from(url.slice("data:image/png;base64,".length), "base64");
    const meta = await sharp(png).metadata();
    expect([meta.width, meta.height]).toEqual([QR_PNG_SIZE, QR_PNG_SIZE]);
  });
});
