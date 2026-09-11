// Ícones do manifest (PWA) a partir do monograma já rasterizado em
// public/brand/mark-dark-800.webp: 192 e 512 "any" (margem de 12%) e 512
// "maskable" (margem de 20%, zona segura do círculo do Android), sobre marfim.
//   node scripts/generate-pwa-icons.mjs
import path from "node:path";
import sharp from "sharp";

const root = process.cwd();
const source = path.join(root, "public/brand/mark-dark-800.webp");
const out = path.join(root, "public/brand");
const IVORY = { r: 250, g: 247, b: 240, alpha: 1 };

async function icon(size, marginRatio, file) {
  const inner = Math.round(size * (1 - marginRatio * 2));
  const mark = await sharp(source).resize({ width: inner, height: inner, fit: "inside" }).png().toBuffer();
  const meta = await sharp(mark).metadata();
  await sharp({ create: { width: size, height: size, channels: 4, background: IVORY } })
    .composite([
      {
        input: mark,
        left: Math.round((size - (meta.width ?? inner)) / 2),
        top: Math.round((size - (meta.height ?? inner)) / 2),
      },
    ])
    .png()
    .toFile(path.join(out, file));
  console.log(`gerado: public/brand/${file}`);
}

await icon(192, 0.12, "icon-192.png");
await icon(512, 0.12, "icon-512.png");
await icon(512, 0.2, "icon-512-maskable.png");
