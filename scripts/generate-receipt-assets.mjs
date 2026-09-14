// Embute em base64 as fontes (subset latim, brand-source/fonts/subset) e o
// lockup escuro (PNG 900×400 que scripts/generate-brand-assets.mjs compõe em
// brand-source/generated/) que o comprovante, os cartões e o Bom dia usam:
//   node scripts/generate-receipt-assets.mjs  →  src/receipts/assets.generated.ts
// Rodar à mão quando trocar uma fonte ou o logo (depois do generate-brand-assets);
// o arquivo gerado é versionado porque em produção nada é lido do disco (o
// Satori recebe Buffers).
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const FONTS = {
  jostRegular: "brand-source/fonts/subset/Jost-Regular.ttf",
  jostMedium: "brand-source/fonts/subset/Jost-Medium.ttf",
  cormorantSemiBold: "brand-source/fonts/subset/CormorantGaramond-SemiBold.ttf",
  cormorantItalic: "brand-source/fonts/subset/CormorantGaramond-Italic.ttf",
};
const LOCKUP_PNG = "brand-source/generated/lockup-dark-900.png";
// Proporção 2,25 que todo <img width height> do Satori assume.
const LOCKUP = { width: 900, height: 400 };

async function fontB64(relative) {
  const data = await readFile(path.join(root, relative));
  if (data.length === 0) throw new Error(`Fonte vazia: ${relative}`);
  return data.toString("base64");
}

async function lockupB64() {
  const png = await readFile(path.join(root, LOCKUP_PNG));
  const { width, height } = await sharp(png).metadata();
  if (width !== LOCKUP.width || height !== LOCKUP.height) {
    throw new Error(
      `${LOCKUP_PNG}: esperado ${LOCKUP.width}×${LOCKUP.height}, veio ${width}×${height} — rode node scripts/generate-brand-assets.mjs antes`,
    );
  }
  return png.toString("base64");
}

const entries = {};
for (const [key, relative] of Object.entries(FONTS)) {
  entries[key] = await fontB64(relative);
}
entries.lockupDarkPng = await lockupB64();

const lines = [
  "// GERADO por scripts/generate-receipt-assets.mjs — não editar à mão.",
  "// Fontes (subset latim, OFL) e lockup escuro (PNG) do comprovante em base64.",
  "export const RECEIPT_ASSETS_B64 = {",
  ...Object.entries(entries).map(([key, value]) => `  ${key}:\n    "${value}",`),
  "} as const;",
  "",
];
const out = path.join(root, "src/receipts/assets.generated.ts");
await writeFile(out, lines.join("\n"));
const total = Object.values(entries).reduce((sum, value) => sum + value.length, 0);
console.log(`ok: ${path.relative(root, out)} (${Math.round(total / 1024)} KB em base64)`);
