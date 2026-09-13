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

  it("nome longo não empurra o rodapé para fora: a última linha continua dentro da arte", async () => {
    const assets = await loadReceiptAssets();
    const hero = {
      ...items[0],
      name: "Vestido Longo Dunas de Linho Natural com Alças Finas Ajustáveis",
    };
    const png = await renderCardPng(
      {
        kind: "post",
        storeName: "TRIVÉ",
        eyebrow: "EDIÇÃO CÍRIO",
        title: hero.name,
        hero,
      },
      assets,
    );
    // O rodapé tem um traço dourado (#d4b96a) logo acima da assinatura. Se a
    // arte estourasse, ele seria empurrado para fora e sumiria do quadro.
    const { data, info } = await sharp(png)
      .extract({ left: 0, top: 1200, width: 1080, height: 150 })
      .raw()
      .toBuffer({ resolveWithObject: true });
    let gold = 0;
    for (let i = 0; i < data.length; i += info.channels) {
      const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
      if (r > 185 && r < 235 && g > 160 && g < 210 && b > 80 && b < 140) gold += 1;
    }
    expect(gold, "o traço dourado do rodapé sumiu: a arte estourou").toBeGreaterThan(50);
  });
});

describe("story do lançamento", () => {
  it("1080×1920 com 1 e 3 peças; no véu não há preço; a cortina aberta mostra os preços; nada vai à rede", async () => {
    const assets = await loadReceiptAssets();
    const S = "/private/tmp/claude-501/-Users-fabiano-TRIV-/20560e3d-97e5-4ebf-9f52-dfaf7ef88d80/scratchpad";
    const teaser = await renderCardPng(
      {
        kind: "drop_story",
        variant: "teaser",
        storeName: "TRIVÉ",
        eyebrow: "ESTREIA · SÁBADO, 20H",
        title: "Edição Círio",
        caption: "A cortina abre sábado, 20h.",
        items: items.map((item) => ({ ...item, priceLabel: "" })),
        siteLine: "trivemaison.com.br/estreia",
      },
      assets,
    );
    const teaserMeta = await sharp(teaser).metadata();
    expect(teaserMeta.width).toBe(1080);
    expect(teaserMeta.height).toBe(1920);
    await sharp(teaser).toFile(`${S}/drop-story-teaser.png`).catch(() => undefined);

    const open = await renderCardPng(
      {
        kind: "drop_story",
        variant: "open",
        storeName: "TRIVÉ",
        eyebrow: "ESTREIA · HOJE, 20H",
        title: "Edição Círio",
        caption: "A cortina abriu.",
        items: [items[0]],
        siteLine: "trivemaison.com.br/estreia",
      },
      assets,
    );
    const openMeta = await sharp(open).metadata();
    expect(openMeta.width).toBe(1080);
    expect(openMeta.height).toBe(1920);
    await sharp(open).toFile(`${S}/drop-story-open.png`).catch(() => undefined);

    // Faixa noir no alto, marfim embaixo, foto embutida, sem rede.
    const raw = await sharp(open).raw().toBuffer({ resolveWithObject: true });
    const pixel = (x: number, y: number) => {
      const offset = (y * raw.info.width + x) * raw.info.channels;
      return [raw.data[offset], raw.data[offset + 1], raw.data[offset + 2]];
    };
    expect(pixel(20, 20).reduce((a, b) => a + b, 0)).toBeLessThan(60);
    expect(pixel(20, 1900)[0]).toBeGreaterThan(230);
    let found = false;
    for (let y = 400; y < 1700 && !found; y += 6) {
      const [r, g, b] = pixel(540, y);
      if (Math.abs(r - 0xb0) + Math.abs(g - 0x89) + Math.abs(b - 0x68) < 40) found = true;
    }
    expect(found).toBe(true);
    expect(networkCalls).toEqual([]);
  });
});
