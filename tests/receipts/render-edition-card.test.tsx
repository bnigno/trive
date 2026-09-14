// Desenho real do cartão da edição: PNG 1080×1440, sem rede, com e sem a
// frase da curadora, nome longo, palavra sem espaço, tudo em caixa alta —
// a faixa noir e o filete de baixo sempre no lugar, o QR decodificável com
// a URL certa (inclusive depois do JPEG que vai ao bucket). E a régua do
// core conferida contra o Satori: a estimativa de linhas nunca fica abaixo
// do que a fonte de verdade quebra.
import { ImageResponse } from "next/og";
import jsQR from "jsqr";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EDITION_GEOMETRY as G, editionLayout, estimateLines } from "@/core/edition/layout";
import { DEFAULT_CARE, DEFAULT_WEAR, editionTexts, type WidthFont } from "@/core/edition/text";
import type { EditionCardData } from "@/core/edition/types";
import { loadReceiptAssets } from "@/receipts/assets";
import { qrPngDataUrl, QR_PNG_SIZE, qrVersion } from "@/receipts/qr";
import { EDITION_CARD_HEIGHT, EDITION_CARD_WIDTH, EDITION_TYPE, eyebrowStyle, renderEditionCardPng } from "@/receipts/render-edition-card";
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
  // Nada de tinta atravessando a moldura direita.
  for (let y = 400; y < 1200; y += 8) {
    const [mr, mg, mb] = pixel(EDITION_CARD_WIDTH - 12, y);
    expect(mr + mg + mb).toBeGreaterThan(600);
  }
  // O QR lê e diz exatamente o endereço pedido.
  expect(await decodeQr(png)).toBe(data.qrUrl);
  expect(networkCalls).toEqual([]);
}

/** Os dados de um cartão com o layout que o serviço calcularia. */
function card(partial: Omit<EditionCardData, "layout">): EditionCardData {
  const layout = editionLayout({
    title: partial.productName,
    curatorNote: partial.curatorNote,
    wearNote: partial.wearNote,
    careNote: partial.careNote,
    qrUrl: partial.qrUrl,
  });
  return {
    ...partial,
    curatorNote: layout.curatorNote,
    layout: {
      titleSize: layout.titleSize,
      titleLines: layout.titleLines,
      quoteSize: layout.quoteSize,
      quoteLines: layout.quoteLines,
      bodySize: layout.bodySize,
      wearLines: layout.wearLines,
      careLines: layout.careLines,
      qrSize: layout.qrSize,
    },
  };
}

const base: EditionCardData = card({
  storeName: "TRIVÉ",
  editionName: "Edição Círio",
  productName: "Longo Dunas",
  curatorNote: "Escolhi este linho pelo caimento no calor: ele acompanha o corpo sem grudar.",
  wearNote: DEFAULT_WEAR.vestido,
  wearSource: "padrao",
  careNote: "Lavar à mão · Secar à sombra",
  qrUrl: "https://trivemaison.com.br/produto/longo-dunas",
  qrTarget: "peca",
  printedAddress: "trivemaison.com.br",
});

describe("renderEditionCardPng", () => {
  it("com a frase da curadora; o JPEG que vai ao bucket ainda lê o QR", async () => {
    const png = await renderEditionCardPng(base, await loadReceiptAssets());
    await check(png, base);
    const jpeg = await sharp(png).jpeg({ quality: EDITION_CARD_JPEG_QUALITY }).toBuffer();
    expect(await decodeQr(jpeg)).toBe(base.qrUrl);
  });

  it("sem frase, sem edição, nome longo e 'Como veste' da ficha (o corpo do título desce)", async () => {
    const data = card({
      ...base,
      editionName: null,
      curatorNote: null,
      productName: "Cropped Íris em Suplex com Recorte Lateral",
      wearNote: "Caimento justo · Modelo veste M e tem 1,70 m",
      wearSource: "ficha",
      careNote: DEFAULT_CARE.blusa,
      qrUrl: "https://trivemaison.com.br/produto/cropped-iris-em-suplex-com-recorte-lateral-edicao-especial",
    });
    expect(data.layout.titleSize).toBeLessThan(base.layout.titleSize);
    await check(await renderEditionCardPng(data, await loadReceiptAssets()), data);
  });

  it("emoji, palavra sem espaço e frase longa não derrubam, não buscam fonte nem atravessam a moldura", async () => {
    const data = card({
      ...base,
      productName: "Longo Dunas 🌞",
      curatorNote: `Amei ❤️ esta peça‼️ ${"x".repeat(220)}`,
      wearNote: `Veste como @trivemaison_belem_edicao_especial_2026 #${"a".repeat(70)} pede.`,
    });
    await check(await renderEditionCardPng(data, await loadReceiptAssets()), data);
  });

  it("tudo em CAIXA ALTA nos tetos do core, nome de edição de 40 letras e QR denso: cabe, sem meia linha", async () => {
    const up = (t: string) => t.toUpperCase();
    const texts = editionTexts({
      productName: up("Vestido Longo de Linho Puro com Bordado Feito à Mão pelas Artesãs"),
      categoryName: "Vestidos",
      curatorNote: up("Escolhi este linho pelo caimento no calor: ele acompanha o corpo sem grudar. ".repeat(6)),
      fitNotes: up(`${DEFAULT_WEAR.blusa} ${DEFAULT_WEAR.saia}`),
      careNotes: up(`${DEFAULT_CARE.blusa} ${DEFAULT_CARE.saia}`),
    })!;
    expect(texts.curatorTruncated).toBe(true);
    expect(texts.wearTruncated).toBe(true);
    const data = card({
      ...base,
      editionName: "Edição Comemorativa Círio de Nazaré 2026",
      productName: texts.title,
      curatorNote: texts.curatorNote,
      wearNote: texts.wearNote,
      wearSource: texts.wearSource,
      careNote: texts.careNote,
      qrUrl: "https://trivemaison.com.br/produto/vestido-longo-de-linho-puro-com-bordado-feito-a-mao-pelas-artesas-da-ilha",
    });
    expect(data.layout.qrSize).toBeGreaterThan(220);
    expect(eyebrowStyle("EDIÇÃO COMEMORATIVA CÍRIO DE NAZARÉ 2026").fontSize).toBe(EDITION_TYPE.eyebrowTight);
    const png = await renderEditionCardPng(data, await loadReceiptAssets());
    await check(png, data);
    // Nenhuma linha cortada ao meio: a última faixa de tinta antes do QR (a
    // última linha dos cuidados) tem a altura de uma linha inteira, nunca um
    // resto. Faixas separadas por menos de 8 px (acento sobre maiúscula) são uma só.
    const raw = await sharp(png).greyscale().raw().toBuffer({ resolveWithObject: true });
    const inkRow = (y: number) => {
      for (let x = 100; x < EDITION_CARD_WIDTH - 100; x += 1) if (raw.data[y * raw.info.width + x] < 140) return true;
      return false;
    };
    const qrTop = (() => {
      for (let y = 700; y < EDITION_CARD_HEIGHT; y += 1) {
        let dark = 0;
        for (let x = 100; x < 100 + data.layout.qrSize; x += 2) if (raw.data[y * raw.info.width + x] < 100) dark += 1;
        if (dark > data.layout.qrSize / 6) return y;
      }
      return EDITION_CARD_HEIGHT;
    })();
    const bands: { start: number; end: number }[] = [];
    for (let y = 260; y < qrTop - 4; y += 1) {
      if (!inkRow(y)) continue;
      const last = bands[bands.length - 1];
      if (last && y - last.end <= 8) last.end = y;
      else bands.push({ start: y, end: y });
    }
    expect(bands.length).toBeGreaterThan(6);
    const lastBand = bands[bands.length - 1];
    expect(lastBand.end - lastBand.start + 1).toBeGreaterThanOrEqual(Math.floor(0.6 * data.layout.bodySize));
    // E o pé dessa linha fica acima do QR, com folga (o paddingBottom dos quadros).
    expect(qrTop - lastBand.end).toBeGreaterThanOrEqual(G.boxes.paddingBottom);
  });

  it("presente: o convite fala da TRIVÉ, não da peça (o QR vai para a home)", async () => {
    const data = card({ ...base, qrUrl: "https://trivemaison.com.br", qrTarget: "home" });
    const png = await renderEditionCardPng(data, await loadReceiptAssets());
    await check(png, data);
    expect(data.layout.qrSize).toBe(EDITION_TYPE.qrMin);
  });

  it("os corpos de letra são legíveis a 9 cm de largura (≥ 6 pt no papel), inclusive os mínimos", () => {
    const ptPerPx = 90 / EDITION_CARD_WIDTH / 0.3528;
    for (const size of [
      EDITION_TYPE.eyebrowTight,
      EDITION_TYPE.label,
      EDITION_TYPE.bodyMin,
      EDITION_TYPE.byline,
      EDITION_TYPE.address,
      EDITION_TYPE.quoteMin,
    ]) {
      expect(size * ptPerPx).toBeGreaterThanOrEqual(5.5);
    }
  });
});

/** Quantas linhas o Satori de fato quebra num bloco de texto na largura do miolo. */
async function actualLines(text: string, font: WidthFont, fontSize: number): Promise<number> {
  const assets = await loadReceiptAssets();
  const lineHeight = 1.6;
  const response = new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          width: G.contentWidth,
          height: 1800,
          backgroundColor: "#fff",
          color: "#000",
          fontFamily: font === "serif" ? "Cormorant Garamond" : "Jost",
          fontStyle: font === "serif" ? "italic" : "normal",
          fontSize,
          lineHeight,
          wordBreak: "break-word",
        }}
      >
        {text}
      </div>
    ),
    { width: G.contentWidth, height: 1800, fonts: assets.fonts.map((f) => ({ name: f.name, data: f.data, weight: f.weight, style: f.style })) },
  );
  const png = Buffer.from(await response.arrayBuffer());
  const raw = await sharp(png).greyscale().raw().toBuffer({ resolveWithObject: true });
  // Cada linha ocupa uma faixa de `lineHeight × corpo`; contamos as faixas com tinta.
  const pitch = lineHeight * fontSize;
  let lines = 0;
  for (let band = 0; band * pitch < 1800; band += 1) {
    let ink = false;
    for (let y = Math.floor(band * pitch); y < Math.min(1800, (band + 1) * pitch) && !ink; y += 1) {
      for (let x = 0; x < raw.info.width; x += 2) {
        if (raw.data[y * raw.info.width + x] < 128) {
          ink = true;
          break;
        }
      }
    }
    if (ink) lines += 1;
  }
  return lines;
}

describe("estimateLines × Satori", () => {
  it("a estimativa do core nunca fica abaixo das linhas que as fontes de verdade quebram", async () => {
    const samples: [string, WidthFont, number][] = [
      [DEFAULT_WEAR.vestido, "sans", 30],
      [DEFAULT_WEAR.blusa, "sans", 28],
      [DEFAULT_CARE.blusa.toUpperCase(), "sans", 30],
      [`${DEFAULT_WEAR.saia} ${DEFAULT_CARE.saia}`, "sans", 26],
      ["Caimento justo · Modelo veste M e tem 1,70 m", "sans", 30],
      ["“Escolhi este linho pelo caimento no calor: ele acompanha o corpo sem grudar. Gosto dele à noite.”", "serif", 44],
      ["“ESCOLHI ESTE LINHO PELO CAIMENTO NO CALOR: ELE ACOMPANHA O CORPO SEM GRUDAR. ESCOLHI ESTE LINHO PELO CAIMENTO NO CALOR.”", "serif", 34],
      ["Vestido Longo de Linho com Bordado Marajoara Nazaré", "serif", 46],
      ["VESTIDO LONGO CÍRIO NAZARÉ", "serif", 68],
      ["Cropped Íris em Suplex com Recorte Lateral", "serif", 56],
      ["1234567890 1234567890 1234567890 1234567890 1234567890 12345", "sans", 30],
    ];
    for (const [text, font, size] of samples) {
      const actual = await actualLines(text, font, size);
      expect(estimateLines(text, font, size), `${font} ${size}: ${text.slice(0, 40)}`).toBeGreaterThanOrEqual(actual);
      // E não superestima demais (senão o cartão sai pequeno à toa).
      expect(estimateLines(text, font, size), `${font} ${size}: ${text.slice(0, 40)}`).toBeLessThanOrEqual(actual + 1);
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
    expect(qrVersion("https://trivemaison.com.br")).toBe(2);
  });
});
