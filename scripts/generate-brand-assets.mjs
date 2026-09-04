// Gera os assets de marca a partir dos SVGs de brand-source/ (rodar à mão,
// nunca no build): node scripts/generate-brand-assets.mjs
//
// Os SVGs entregues pelo designer são um traçado automático (milhares de
// <path>, ~0,5–1 MB cada): servem como FONTE, nunca vão ao navegador. Daqui
// saem rasters leves com fundo transparente, todos commitados:
//   public/brand/mark-{light,dark}-{96,192,400,800}.webp  só o monograma
//   public/brand/lockup-{light,dark}.webp                 lockup inteiro (1200w)
//   src/app/icon.png (64) e src/app/apple-icon.png (180)  monograma escuro sobre noir
//   src/app/opengraph-image.png (1200×630) + .alt.txt     lockup escuro sobre noir
//   src/components/store/brand/assets.ts                  caminhos + dimensões reais
// Trocar o logo = substituir os arquivos em brand-source/ e rodar de novo.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SOURCES = {
  light: "brand-source/lockup-light.svg",
  dark: "brand-source/lockup-dark.svg",
};
const VIEWBOX = "0 0 1800 800";
const VIEWBOX_WIDTH = 1800;
const MONOGRAM_LABEL = 'aria-label="Monograma TRIVÉ"';
// 600w existe para telas de DPR ~1,75–2,5 (Android comum): sem ela o
// navegador pulava de 400 para 800 e o hero baixava 74 KB no lugar de ~45.
const MARK_WIDTHS = [96, 192, 400, 600, 800];
const LOCKUP_WIDTH = 1200;
// Rasteriza a 2× o viewBox e reduz: o antialias do sharp suaviza o traçado.
const RENDER_WIDTH = 3600;

// Hex fechados dos tokens noir da vitrine (src/app/globals.css).
const NOIR_STAGE = "#030303";
const NOIR_950 = "#0b0a09";

function assertViewBox(svg, file) {
  if (!svg.includes(`viewBox="${VIEWBOX}"`)) {
    throw new Error(
      `${file}: esperado viewBox="${VIEWBOX}". O designer reexportou em outro tamanho? Ajuste VIEWBOX e confira os crops.`,
    );
  }
}

/** Devolve o <g …aria-label…>…</g> inteiro (com filhos), contando aberturas e fechamentos. */
function extractGroup(svg, label) {
  const at = svg.indexOf(label);
  if (at < 0) throw new Error(`grupo ${label} não encontrado no SVG`);
  const start = svg.lastIndexOf("<g", at);
  const tags = /<g\b|<\/g>/g;
  tags.lastIndex = start;
  let depth = 0;
  let match;
  while ((match = tags.exec(svg))) {
    depth += match[0] === "<g" ? 1 : -1;
    if (depth === 0) return svg.slice(start, match.index + match[0].length);
  }
  throw new Error(`grupo ${label} sem fechamento`);
}

function extractDefs(svg) {
  const match = svg.match(/<defs[\s\S]*?<\/defs>/);
  return match ? match[0] : "";
}

function wrapSvg(inner) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1800" height="800" viewBox="${VIEWBOX}">${inner}</svg>`;
}

/** Rasteriza o SVG em alta e recorta o fundo transparente. */
async function rasterTrimmed(svg) {
  const density = (72 * RENDER_WIDTH) / VIEWBOX_WIDTH;
  const raster = await sharp(Buffer.from(svg), { density }).png().toBuffer();
  return sharp(raster).trim().png().toBuffer();
}

async function writeWebp(buffer, width, outFile) {
  const info = await sharp(buffer)
    .resize({ width, withoutEnlargement: true })
    .webp({ quality: 84, alphaQuality: 90 })
    .toFile(outFile);
  return { width: info.width, height: info.height };
}

/** Monograma centrado sobre um quadrado noir (ícones). */
async function iconOn(markBuffer, size, inner, background, outFile) {
  const mark = await sharp(markBuffer)
    .resize({ width: inner, height: inner, fit: "inside" })
    .png()
    .toBuffer();
  await sharp({
    create: { width: size, height: size, channels: 4, background },
  })
    .composite([{ input: mark, gravity: "centre" }])
    .png()
    .toFile(outFile);
}

async function main() {
  const publicDir = path.join(root, "public/brand");
  const appDir = path.join(root, "src/app");
  await mkdir(publicDir, { recursive: true });

  const manifest = {};
  const trimmedMarks = {};
  const trimmedLockups = {};

  for (const [tone, source] of Object.entries(SOURCES)) {
    const file = path.join(root, source);
    const svg = await readFile(file, "utf8");
    assertViewBox(svg, source);

    const defs = extractDefs(svg);
    const markSvg = wrapSvg(defs + extractGroup(svg, MONOGRAM_LABEL));
    trimmedMarks[tone] = await rasterTrimmed(markSvg);
    trimmedLockups[tone] = await rasterTrimmed(svg);

    const variants = [];
    for (const width of MARK_WIDTHS) {
      const name = `mark-${tone}-${width}.webp`;
      const dims = await writeWebp(
        trimmedMarks[tone],
        width,
        path.join(publicDir, name),
      );
      variants.push({ src: `/brand/${name}`, ...dims });
      console.log("gerado: public/brand/" + name, dims);
    }

    const lockupName = `lockup-${tone}.webp`;
    const lockupDims = await writeWebp(
      trimmedLockups[tone],
      LOCKUP_WIDTH,
      path.join(publicDir, lockupName),
    );
    console.log("gerado: public/brand/" + lockupName, lockupDims);

    manifest[tone] = {
      mark: variants,
      lockup: { src: `/brand/${lockupName}`, ...lockupDims },
    };
  }

  // Ícones: monograma escuro sobre noir puro (iOS arredonda os cantos sozinho).
  await iconOn(
    trimmedMarks.dark,
    64,
    52,
    NOIR_STAGE,
    path.join(appDir, "icon.png"),
  );
  await iconOn(
    trimmedMarks.dark,
    180,
    136,
    NOIR_STAGE,
    path.join(appDir, "apple-icon.png"),
  );
  console.log("gerado: src/app/icon.png, src/app/apple-icon.png");

  // Open Graph: lockup escuro centrado sobre noir. A convenção de arquivo do
  // Next emite og:image com tipo/largura/altura (o WhatsApp exige dimensões).
  const ogLockup = await sharp(trimmedLockups.dark)
    .resize({ width: 900, height: 420, fit: "inside" })
    .png()
    .toBuffer();
  await sharp({
    create: { width: 1200, height: 630, channels: 4, background: NOIR_950 },
  })
    .composite([{ input: ogLockup, gravity: "centre" }])
    .png({ compressionLevel: 9 })
    .toFile(path.join(appDir, "opengraph-image.png"));
  await writeFile(
    path.join(appDir, "opengraph-image.alt.txt"),
    "TRIVÉ — Maison Féminine\n",
  );
  console.log("gerado: src/app/opengraph-image.png (+ .alt.txt)");

  const assetsTs = `// GERADO por scripts/generate-brand-assets.mjs — não editar à mão.
// Fonte da verdade: brand-source/*.svg. Dimensões lidas do raster final, para
// que todo <img> da marca nasça com width/height (zero CLS).

export interface BrandImage {
  src: string;
  width: number;
  height: number;
}

export interface BrandTone {
  /** Só o monograma, do menor para o maior (srcset). */
  mark: readonly BrandImage[];
  /** Monograma + wordmark + tagline. */
  lockup: BrandImage;
}

export const BRAND: { readonly light: BrandTone; readonly dark: BrandTone } =
  ${JSON.stringify(manifest, null, 2)};
`;
  await writeFile(
    path.join(root, "src/components/store/brand/assets.ts"),
    assetsTs,
  );
  console.log("gerado: src/components/store/brand/assets.ts");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
