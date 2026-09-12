// Desenho real do cartão da edição: PNG 1080×1440, sem rede, com e sem a
// frase da curadora, nome longo, palavra sem espaço — e o QR de fato
// decodificável, com a URL certa, inclusive depois do JPEG que vai ao bucket.
import jsQR from "jsqr";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_CARE, DEFAULT_WEAR, editionTexts } from "@/core/edition/text";
import type { EditionCardData } from "@/core/edition/types";
import { loadReceiptAssets } from "@/receipts/assets";
import { qrPngDataUrl, QR_PNG_SIZE } from "@/receipts/qr";
import {
  EDITION_CARD_HEIGHT,
  EDITION_CARD_WIDTH,
  EDITION_TYPE,
  editionBodyFontSize,
  editionQrSize,
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
  // Papel marfim no alto; faixa noir embaixo (toda a largura, na altura do
  // lockup) — se o texto empurrasse o rodapé, ela sairia do cartão.
  const [r, g] = pixel(80, 300);
  expect(r).toBeGreaterThan(235);
  expect(g).toBeGreaterThan(235);
  for (const x of [120, EDITION_CARD_WIDTH - 120]) {
    const [nr, ng, nb] = pixel(x, EDITION_CARD_HEIGHT - 60);
    expect(nr + ng + nb).toBeLessThan(60);
  }
  // O filete dourado de baixo continua dentro do cartão (a faixa não o cobriu).
  let goldBottom = false;
  for (let y = EDITION_CARD_HEIGHT - 45; y < EDITION_CARD_HEIGHT - 30; y += 1) {
    const [gr, gg, gb] = pixel(EDITION_CARD_WIDTH / 2, y);
    if (gr > 180 && gg > 150 && gb < 140) goldBottom = true;
  }
  expect(goldBottom).toBe(true);
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
  qrTarget: "peca",
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

  it("tudo em CAIXA ALTA e no teto do core: a faixa noir e o lockup continuam no cartão (o bloco dos quadros é o que cede)", async () => {
    const cheio = (text: string) => text.toUpperCase();
    // Uma ficha inteira em caixa alta, passada pelos tetos do core como no serviço.
    const texts = editionTexts({
      productName: cheio("Vestido Longo de Linho Puro com Bordado Feito à Mão pelas Artesãs"),
      categoryName: "Vestidos",
      curatorNote: cheio("Escolhi este linho pelo caimento no calor: ele acompanha o corpo sem grudar. ".repeat(6)),
      fitNotes: cheio(`${DEFAULT_WEAR.blusa} ${DEFAULT_WEAR.saia}`),
      careNotes: cheio(`${DEFAULT_CARE.blusa} ${DEFAULT_CARE.saia}`),
    })!;
    expect(texts.curatorTruncated).toBe(true);
    expect(texts.wearTruncated).toBe(true);
    const data: EditionCardData = {
      ...base,
      editionName: "EDIÇÃO CÍRIO DE NAZARÉ",
      productName: cheio("Vestido Longo de Linho Puro com Bordado Feito à Mão pelas Artesãs"),
      curatorNote: texts.curatorNote,
      wearNote: texts.wearNote,
      wearSource: texts.wearSource,
      careNote: texts.careNote,
      qrUrl: "https://trivemaison.com.br/produto/vestido-longo-de-linho-puro-com-bordado-feito-a-mao-pelas-artesas",
    };
    await check(await renderEditionCardPng(data, await loadReceiptAssets()), data);
    // Quadros bem além do teto: o cartão não estoura mesmo assim (última trava, no desenho).
    const estourado: EditionCardData = { ...data, wearNote: cheio(DEFAULT_WEAR.blusa.repeat(4)), careNote: cheio(DEFAULT_CARE.blusa.repeat(4)) };
    await check(await renderEditionCardPng(estourado, await loadReceiptAssets()), estourado);
  });

  it("presente: o convite fala da maison, não da peça (o QR vai para a home)", async () => {
    const data: EditionCardData = { ...base, qrUrl: "https://trivemaison.com.br", qrTarget: "home" };
    const png = await renderEditionCardPng(data, await loadReceiptAssets());
    await check(png, data);
    // Endereço curto: QR de versão baixa, no tamanho normal.
    expect(editionQrSize(data.qrUrl)).toBe(EDITION_TYPE.qr);
    expect(editionQrSize("https://trivemaison.com.br/produto/cropped-iris-em-suplex-com-recorte-lateral-edicao-especial")).toBe(
      EDITION_TYPE.qrDense,
    );
  });

  it("os corpos de letra são legíveis a 9 cm de largura (≥ 6 pt no papel), inclusive o corpo reduzido dos quadros", () => {
    const ptPerPx = (90 / EDITION_CARD_WIDTH) / 0.3528;
    for (const size of [
      EDITION_TYPE.eyebrow,
      EDITION_TYPE.label,
      EDITION_TYPE.body,
      EDITION_TYPE.bodyMin,
      EDITION_TYPE.byline,
      EDITION_TYPE.address,
    ]) {
      expect(size * ptPerPx).toBeGreaterThanOrEqual(5.5);
    }
    expect(editionBodyFontSize("curto", "curto")).toBe(EDITION_TYPE.body);
    expect(editionBodyFontSize(DEFAULT_WEAR.blusa, DEFAULT_CARE.blusa)).toBeLessThan(EDITION_TYPE.body);
    expect(editionBodyFontSize("x".repeat(200), "curto")).toBe(EDITION_TYPE.bodyMin);
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
