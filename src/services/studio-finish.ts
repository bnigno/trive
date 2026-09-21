// Acabamento das fotos geradas com sharp (biblioteca local, sem rede — regra
// 1 permite fora de adapters): grão sutil, leve vinheta, saturação um pouco
// abaixo e o mesmo tamanho/compressão das fotos reais, para a foto de IA
// não "saltar" ao lado das outras no feed. Os números vêm do core.
import sharp, { type OverlayOptions } from "sharp";

import { FINISH_PRESET, finishStepsFor, type FinishPreset } from "@/core/studio/finish";

function vignetteSvg(width: number, height: number, opacity: number): Buffer {
  return Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><defs><radialGradient id="v" cx="50%" cy="50%" r="72%"><stop offset="55%" stop-color="#000" stop-opacity="0"/><stop offset="100%" stop-color="#000" stop-opacity="${opacity}"/></radialGradient></defs><rect width="100%" height="100%" fill="url(#v)"/></svg>`,
  );
}

export async function finishStudioImage(source: Buffer, preset: FinishPreset = FINISH_PRESET): Promise<Buffer> {
  const { data, info } = await sharp(source)
    .rotate()
    .resize({ width: preset.maxEdge, height: preset.maxEdge, fit: "inside", withoutEnlargement: true })
    .modulate({ saturation: preset.saturation })
    .toBuffer({ resolveWithObject: true });

  const steps = finishStepsFor(preset);
  const layers: OverlayOptions[] = [];
  if (steps.grain) {
    // Ruído em torno do cinza médio em soft-light: 128 não muda nada, o
    // desvio vira o grão.
    const grain = await sharp({
      create: {
        width: info.width,
        height: info.height,
        channels: 3,
        background: { r: 128, g: 128, b: 128 },
        noise: { type: "gaussian", mean: 128, sigma: preset.grainSigma },
      },
    })
      .png()
      .toBuffer();
    layers.push({ input: grain, blend: "soft-light" });
  }
  if (steps.vignette) {
    layers.push({ input: vignetteSvg(info.width, info.height, preset.vignette), blend: "over" });
  }

  const finished = layers.length > 0 ? sharp(data).composite(layers) : sharp(data);
  return finished.jpeg({ quality: preset.jpegQuality, mozjpeg: true }).toBuffer();
}
