// Desenho real do cartão da edição: PNG 1080×1440, sem rede, com e sem a
// frase da curadora, nome longo, palavra sem espaço — e o QR de fato
// decodificável, com a URL certa, inclusive depois do JPEG que vai ao bucket.
import jsQR from "jsqr";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_CARE, DEFAULT_WEAR } from "@/core/edition/text";
import type { EditionCardData } from "@/core/edition/types";
import { loadReceiptAssets } from "@/receipts/assets";
import { qrPngDataUrl, QR_PNG_SIZE } from "@/receipts/qr";
import {
  EDITION_CARD_HEIGHT,
  EDITION_CARD_WIDTH,
  EDITION_TYPE,
  editionQuoteFontSize,
  editionTitleFontSize,
  renderEditionCardPng,
} from "@/receipts/render-edition-card";
import { EDITION_CARD_JPEG_QUALITY } from "@/services/edition-cards";

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

/** Decodifica o QR de uma imagem (PNG ou JPEG) como um celular faria. */
async function decodeQr(image: Buffer): Promise<string | null> {
  const raw = await sharp(image).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const code = jsQR(new Uint8ClampedArray(raw.data), raw.info.width, raw.info.height);
  return code?.data ?? null;
}

async function check(png: Buffer, data: EditionCardData) {
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
  // Papel marfim no alto; faixa noir embaixo; nada de tinta atravessando a moldura direita.
  const [r, g] = pixel(80, 300);
  expect(r).toBeGreaterThan(235);
  expect(g).toBeGreaterThan(235);
  const [nr, ng, nb] = pixel(120, EDITION_CARD_HEIGHT - 60);
  expect(nr + ng + nb).toBeLessThan(60);
  for (let y = 400; y < 1200; y += 8) {
    const [mr, mg, mb] = pixel(EDITION_CARD_WIDTH - 12, y);
    expect(mr + mg + mb).toBeGreaterThan(600);
  }
  // O QR lê e diz exatamente o endereço pedido.
  expect(await decodeQr(png)).toBe(data.qrUrl);
  expect(networkCalls).toEqual([]);
}

const base: EditionCardData = {
  editionName: "Edição Círio",
  productName: "Longo Dunas",
  curatorNote: "Escolhi este linho pelo caimento no calor: ele acompanha o corpo sem grudar.",
  wearNote: DEFAULT_WEAR.vestido,
  wearSource: "padrao",
  careNote: "Lavar à mão · Secar à sombra",
  qrUrl: "https://trivemaison.com.br/produto/longo-dunas",
  printedAddress: "trivemaison.com.br",
};

describe("renderEditionCardPng", () => {
  it("com a frase da curadora; o JPEG que vai ao bucket ainda lê o QR", async () => {
    const png = await renderEditionCardPng(base, await loadReceiptAssets());
    await check(png, base);
    const jpeg = await sharp(png).jpeg({ quality: EDITION_CARD_JPEG_QUALITY }).toBuffer();
    expect(await decodeQr(jpeg)).toBe(base.qrUrl);
  });

  it("sem frase, sem edição, nome longo e 'Como veste' da ficha (o corpo do título desce)", async () => {
    expect(editionTitleFontSize("Longo Dunas")).toBeGreaterThan(editionTitleFontSize("Cropped Íris em Suplex com Recorte Lateral"));
    expect(editionQuoteFontSize("curta")).toBeGreaterThan(editionQuoteFontSize("x".repeat(300)));
    const data: EditionCardData = {
      ...base,
      editionName: null,
      curatorNote: null,
      productName: "Cropped Íris em Suplex com Recorte Lateral",
      wearNote: "Caimento justo · Modelo veste M e tem 1,70 m",
      wearSource: "ficha",
      careNote: DEFAULT_CARE.blusa,
      qrUrl: "https://trivemaison.com.br/produto/cropped-iris-em-suplex-com-recorte-lateral-edicao-especial",
    };
    await check(await renderEditionCardPng(data, await loadReceiptAssets()), data);
  });

  it("emoji, palavra sem espaço e frase longa não derrubam, não buscam fonte nem atravessam a moldura", async () => {
    const data: EditionCardData = {
      ...base,
      productName: "Longo Dunas 🌞",
      curatorNote: `Amei ❤️ esta peça. ${"x".repeat(220)}`,
      wearNote: `Veste como @trivemaison_belem_edicao_especial_2026 #${"a".repeat(70)} pede.`,
    };
    await check(await renderEditionCardPng(data, await loadReceiptAssets()), data);
  });

  it("os corpos de letra são legíveis a 9 cm de largura (≥ 6 pt no papel)", () => {
    const ptPerPx = (90 / EDITION_CARD_WIDTH) / 0.3528;
    for (const size of [EDITION_TYPE.eyebrow, EDITION_TYPE.label, EDITION_TYPE.body, EDITION_TYPE.byline, EDITION_TYPE.address]) {
      expect(size * ptPerPx).toBeGreaterThanOrEqual(5.5);
    }
  });
});

describe("qrPngDataUrl", () => {
  it("devolve um PNG em data URL, quadrado, do tamanho pedido, que decodifica", async () => {
    const url = await qrPngDataUrl("https://trivemaison.com.br/produto/longo-dunas");
    expect(url.startsWith("data:image/png;base64,")).toBe(true);
    const png = Buffer.from(url.slice("data:image/png;base64,".length), "base64");
    const meta = await sharp(png).metadata();
    expect([meta.width, meta.height]).toEqual([QR_PNG_SIZE, QR_PNG_SIZE]);
    expect(await decodeQr(png)).toBe("https://trivemaison.com.br/produto/longo-dunas");
  });
});
