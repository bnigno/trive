"use client";

/**
 * Reduz a foto NO CELULAR antes de mandar para o servidor: a server action
 * aceita 8 MB por requisição e três fotos de câmera passam disso fácil.
 * O canvas também resolve o HEIC do iPhone (o Safari entrega JPEG ao canvas;
 * o sharp do servidor não decodifica HEIC).
 */
export const SHRINK_MAX_EDGE = 1600;
export const SHRINK_QUALITY = 0.85;

export type ShrinkResult = { file: File; shrunk: boolean };

export async function shrinkImage(file: File): Promise<ShrinkResult> {
  // "from-image": no iPhone o canvas não aplica a orientação sozinho e a foto
  // sairia deitada — e o JPEG do canvas não leva EXIF para o sharp corrigir.
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" }).catch(() => null);
  if (!bitmap) return { file, shrunk: false };
  const scale = Math.min(1, SHRINK_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    bitmap.close();
    return { file, shrunk: false };
  }
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, "image/jpeg", SHRINK_QUALITY);
  });
  if (!blob) return { file, shrunk: false };
  const name = file.name.replace(/\.[^.]+$/, "") || "foto";
  return {
    file: new File([blob], `${name}.jpg`, { type: "image/jpeg", lastModified: file.lastModified }),
    shrunk: true,
  };
}
