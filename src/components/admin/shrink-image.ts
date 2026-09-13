"use client";

/**
 * Reduz a foto NO NAVEGADOR antes de mandar para o servidor. Na Vercel uma
 * requisição aceita no máximo 4,5 MB (o bodySizeLimit do Next não manda
 * nisso) e uma foto de câmera tem 3–6 MB: sem reduzir, o envio morre na
 * borda e o navegador mostra "a página não carregou". O canvas também
 * resolve o HEIC do iPhone (o Safari entrega JPEG ao canvas; o sharp do
 * servidor não decodifica HEIC). Todo upload do painel passa por aqui e vai
 * UM arquivo por requisição.
 */
export const SHRINK_MAX_EDGE = 1600;
export const SHRINK_QUALITY = 0.85;

/** Teto por requisição com folga sob os 4,5 MB da Vercel (multipart pesa). */
export const UPLOAD_MAX_BYTES = 4 * 1024 * 1024;

export type ShrinkResult = { file: File; shrunk: boolean };

/** Lado maior em `maxEdge`, sem ampliar, nunca abaixo de 1 px. */
export function fitWithin(width: number, height: number, maxEdge: number): { width: number; height: number } {
  const scale = Math.min(1, maxEdge / Math.max(width, height, 1));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Depois de reduzir, a foto ainda passa do teto? Só acontece quando o
 * navegador não conseguiu decodificar o arquivo (HEIC fora do Safari) —
 * a mensagem diz o que fazer. null = pode subir.
 */
export function uploadBlocker(sizeBytes: number, shrunk: boolean, maxBytes: number = UPLOAD_MAX_BYTES): string | null {
  if (sizeBytes <= maxBytes) return null;
  return shrunk
    ? "A foto ficou grande demais mesmo reduzida. Tente outra foto ou uma resolução menor."
    : "Este navegador não consegue preparar fotos neste formato (HEIC). Converta para JPEG ou, no iPhone, use Ajustes → Câmera → Formatos → “Mais compatível”.";
}

export async function shrinkImage(file: File): Promise<ShrinkResult> {
  // "from-image": no iPhone o canvas não aplica a orientação sozinho e a foto
  // sairia deitada — e o JPEG do canvas não leva EXIF para o sharp corrigir.
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" }).catch(() => null);
  if (!bitmap) return { file, shrunk: false };
  const { width, height } = fitWithin(bitmap.width, bitmap.height, SHRINK_MAX_EDGE);

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
