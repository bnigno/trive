"use client";

/**
 * Reduz a foto NO NAVEGADOR antes de mandar para o servidor. Na Vercel uma
 * requisição aceita no máximo 4,5 MB (o bodySizeLimit do Next não manda
 * nisso) e uma foto de câmera tem 3–6 MB: sem reduzir, o envio morre na
 * borda e o navegador mostra "a página não carregou". Todo upload do painel
 * passa por aqui e vai UM arquivo por requisição.
 *
 * HEIC do iPhone: o Safari decodifica sozinho; Chrome/Firefox (inclusive no
 * Mac) não — e o sharp do servidor também não. Nesses casos o arquivo passa
 * pelo decodificador libheif em WASM (`heic-to`, carregado só quando aparece
 * um HEIC, ~3 MB) e vira JPEG antes de reduzir. Biblioteca de processamento
 * local sem rede, como o sharp: fica fora de adapters/ por decisão registrada.
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
 * O que impede a foto de subir depois do shrinkImage — null = pode subir.
 * HEIC que não abriu nem no navegador nem no WASM não vai ao servidor (o
 * sharp também não decodifica); passou do teto: a mensagem diz o que fazer.
 */
export function uploadBlocker(
  result: { file: { name: string; type: string; size: number }; shrunk: boolean },
  maxBytes: number = UPLOAD_MAX_BYTES,
): string | null {
  const { file, shrunk } = result;
  if (!shrunk && looksLikeHeic(file)) {
    return "Não consegui abrir este HEIC aqui. Tente de novo; se persistir, exporte como JPEG ou, no iPhone, use Ajustes → Câmera → Formatos → “Mais compatível”.";
  }
  if (file.size <= maxBytes) return null;
  return shrunk
    ? "A foto ficou grande demais mesmo reduzida. Tente outra foto ou uma resolução menor."
    : "Não consegui abrir esta foto neste navegador para reduzi-la. Tente exportar como JPEG.";
}

/** Pelo nome ou pelo tipo: o Chrome às vezes entrega HEIC com type vazio. */
export function looksLikeHeic(file: { name: string; type: string }): boolean {
  return /\.hei[cf]$/i.test(file.name) || /^image\/hei[cf]/i.test(file.type);
}

/** Decodifica o HEIC com libheif (WASM) e devolve um bitmap; null se não deu. */
async function decodeHeic(file: File): Promise<ImageBitmap | null> {
  try {
    const { heicTo, isHeic } = await import("heic-to");
    if (!(await isHeic(file))) return null;
    const jpeg = await heicTo({ blob: file, type: "image/jpeg", quality: 0.92 });
    return await createImageBitmap(jpeg, { imageOrientation: "from-image" });
  } catch {
    return null;
  }
}

export async function shrinkImage(file: File): Promise<ShrinkResult> {
  // "from-image": no iPhone o canvas não aplica a orientação sozinho e a foto
  // sairia deitada — e o JPEG do canvas não leva EXIF para o sharp corrigir.
  const native = await createImageBitmap(file, { imageOrientation: "from-image" }).catch(() => null);
  // Navegador que não abre HEIC (Chrome/Firefox): decodifica em WASM.
  const bitmap = native ?? (looksLikeHeic(file) || file.type === "" ? await decodeHeic(file) : null);
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
