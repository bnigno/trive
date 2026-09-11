// Prévia do cartão editorial em PNG (catálogo com 3/2/1 peças e o look), com
// fotos de exemplo geradas na hora — sem banco e sem rede. Com --fotos
// <pasta>, usa as imagens (jpg/png/webp) da pasta em vez das cores lisas.
// Uso: npx tsx scripts/preview-card.ts [--fotos ./pasta] [pasta-de-saida]
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import sharp from "sharp";

import { renderCardPng } from "@/cards/render";
import { cardFrameSize, type CardData, type CardItem } from "@/core/cards/types";
import { loadReceiptAssets } from "@/receipts/assets";

const SAMPLE = [
  { slug: "longo-dunas", name: "LONGO DUNAS", priceLabel: "R$ 309,00", color: "#b08968" },
  { slug: "bolsa-tote", name: "Bolsa Tote de Algodão", priceLabel: "R$ 129,00", color: "#7a6a58" },
  { slug: "bone-bordado", name: "Boné Bordado", priceLabel: "a partir de R$ 89,00", color: "#2f1c16" },
];

async function photoFrom(source: Buffer | string, frame: { width: number; height: number }): Promise<string> {
  const base =
    typeof source === "string"
      ? sharp({ create: { width: frame.width * 2, height: frame.height * 2, channels: 3, background: source } })
      : sharp(source).rotate().resize({ width: frame.width * 2, height: frame.height * 2, fit: "cover", position: "attention" });
  const jpeg = await base.jpeg({ quality: 82 }).toBuffer();
  return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
}

async function main() {
  const args = process.argv.slice(2);
  const fotosIndex = args.indexOf("--fotos");
  const fotosDir = fotosIndex >= 0 ? args[fotosIndex + 1] : undefined;
  const out =
    args.filter((arg, index) => !arg.startsWith("--") && !(fotosIndex >= 0 && index === fotosIndex + 1))[0] ??
    ".preview";
  mkdirSync(out, { recursive: true });

  const files = fotosDir
    ? readdirSync(fotosDir)
        .filter((name) => /\.(jpe?g|png|webp)$/i.test(name))
        .slice(0, 3)
        .map((name) => readFileSync(join(fotosDir, name)))
    : [];

  const items = async (kind: CardData["kind"], count: number): Promise<CardItem[]> =>
    Promise.all(
      SAMPLE.slice(0, count).map(async (sample, index) => ({
        slug: sample.slug,
        name: sample.name,
        priceLabel: sample.priceLabel,
        imageDataUrl: await photoFrom(
          files[index] ?? sample.color,
          cardFrameSize(kind, kind === "look" ? (index === 0 ? "hero" : "complement") : "item", count),
        ),
      })),
    );

  const assets = await loadReceiptAssets();
  const cards: { file: string; data: CardData }[] = [
    { file: "cartao-3.png", data: { kind: "catalog", storeName: "TRIVÉ", eyebrow: "VESTIDOS · TERROSOS", title: "Três peças para você", items: await items("catalog", 3) } },
    { file: "cartao-2.png", data: { kind: "catalog", storeName: "TRIVÉ", eyebrow: "A VITRINE DE HOJE", title: "Duas peças para você", items: await items("catalog", 2) } },
    { file: "cartao-1.png", data: { kind: "catalog", storeName: "TRIVÉ", eyebrow: "ATÉ R$ 300,00", title: "Uma peça para você", items: await items("catalog", 1) } },
  ];
  const [hero, ...complements] = await items("look", 3);
  cards.push({ file: "look.png", data: { kind: "look", storeName: "TRIVÉ", eyebrow: "O LOOK COMPLETO", title: "Um look com LONGO DUNAS", hero, complements } });

  for (const card of cards) {
    const started = Date.now();
    const png = await renderCardPng(card.data, assets);
    writeFileSync(join(out, card.file), png);
    console.log(`${join(out, card.file)} (${Date.now() - started} ms)`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
