// Mídia da cliente a caminho do modelo: a foto é baixada da Z-API, reduzida
// (≤ 1024 px, JPEG) e vai como bloco de imagem só no turno em que chegou;
// nada é guardado no nosso Storage nem no audit. Tudo é melhor esforço com
// orçamento de tempo: uma foto que não abre vira marcador e o turno segue.
import { eq } from "drizzle-orm";
import sharp from "sharp";

import type { BotImageInput } from "@/adapters/assistant";
import type { MessagingProvider } from "@/adapters/zapi";
import { settings } from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";

export const MODEL_IMAGE_MAX_EDGE = 1024;
export const INBOUND_IMAGE_MAX_BYTES = 6 * 1024 * 1024;
export const MAX_IMAGES_PER_TURN = 3;
/** Orçamento total para baixar e preparar as fotos de um turno. */
export const IMAGE_FETCH_BUDGET_MS = 8_000;

/** Setting bot_media_enabled: ausente = ligado. */
export async function isBotMediaEnabled(db: DbOrTx): Promise<boolean> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, "bot_media_enabled"))
    .limit(1);
  return row?.value !== false;
}

/** Reduz e recodifica em JPEG (orientação pelo EXIF, metadados descartados). */
export async function prepareImageForModel(
  data: Buffer,
): Promise<BotImageInput & { width: number; height: number }> {
  // Teto de pixels: foto gigante (ou "zip bomb" de imagem) não pode derrubar
  // a função — 50 MP cobre qualquer celular com folga.
  const { data: jpeg, info } = await sharp(data, { limitInputPixels: 50_000_000 })
    .rotate()
    .resize({
      width: MODEL_IMAGE_MAX_EDGE,
      height: MODEL_IMAGE_MAX_EDGE,
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: 80 })
    .toBuffer({ resolveWithObject: true });
  return {
    mediaType: "image/jpeg",
    base64: jpeg.toString("base64"),
    width: info.width,
    height: info.height,
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("tempo esgotado")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Baixa e prepara as fotos do turno, em paralelo e dentro do orçamento.
 * Falha individual (URL expirada, arquivo grande, tempo) = a foto fica de
 * fora do Map; quem chama coloca o marcador no lugar.
 */
export async function loadTurnImages(
  provider: MessagingProvider,
  urls: readonly string[],
): Promise<Map<string, BotImageInput>> {
  const result = new Map<string, BotImageInput>();
  const unique = [...new Set(urls)].slice(-MAX_IMAGES_PER_TURN);
  if (unique.length === 0) return result;

  const settled = await Promise.allSettled(
    unique.map((url) =>
      withTimeout(
        (async () => {
          const media = await provider.downloadMedia({ url, maxBytes: INBOUND_IMAGE_MAX_BYTES });
          const prepared = await prepareImageForModel(media.data);
          return { url, image: { mediaType: prepared.mediaType, base64: prepared.base64 } };
        })(),
        IMAGE_FETCH_BUDGET_MS,
      ),
    ),
  );
  for (const outcome of settled) {
    if (outcome.status === "fulfilled") {
      result.set(outcome.value.url, outcome.value.image);
    } else {
      console.warn("[wa-media] foto da cliente não anexada:", outcome.reason?.message ?? outcome.reason);
    }
  }
  return result;
}
