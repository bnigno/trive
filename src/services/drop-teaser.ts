// As silhuetas da estreia: a foto de cada peça do lançamento, pequena e
// desfocada (sharp), embutida como data URL — a cliente vê formas e cores
// atrás do véu, nunca a peça. Foto que falhar fica de fora, sem derrubar.
import sharp from "sharp";

import type { FileStorage } from "@/adapters/storage";

export const SILHOUETTE_WIDTH = 240;
export const SILHOUETTE_BLUR = 14;

function thumbPath(path: string): string {
  return path.replace("-full.webp", "-thumb.webp");
}

export async function buildSilhouette(storage: FileStorage, imagePath: string): Promise<string | null> {
  try {
    let file: { data: Buffer };
    try {
      file = await storage.download(thumbPath(imagePath));
    } catch {
      file = await storage.download(imagePath);
    }
    const webp = await sharp(file.data)
      .rotate()
      .resize({ width: SILHOUETTE_WIDTH, height: Math.round(SILHOUETTE_WIDTH * 1.25), fit: "cover", position: "attention" })
      .blur(SILHOUETTE_BLUR)
      .modulate({ saturation: 0.85 })
      .webp({ quality: 60 })
      .toBuffer();
    return `data:image/webp;base64,${webp.toString("base64")}`;
  } catch {
    return null;
  }
}

/** Uma silhueta por caminho, na mesma ordem; null onde a foto não abriu. */
export async function buildSilhouettes(storage: FileStorage, imagePaths: readonly (string | null)[]): Promise<(string | null)[]> {
  return Promise.all(imagePaths.map((path) => (path ? buildSilhouette(storage, path) : Promise.resolve(null))));
}
