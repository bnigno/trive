// Gera os PNGs de marca a partir do monograma provisório (rodar manualmente,
// nunca no build): node scripts/generate-brand-assets.mjs
//   → src/app/apple-icon.png   (180×180, monograma dourado sobre ink sólido)
//   → public/brand/og.png      (1200×630, fundo marfim, monograma + wordmark)
// Fonte da verdade da arte: src/components/store/brand/monogram.tsx — na troca
// pelo logo real, atualizar também os SVGs abaixo e re-rodar.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Paleta da vitrine (hex fechados dos tokens em src/app/globals.css).
const INK_950 = "#171512";
const INK_900 = "#201D18";
const GOLD_300 = "#E6D3A3";
const GOLD_400 = "#D4B96A";
const GOLD_500 = "#C0A050";
const IVORY_100 = "#FAF7F0";

const T_PATH =
  "M 20.2 24.6 L 43.8 24.6 L 43.8 30.2 C 43.3 27.9 42.4 27.1 39.8 27 " +
  "L 34.3 27 L 34.3 42.4 C 34.3 44.3 35.2 44.8 38.1 45 L 38.1 45.9 " +
  "L 25.9 45.9 L 25.9 45 C 28.8 44.8 29.7 44.3 29.7 42.4 L 29.7 27 " +
  "L 24.2 27 C 21.6 27.1 20.7 27.9 20.2 30.2 Z";

/** Miolo do monograma (caixa 64×64). tone "ink" = disco escuro; "gold" = sem
 *  disco, para fundos já escuros (mesma regra do componente React). */
function monogramGroup(tone) {
  const onDark = tone === "gold";
  const ring = onDark ? GOLD_400 : GOLD_500;
  const mark = onDark ? GOLD_300 : GOLD_400;
  const disc = onDark
    ? ""
    : `<circle cx="32" cy="32" r="31" fill="${INK_950}"/>`;
  return `${disc}
    <circle cx="32" cy="32" r="26" fill="none" stroke="${ring}" stroke-width="1"/>
    <path d="${T_PATH}" fill="${mark}"/>
    <circle cx="28.8" cy="20.8" r="1.5" fill="${mark}"/>
    <circle cx="35.2" cy="20.8" r="1.5" fill="${mark}"/>`;
}

// 180×180 — monograma dourado sobre ink sólido (iOS arredonda os cantos).
const appleIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180" viewBox="0 0 180 180">
  <rect width="180" height="180" fill="${INK_950}"/>
  <g transform="translate(26 26) scale(2)">${monogramGroup("gold")}</g>
</svg>`;

// 1200×630 — fundo marfim, monograma grande centrado + wordmark serifado.
// <text> com serif do sistema (Georgia): o PNG congela a fonte, sem webfont.
const ogSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="${IVORY_100}"/>
  <g transform="translate(488 108) scale(3.5)">${monogramGroup("ink")}</g>
  <text x="612" y="472" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="76" letter-spacing="24" fill="${INK_900}">TRIVË</text>
  <line x1="450" y1="524" x2="558" y2="524" stroke="${GOLD_500}" stroke-width="1.5"/>
  <line x1="642" y1="524" x2="750" y2="524" stroke="${GOLD_500}" stroke-width="1.5"/>
  <rect x="592" y="516" width="16" height="16" transform="rotate(45 600 524)" fill="none" stroke="${GOLD_500}" stroke-width="1.5"/>
</svg>`;

async function main() {
  const appleIconOut = path.join(root, "src/app/apple-icon.png");
  const ogOut = path.join(root, "public/brand/og.png");
  await mkdir(path.dirname(ogOut), { recursive: true });

  await sharp(Buffer.from(appleIconSvg)).png().toFile(appleIconOut);
  await sharp(Buffer.from(ogSvg)).png().toFile(ogOut);

  console.log("gerado:", path.relative(root, appleIconOut));
  console.log("gerado:", path.relative(root, ogOut));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
