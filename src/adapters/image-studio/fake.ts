import sharp from "sharp";

import { creditsFor, creditsToUsdCents, videoCreditsFor } from "@/core/studio/cost";

import {
  clampStudioCount,
  StudioUnavailableError,
  type AnimateInput,
  type CreateModelPhotoInput,
  type GenerateOnModelInput,
  type ImageStudio,
  type StudioAspectRatio,
  type StudioImage,
  type StudioVideo,
} from "./index";

/**
 * Um MP4 mínimo de mentira (só a caixa "ftyp" + um rótulo): passa na
 * checagem de formato, não toca em player nenhum — o fake é para o fluxo,
 * não para ver o vídeo.
 */
function fakeMp4(label: string): Buffer {
  const ftyp = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom", "latin1"), Buffer.from([0, 0, 2, 0]), Buffer.from("isomiso2", "latin1")]);
  return Buffer.concat([ftyp, Buffer.from(`FAKE ${label}`, "utf8")]);
}

const FAKE_SIZES: Record<StudioAspectRatio, { width: number; height: number }> = {
  "3:4": { width: 900, height: 1200 },
  "4:5": { width: 1080, height: 1350 },
  "9:16": { width: 1080, height: 1920 },
};

/** Faixa "FAKE" que ninguém confunde com foto de verdade. */
function bandSvg(width: number, height: number, lines: string[]): Buffer {
  const bandHeight = Math.round(height * 0.16);
  const fontSize = Math.round(bandHeight * 0.34);
  const text = lines
    .map(
      (line, index) =>
        `<text x="${width / 2}" y="${height - bandHeight + fontSize * (1.25 + index * 1.15)}" font-family="sans-serif" font-size="${index === 0 ? fontSize : Math.round(fontSize * 0.6)}" font-weight="700" fill="#ffffff" text-anchor="middle">${line}</text>`,
    )
    .join("");
  return Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><rect x="0" y="${height - bandHeight}" width="${width}" height="${bandHeight}" fill="#d0021b" fill-opacity="0.85"/>${text}</svg>`,
  );
}

/**
 * Gerador roteirizável para dev e testes: `generateOnModel` devolve a própria
 * foto da peça com a faixa "FAKE"; `createModelPhoto` devolve um retângulo
 * cinza com a faixa. Grava as chamadas; `failNext()` simula o vendor fora do
 * ar. Custo em centavos segue a mesma tabela do real (o painel mostra a
 * conta certa mesmo em dev).
 */
export class FakeImageStudio implements ImageStudio {
  readonly modelPhotos: CreateModelPhotoInput[] = [];
  readonly generations: GenerateOnModelInput[] = [];
  readonly animations: AnimateInput[] = [];
  private readonly failures: Error[] = [];

  failNext(error: Error = new StudioUnavailableError("gerador fora do ar (fake)", "unavailable")): void {
    this.failures.push(error);
  }

  async createModelPhoto(input: CreateModelPhotoInput): Promise<StudioImage[]> {
    this.modelPhotos.push(input);
    this.throwIfScripted();
    const { width, height } = FAKE_SIZES[input.aspectRatio];
    const credits = creditsFor("model_photo", input.quality, 1);
    const images: StudioImage[] = [];
    for (let index = 0; index < clampStudioCount(input.count); index += 1) {
      const seed = (input.seed ?? 42) + index;
      const data = await sharp({ create: { width, height, channels: 3, background: { r: 176, g: 168, b: 158 } } })
        .composite([{ input: bandSvg(width, height, ["FAKE", `modelo · semente ${seed}`]) }])
        .jpeg({ quality: 80 })
        .toBuffer();
      images.push({ data, mimeType: "image/jpeg", vendor: "fake", vendorModel: "fake-model-create", creditsUsed: credits, usdCents: creditsToUsdCents(credits), elapsedMs: 5, seed });
    }
    return images;
  }

  async generateOnModel(input: GenerateOnModelInput): Promise<StudioImage[]> {
    this.generations.push(input);
    this.throwIfScripted();
    let baseData: Buffer;
    let info: { width: number; height: number };
    try {
      ({ data: baseData, info } = await sharp(input.garment.data)
        .rotate()
        .resize({ width: 900, height: 1200, fit: "inside", withoutEnlargement: true })
        .toBuffer({ resolveWithObject: true }));
    } catch {
      // O real recusa foto ilegível; o fake também, com o mesmo erro.
      throw new StudioUnavailableError("A foto da peça não é uma imagem válida (fake).", "rejected");
    }
    const credits = creditsFor("tryon", input.quality, 1);
    const images: StudioImage[] = [];
    for (let index = 0; index < clampStudioCount(input.count); index += 1) {
      const seed = (input.seed ?? 42) + index;
      const data = await sharp(baseData)
        .composite([{ input: bandSvg(info.width, info.height, ["FAKE", `opção ${index + 1} · ${input.quality} · semente ${seed}`]) }])
        .jpeg({ quality: 80 })
        .toBuffer();
      images.push({ data, mimeType: "image/jpeg", vendor: "fake", vendorModel: input.quality === "alta" ? "fake-tryon-max" : "fake-tryon", creditsUsed: credits, usdCents: creditsToUsdCents(credits), elapsedMs: 5, seed });
    }
    return images;
  }

  async animate(input: AnimateInput): Promise<StudioVideo> {
    this.animations.push(input);
    this.throwIfScripted();
    try {
      await sharp(input.image.data).metadata();
    } catch {
      throw new StudioUnavailableError("A foto não é uma imagem válida (fake).", "rejected");
    }
    const credits = videoCreditsFor(input.durationSeconds, input.resolution);
    return {
      data: fakeMp4(`${input.durationSeconds}s ${input.resolution}${input.endImage ? " com costas" : ""}`),
      mimeType: "video/mp4",
      vendor: "fake",
      vendorModel: "fake-image-to-video",
      creditsUsed: credits,
      usdCents: creditsToUsdCents(credits),
      elapsedMs: 5,
    };
  }

  reset(): void {
    this.modelPhotos.length = 0;
    this.generations.length = 0;
    this.animations.length = 0;
    this.failures.length = 0;
  }

  private throwIfScripted(): void {
    const next = this.failures.shift();
    if (next) throw next;
  }
}
