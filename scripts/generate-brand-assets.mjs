// Gera os assets de marca a partir de brand-source/logo.svg (rodar à mão,
// nunca no build): node scripts/generate-brand-assets.mjs
//
// A fonte é o export do designer (Canva, 2026-09-14) curado por
// scripts/curate-brand-source.py, que envolve as partes em grupos com id:
//   #monograma  T e V entrelaçados pela fita rosé — no export atual é um
//               bitmap mascarado (569×648 px), então acima de ~600 px de
//               largura o raster fica levemente suave; um vetor de verdade
//               (ou brand-source/monograma.png em alta, fundo transparente,
//               que tem prioridade quando existe) resolve sem tocar aqui.
//   #wordmark   as letras TRIVÉ em <path> (vetor)
//   #tagline    as letras MAISON FÉMININE em <path> (vetor)
//   #filetes    os dois filetes rosé em raster — ignorados; o pipeline desenha
//               filetes vetoriais nas cores dos tokens
// O logo entregue é empilhado e escuro; daqui saem, todos commitados:
//   public/brand/mark-{light,dark}-{96,192,400,600,800}.webp  só o monograma
//               (o ouro metálico funciona sobre marfim e sobre noir: light e
//               dark são o mesmo raster, nomes mantidos pelos consumidores)
//   public/brand/lockup-{light,dark}.webp   lockup HORIZONTAL (1200w) composto
//               aqui: monograma à esquerda, TRIVÉ e MAISON FÉMININE à direita
//   brand-source/generated/lockup-dark-900.png  o mesmo lockup, canvas
//               inteiro 900×400 (proporção 2,25) que o Satori embute
//               (scripts/generate-receipt-assets.mjs)
//   src/app/icon.png (64) e src/app/apple-icon.png (180)  monograma sobre noir
//   src/app/opengraph-image.png (1200×630) + .alt.txt     lockup escuro sobre noir
//   src/components/store/brand/assets.ts      caminhos + dimensões reais
//   src/components/store/brand/lettering.generated.ts  os <path> de TRIVÉ e
//               MAISON FÉMININE para o letreiro em SVG inline (fill herdado)
// Trocar o logo = curar o SVG novo em brand-source/logo.svg e rodar de novo
// (depois: generate-pwa-icons.mjs e generate-receipt-assets.mjs).
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SOURCE = "brand-source/logo.svg";
const MONOGRAM_OVERRIDE = "brand-source/monograma.png";
// 600w existe para telas de DPR ~1,75–2,5 (Android comum): sem ela o
// navegador pulava de 400 para 800 e o hero baixava 74 KB no lugar de ~45.
const MARK_WIDTHS = [96, 192, 400, 600, 800];
const LOCKUP_WIDTH = 1200;
const RECEIPT_LOCKUP = { width: 900, height: 400 };
// Rasteriza a 4× o viewBox: as caixas do letreiro saem com 0,25 unidade de
// precisão e o monograma nasce maior do que a maior saída.
const RENDER_SCALE = 4;

// Canvas do lockup horizontal (mesmo do lockup legado, proporção 2,25) e a
// composição, em unidades do canvas.
const CANVAS = { width: 1800, height: 800 };
const LAYOUT = {
  mark: { x: 60, height: 710 },
  /** Largura de TRIVÉ; MAISON FÉMININE segue a proporção do próprio logo. */
  wordmarkWidth: 900,
  gapAfterMark: 130,
  filet: { lengthRatio: 0.22, gapRatio: 0.09, stroke: 3 },
};

// Hex fechados dos tokens da vitrine (src/app/globals.css); no escuro o ouro e
// o marfim são os do próprio logo.
const NOIR_STAGE = "#030303";
const NOIR_950 = "#0b0a09";
const TONES = {
  dark: { wordmark: "#c29a5d", tagline: "#f2eae2", filet: "#dbbba4" },
  light: { wordmark: "#6f561b", tagline: "#806c64", filet: "#865749" },
};

function readViewBox(svg) {
  const match = svg.match(/viewBox="([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)"/);
  if (!match) throw new Error(`${SOURCE}: sem viewBox`);
  const [x, y, width, height] = match.slice(1).map(Number);
  return { x, y, width, height };
}

/** O <g id="…">…</g> inteiro, contando aberturas e fechamentos (o <g/> vazio não abre nível). */
function extractById(svg, id) {
  const start = svg.indexOf(`<g id="${id}"`);
  if (start < 0) {
    throw new Error(
      `${SOURCE}: grupo #${id} não encontrado — rode scripts/curate-brand-source.py no SVG entregue`,
    );
  }
  const tags = /<g\b[^>]*>|<\/g>/g;
  tags.lastIndex = start;
  let depth = 0;
  let match;
  while ((match = tags.exec(svg))) {
    if (match[0].endsWith("/>")) continue;
    depth += match[0] === "</g>" ? -1 : 1;
    if (depth === 0) return svg.slice(start, match.index + match[0].length);
  }
  throw new Error(`${SOURCE}: grupo #${id} sem fechamento`);
}

/** Tudo que um grupo pode referenciar por url(#id): <defs> inteiros e máscaras/clips/filtros soltos. */
function collectDefs(svg) {
  const blocks = svg.match(
    /<(defs|mask|clipPath|filter|linearGradient|radialGradient|pattern)\b[\s\S]*?<\/\1>/g,
  );
  return blocks ? blocks.join("") : "";
}

function wrapSvg(viewBox, inner) {
  const vb = `${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${viewBox.width}" height="${viewBox.height}" viewBox="${vb}">${inner}</svg>`;
}

/** Rasteriza a RENDER_SCALE×, recorta o transparente e devolve a caixa em unidades do viewBox. */
async function rasterTrimmed(svg, viewBox, scale = RENDER_SCALE) {
  const raster = await sharp(Buffer.from(svg), { density: 72 * scale })
    .png()
    .toBuffer();
  const { data, info } = await sharp(raster)
    .trim()
    .png()
    .toBuffer({ resolveWithObject: true });
  const box = {
    x: viewBox.x - info.trimOffsetLeft / scale,
    y: viewBox.y - info.trimOffsetTop / scale,
    width: info.width / scale,
    height: info.height / scale,
  };
  return { buffer: data, box };
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/** Arredonda os números do path a 2 casas e tira os espaços dispensáveis. */
function compactPath(d) {
  return d
    .replace(/-?\d*\.\d+/g, (n) => String(Math.round(Number(n) * 100) / 100))
    .replace(/\s+/g, " ")
    .replace(/ ?([A-Za-z]) ?/g, "$1")
    .replace(/ -/g, "-")
    .trim();
}

/** Os glifos de um grupo do letreiro: cada <g transform="translate(x, y)"> com um <path>. */
function extractGlyphs(group, id) {
  const glyphs = [];
  const re = /translate\(([-\d.]+),\s*([-\d.]+)\)"[^>]*>\s*<g>\s*<path d="([^"]+)"/g;
  let match;
  while ((match = re.exec(group))) {
    glyphs.push({
      d: compactPath(match[3]),
      x: round(Number(match[1])),
      y: round(Number(match[2])),
    });
  }
  if (glyphs.length === 0) {
    throw new Error(`${SOURCE}: #${id} sem glifos <path> — o Canva exportou o letreiro como imagem?`);
  }
  return glyphs;
}

function round(n, places = 2) {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

function glyphsSvg(glyphs, fill) {
  return glyphs
    .map(
      (g) =>
        `<g transform="translate(${g.x} ${g.y})"><path fill="${fill}" d="${g.d}"/></g>`,
    )
    .join("");
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

/**
 * Lockup horizontal no canvas 1800×800: o monograma (raster) à esquerda e, à
 * direita, TRIVÉ com MAISON FÉMININE abaixo nas posições relativas do próprio
 * logo (o designer já os alinhou), entre dois filetes. Devolve o canvas
 * inteiro rasterizado a 2×, com fundo transparente.
 */
async function composeLockup(mark, lettering, colors) {
  const scale = 2;
  const markWidth = round((LAYOUT.mark.height * mark.box.width) / mark.box.height);
  const markY = (CANVAS.height - LAYOUT.mark.height) / 2;

  const { wordmark, tagline } = lettering;
  const s = LAYOUT.wordmarkWidth / wordmark.box.width;
  const blockTop = Math.min(wordmark.box.y, tagline.box.y);
  const blockBottom = Math.max(
    wordmark.box.y + wordmark.box.height,
    tagline.box.y + tagline.box.height,
  );
  const tx = LAYOUT.mark.x + markWidth + LAYOUT.gapAfterMark - wordmark.box.x * s;
  const ty = CANVAS.height / 2 - ((blockTop + blockBottom) / 2) * s;

  const filetLength = tagline.box.width * LAYOUT.filet.lengthRatio;
  const filetGap = tagline.box.width * LAYOUT.filet.gapRatio;
  const filetY = tagline.box.y + tagline.box.height / 2;
  const filet = (x1, x2) =>
    `<line x1="${x1}" x2="${x2}" y1="${filetY}" y2="${filetY}" stroke="${colors.filet}" stroke-width="${LAYOUT.filet.stroke / s}" stroke-linecap="round"/>`;
  const filets =
    filet(tagline.box.x - filetGap - filetLength, tagline.box.x - filetGap) +
    filet(
      tagline.box.x + tagline.box.width + filetGap,
      tagline.box.x + tagline.box.width + filetGap + filetLength,
    );

  const letteringSvg = wrapSvg(
    { x: 0, y: 0, ...CANVAS },
    `<g transform="translate(${tx} ${ty}) scale(${s})">` +
      glyphsSvg(wordmark.glyphs, colors.wordmark) +
      glyphsSvg(tagline.glyphs, colors.tagline) +
      filets +
      "</g>",
  );
  const letteringPng = await sharp(Buffer.from(letteringSvg), { density: 72 * scale })
    .png()
    .toBuffer();
  const markPng = await sharp(mark.buffer)
    .resize({ height: LAYOUT.mark.height * scale })
    .png()
    .toBuffer();
  return sharp(letteringPng)
    .composite([
      {
        input: markPng,
        left: Math.round(LAYOUT.mark.x * scale),
        top: Math.round(markY * scale),
      },
    ])
    .png()
    .toBuffer();
}

function letteringTs(lettering) {
  const part = (name, { glyphs, box }) => {
    const viewBox = [box.x, box.y, box.width, box.height].map((n) => round(n)).join(" ");
    const lines = glyphs.map(
      (g) => `    { x: ${g.x}, y: ${g.y}, d: ${JSON.stringify(g.d)} },`,
    );
    return `export const ${name}: Lettering = {
  viewBox: "${viewBox}",
  width: ${round(box.width)},
  height: ${round(box.height)},
  glyphs: [
${lines.join("\n")}
  ],
};
`;
  };
  return `// GERADO por scripts/generate-brand-assets.mjs — não editar à mão.
// Os <path> de TRIVÉ e de MAISON FÉMININE tirados de brand-source/logo.svg,
// nas coordenadas do próprio logo: o viewBox de cada um é a caixa exata da
// tinta (medida no raster), para o <svg> nascer com a proporção certa.

export interface LetteringGlyph {
  readonly d: string;
  readonly x: number;
  readonly y: number;
}

export interface Lettering {
  readonly viewBox: string;
  readonly width: number;
  readonly height: number;
  readonly glyphs: readonly LetteringGlyph[];
}

${part("WORDMARK_LETTERING", lettering.wordmark)}
${part("TAGLINE_LETTERING", lettering.tagline)}`;
}

async function main() {
  const publicDir = path.join(root, "public/brand");
  const appDir = path.join(root, "src/app");
  const generatedDir = path.join(root, "brand-source/generated");
  await mkdir(publicDir, { recursive: true });
  await mkdir(generatedDir, { recursive: true });

  const svg = await readFile(path.join(root, SOURCE), "utf8");
  const viewBox = readViewBox(svg);
  const defs = collectDefs(svg);

  // Monograma: PNG em alta do designer, se existir; senão o grupo do SVG.
  let mark;
  const overrideFile = path.join(root, MONOGRAM_OVERRIDE);
  if (await exists(overrideFile)) {
    const { data, info } = await sharp(overrideFile)
      .ensureAlpha()
      .trim()
      .png()
      .toBuffer({ resolveWithObject: true });
    mark = { buffer: data, box: { x: 0, y: 0, width: info.width, height: info.height } };
    console.log(`monograma: ${MONOGRAM_OVERRIDE} (${info.width}×${info.height})`);
  } else {
    mark = await rasterTrimmed(
      wrapSvg(viewBox, defs + extractById(svg, "monograma")),
      viewBox,
    );
    console.log(
      `monograma: #monograma do SVG (${round(mark.box.width)}×${round(mark.box.height)} unidades)`,
    );
  }

  // Letreiro: glifos + caixa exata da tinta de cada grupo.
  const lettering = {};
  for (const id of ["wordmark", "tagline"]) {
    const group = extractById(svg, id);
    const { box } = await rasterTrimmed(wrapSvg(viewBox, defs + group), viewBox);
    lettering[id] = { glyphs: extractGlyphs(group, id), box };
    console.log(`${id}: ${lettering[id].glyphs.length} glifos, caixa`, box);
  }
  await writeFile(
    path.join(root, "src/components/store/brand/lettering.generated.ts"),
    letteringTs(lettering),
  );
  console.log("gerado: src/components/store/brand/lettering.generated.ts");

  const manifest = {};
  const lockups = {};
  for (const [tone, colors] of Object.entries(TONES)) {
    const variants = [];
    for (const width of MARK_WIDTHS) {
      const name = `mark-${tone}-${width}.webp`;
      const dims = await writeWebp(mark.buffer, width, path.join(publicDir, name));
      variants.push({ src: `/brand/${name}`, ...dims });
      console.log("gerado: public/brand/" + name, dims);
    }

    const canvas = await composeLockup(mark, lettering, colors);
    lockups[tone] = { canvas, trimmed: await sharp(canvas).trim().png().toBuffer() };
    const lockupName = `lockup-${tone}.webp`;
    const lockupDims = await writeWebp(
      lockups[tone].trimmed,
      LOCKUP_WIDTH,
      path.join(publicDir, lockupName),
    );
    console.log("gerado: public/brand/" + lockupName, lockupDims);

    manifest[tone] = {
      mark: variants,
      lockup: { src: `/brand/${lockupName}`, ...lockupDims },
    };
  }

  // O canvas inteiro (com margens) na proporção 2,25 que os recibos, cartões e
  // o Bom dia mostram em <img width height> fixos.
  await sharp(lockups.dark.canvas)
    .resize(RECEIPT_LOCKUP)
    .png({ compressionLevel: 9 })
    .toFile(path.join(generatedDir, "lockup-dark-900.png"));
  console.log("gerado: brand-source/generated/lockup-dark-900.png");

  // Ícones: monograma sobre noir puro (iOS arredonda os cantos sozinho).
  await iconOn(mark.buffer, 64, 52, NOIR_STAGE, path.join(appDir, "icon.png"));
  await iconOn(mark.buffer, 180, 136, NOIR_STAGE, path.join(appDir, "apple-icon.png"));
  console.log("gerado: src/app/icon.png, src/app/apple-icon.png");

  // Open Graph: lockup escuro centrado sobre noir. A convenção de arquivo do
  // Next emite og:image com tipo/largura/altura (o WhatsApp exige dimensões).
  const ogLockup = await sharp(lockups.dark.trimmed)
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
// Fonte da verdade: brand-source/logo.svg. Dimensões lidas do raster final,
// para que todo <img> da marca nasça com width/height (zero CLS).

export interface BrandImage {
  src: string;
  width: number;
  height: number;
}

export interface BrandTone {
  /** Só o monograma, do menor para o maior (srcset). */
  mark: readonly BrandImage[];
  /** Monograma + wordmark + tagline, na horizontal. */
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
