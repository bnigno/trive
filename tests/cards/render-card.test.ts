// Desenho real do cartão editorial: PNG 1080×1350, fotos embutidas em data:
// URL, sem nenhuma ida à rede — 1, 2 e 3 peças e o look completo.
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CARD_HEIGHT, CARD_WIDTH, renderCardPng } from "@/cards/render";
import type { CardItem } from "@/core/cards/types";
import { loadReceiptAssets } from "@/receipts/assets";

async function photo(color: string, width = 600, height = 800): Promise<string> {
  const jpeg = await sharp({ create: { width, height, channels: 3, background: color } })
    .jpeg()
    .toBuffer();
  return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
}

let items: CardItem[];

const originalFetch = globalThis.fetch;
const networkCalls: string[] = [];

beforeEach(async () => {
  networkCalls.length = 0;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    if (/^https?:/i.test(url)) networkCalls.push(url);
    return Promise.reject(new Error(`rede proibida no cartão: ${url}`));
  }) as unknown as typeof fetch;
  items = [
    { slug: "longo-dunas", name: "LONGO DUNAS 🤎 com nome comprido demais para caber", priceLabel: "R$ 309,00", imageDataUrl: await photo("#b08968") },
    { slug: "bolsa-tote", name: "Bolsa Tote de Algodão", priceLabel: "a partir de R$ 129,00", imageDataUrl: await photo("#7a6a58", 880, 1174) },
    { slug: "bone", name: "Boné Bordado", priceLabel: "R$ 89,00", imageDataUrl: await photo("#2f1c16") },
  ];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function expectCard(png: Buffer) {
  const image = sharp(png);
  const metadata = await image.metadata();
  expect(metadata.format).toBe("png");
  expect(metadata.width).toBe(CARD_WIDTH);
  expect(metadata.height).toBe(CARD_HEIGHT);
  const raw = await image.raw().toBuffer({ resolveWithObject: true });
  const pixel = (x: number, y: number) => {
    const offset = (y * raw.info.width + x) * raw.info.channels;
    return [raw.data[offset], raw.data[offset + 1], raw.data[offset + 2]];
  };
  const [tr, tg, tb] = pixel(20, 20);
  expect(tr + tg + tb).toBeLessThan(60);
  const [br, bg, bb] = pixel(20, CARD_HEIGHT - 20);
  expect(br).toBeGreaterThan(230);
  expect(bg).toBeGreaterThan(230);
  expect(bb).toBeGreaterThan(220);
  expect(networkCalls).toEqual([]);
  /** Há um pixel daquela cor em algum ponto da coluna x (a foto está lá)? */
  const columnHas = (x: number, hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    for (let y = 250; y < CARD_HEIGHT - 120; y += 4) {
      const [pr, pg, pb] = pixel(x, y);
      if (Math.abs(pr - r) + Math.abs(pg - g) + Math.abs(pb - b) < 40) return true;
    }
    return false;
  };
  return columnHas;
}

describe("renderCardPng", () => {
  it("catálogo com 3 peças: faixa noir, papel marfim, fotos no lugar, sem rede", async () => {
    const png = await renderCardPng(
      { kind: "catalog", storeName: "TRIVÉ", eyebrow: "VESTIDOS · TERROSOS", title: "Três peças para você", items },
      await loadReceiptAssets(),
    );
    const columnHas = await expectCard(png);
    // Três colunas: terroso à esquerda, cinza no meio, espresso à direita.
    expect(columnHas(210, "#b08968")).toBe(true);
    expect(columnHas(540, "#7a6a58")).toBe(true);
    expect(columnHas(870, "#2f1c16")).toBe(true);
    expect(columnHas(540, "#2f1c16")).toBe(false);
  });

  it("catálogo com 2 e com 1 peça também renderiza", async () => {
    const assets = await loadReceiptAssets();
    await expectCard(
      await renderCardPng(
        { kind: "catalog", storeName: "TRIVÉ", eyebrow: "A VITRINE DE HOJE", title: "Duas peças para você", items: items.slice(0, 2) },
        assets,
      ),
    );
    await expectCard(
      await renderCardPng(
        { kind: "catalog", storeName: "TRIVÉ", eyebrow: "A VITRINE DE HOJE", title: "Uma peça para você", items: items.slice(0, 1) },
        assets,
      ),
    );
  });

  it("look: peça grande à esquerda e complementos à direita", async () => {
    const png = await renderCardPng(
      {
        kind: "look",
        storeName: "TRIVÉ",
        eyebrow: "O LOOK COMPLETO",
        title: "Um look com LONGO DUNAS",
        hero: items[0],
        complements: items.slice(1, 3),
      },
      await loadReceiptAssets(),
    );
    const columnHas = await expectCard(png);
    expect(columnHas(380, "#b08968")).toBe(true);
    expect(columnHas(820, "#7a6a58")).toBe(true);
    expect(columnHas(820, "#2f1c16")).toBe(true);
    expect(columnHas(380, "#7a6a58")).toBe(false);
  });
});

describe("post e story da peça", () => {
  it("post sai 1080×1350 e story 1080×1920, com a foto embutida e sem rede", async () => {
    const assets = await loadReceiptAssets();
    const hero = items[0];

    const post = await renderCardPng(
      { kind: "post", storeName: "TRIVÉ", eyebrow: "EDIÇÃO CÍRIO", title: "Longo Dunas", hero },
      assets,
    );
    const postMeta = await sharp(post).metadata();
    expect(postMeta.width).toBe(1080);
    expect(postMeta.height).toBe(1350);

    const story = await renderCardPng(
      { kind: "story", storeName: "TRIVÉ", eyebrow: "EDIÇÃO CÍRIO", title: "Longo Dunas", hero },
      assets,
    );
    const storyMeta = await sharp(story).metadata();
    expect(storyMeta.width).toBe(1080);
    expect(storyMeta.height).toBe(1920);

    expect(networkCalls).toEqual([]);
  });
});
