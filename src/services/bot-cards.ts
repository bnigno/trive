// Cartão editorial: a vitrine em imagem que a vendedora manda junto com a
// lista tocável (ou o look completo). Chave determinística (peças, fotos e
// preços) → cache em bot_cards/Storage; no miss, baixa as fotos do Storage,
// corta em 3:4 (sharp), desenha (render injetado) e publica em
// cards/<aa>/<chave>.jpg. Melhor esforço: quem chama põe teto de tempo e
// segue sem cartão se algo falhar.
import { eq } from "drizzle-orm";
import sharp from "sharp";

import { z } from "zod";

import type { FileStorage } from "@/adapters/storage";
import type { MessagingProvider } from "@/adapters/zapi";
import {
  CARD_MAX_ITEMS,
  cardFrameSize,
  LOOK_MAX_COMPLEMENTS,
  type CardData,
  type CardItem,
} from "@/core/cards/types";
import { botCards, settings } from "@/db/schema";
import { sha256Hex } from "@/lib/hash";
import type { DbOrTx } from "@/queue/enqueue";
import { sendMediaMessage, type SendWaMessageResult } from "@/services/wa-messaging";

export type CardRenderer = (data: CardData) => Promise<Buffer>;

export interface CardProductRef {
  slug: string;
  name: string;
  priceLabel: string;
  /** Path -full.webp no Storage (a rendição -md é preferida no download). */
  imagePath: string;
}

export interface PublishBotCardInput {
  kind: CardData["kind"];
  storeName: string;
  eyebrow: string;
  title: string;
  /** Catálogo: 1–3 peças. Look: [peça, complemento(s)]. */
  items: CardProductRef[];
}

export interface PublishedCard {
  key: string;
  path: string;
  url: string;
  cached: boolean;
  renderMs: number;
}

export const CARD_JPEG_QUALITY = 85;
/** Lado maior da foto embutida: 2× a moldura para o Satori reduzir com nitidez. */
const PHOTO_SCALE = 2;

/** Setting bot_cards_enabled: ausente = ligado. */
export async function isBotCardsEnabled(db: DbOrTx): Promise<boolean> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, "bot_cards_enabled"))
    .limit(1);
  return row?.value !== false;
}

/** Chave estável: muda quando muda peça, foto, preço, título ou loja. */
export function botCardKey(input: PublishBotCardInput): string {
  const canonical = JSON.stringify({
    kind: input.kind,
    storeName: input.storeName,
    eyebrow: input.eyebrow,
    title: input.title,
    items: input.items.map((item) => ({
      slug: item.slug,
      name: item.name,
      priceLabel: item.priceLabel,
      imagePath: item.imagePath,
    })),
  });
  return sha256Hex(canonical).slice(0, 40);
}

export function botCardStoragePath(key: string): string {
  return `cards/${key.slice(0, 2)}/${key}.jpg`;
}

function mdPath(path: string): string {
  return path.replace("-full.webp", "-md.webp");
}

/** Baixa a foto (md, senão full), corta em 3:4 e embute como JPEG. */
/**
 * A foto da peça não serve: sumiu do Storage, formato que o recorte não abre
 * ou arquivo corrompido. Quem chama distingue isto de falha do próprio
 * desenho (que merece retry) sem depender do texto do vendor.
 */
export class PhotoUnavailableError extends Error {
  readonly imagePath: string;

  constructor(imagePath: string, cause: unknown) {
    super(`Foto indisponível (${imagePath}): ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "PhotoUnavailableError";
    this.imagePath = imagePath;
  }
}

async function loadPhoto(
  storage: FileStorage,
  imagePath: string,
  frame: { width: number; height: number },
): Promise<string> {
  try {
    let file: { data: Buffer };
    try {
      file = await storage.download(mdPath(imagePath));
    } catch {
      file = await storage.download(imagePath);
    }
    const jpeg = await sharp(file.data)
      .rotate()
      .resize({
        width: frame.width * PHOTO_SCALE,
        height: frame.height * PHOTO_SCALE,
        fit: "cover",
        position: "attention",
      })
      .jpeg({ quality: 82 })
      .toBuffer();
    return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
  } catch (error) {
    throw new PhotoUnavailableError(imagePath, error);
  }
}

function validate(input: PublishBotCardInput): void {
  if (input.items.length === 0) throw new Error("Cartão sem peças.");
  if (input.kind === "catalog" && input.items.length > CARD_MAX_ITEMS) {
    throw new Error(`Cartão de catálogo aceita até ${CARD_MAX_ITEMS} peças.`);
  }
  if (input.kind === "look" && (input.items.length < 2 || input.items.length > 1 + LOOK_MAX_COMPLEMENTS)) {
    throw new Error("Cartão de look pede a peça e 1 ou 2 complementos.");
  }
  if ((input.kind === "post" || input.kind === "story") && input.items.length !== 1) {
    throw new Error("O post e o story mostram UMA peça.");
  }
}

async function buildCardData(storage: FileStorage, input: PublishBotCardInput): Promise<CardData> {
  const toItem = async (ref: CardProductRef, role: "item" | "hero" | "complement"): Promise<CardItem> => ({
    slug: ref.slug,
    name: ref.name,
    priceLabel: ref.priceLabel,
    imageDataUrl: await loadPhoto(storage, ref.imagePath, cardFrameSize(input.kind, role, input.items.length)),
  });
  if (input.kind === "catalog") {
    const items = await Promise.all(input.items.map((ref) => toItem(ref, "item")));
    return { kind: "catalog", storeName: input.storeName, eyebrow: input.eyebrow, title: input.title, items };
  }
  if (input.kind === "post" || input.kind === "story") {
    return {
      kind: input.kind,
      storeName: input.storeName,
      eyebrow: input.eyebrow,
      title: input.title,
      hero: await toItem(input.items[0], "hero"),
    };
  }
  const [heroRef, ...complementRefs] = input.items;
  const [hero, ...complements] = await Promise.all([
    toItem(heroRef, "hero"),
    ...complementRefs.map((ref) => toItem(ref, "complement")),
  ]);
  return { kind: "look", storeName: input.storeName, eyebrow: input.eyebrow, title: input.title, hero, complements };
}

/** Cartão já desenhado para esta vitrine? Uma consulta só; nada de rede. */
export async function findCachedBotCard(
  db: DbOrTx,
  storage: FileStorage,
  input: PublishBotCardInput,
): Promise<PublishedCard | null> {
  const key = botCardKey(input);
  const [cached] = await db
    .select({ storagePath: botCards.storagePath })
    .from(botCards)
    .where(eq(botCards.key, key))
    .limit(1);
  return cached
    ? { key, path: cached.storagePath, url: storage.publicUrl(cached.storagePath), cached: true, renderMs: 0 }
    : null;
}

/**
 * Devolve a URL pública do cartão: do cache quando a mesma vitrine já foi
 * desenhada; senão desenha, publica e registra. Nunca dentro de transação
 * longa — o download das fotos e o render levam segundos.
 */
export async function publishBotCard(
  db: DbOrTx,
  storage: FileStorage,
  render: CardRenderer,
  input: PublishBotCardInput,
): Promise<PublishedCard> {
  validate(input);
  const cached = await findCachedBotCard(db, storage, input);
  if (cached) return cached;
  const key = botCardKey(input);

  const startedAt = Date.now();
  const data = await buildCardData(storage, input);
  const png = await render(data);
  const jpeg = await sharp(png).jpeg({ quality: CARD_JPEG_QUALITY }).toBuffer();
  const path = botCardStoragePath(key);
  await storage.upload({ path, data: jpeg, contentType: "image/jpeg" });
  const renderMs = Date.now() - startedAt;
  await db
    .insert(botCards)
    .values({ key, kind: input.kind, storagePath: path, productSlugs: input.items.map((item) => item.slug), renderMs })
    .onConflictDoNothing();
  return { key, path, url: storage.publicUrl(path), cached: false, renderMs };
}

// ---------------------------------------------------------------------------
// Cartão fora do turno: quando a vitrine ainda não está no cache, o turno da
// vendedora só ENFILEIRA (o texto sai na hora) e o handler wa.card_render
// desenha e manda a imagem logo depois — sem a cliente esperar o render frio.
// ---------------------------------------------------------------------------

export const cardRenderPayloadSchema = z.object({
  conversationId: z.uuid(),
  phoneE164: z.string().min(8),
  customerId: z.uuid().nullable(),
  /** Base do dedupe da mensagem: retry nunca manda o cartão duas vezes. */
  lastInboundId: z.uuid(),
  caption: z.string().min(1).max(1000),
  request: z.object({
    kind: z.enum(["catalog", "look"]),
    storeName: z.string().min(1),
    eyebrow: z.string().min(1),
    title: z.string().min(1),
    items: z
      .array(
        z.object({
          slug: z.string().min(1),
          name: z.string().min(1),
          priceLabel: z.string().min(1),
          imagePath: z.string().min(1),
        }),
      )
      .min(1)
      .max(3),
  }),
});

export type CardRenderPayload = z.infer<typeof cardRenderPayloadSchema>;

export function cardMessageDedupeKey(lastInboundId: string): string {
  return `wa.bot_media:${lastInboundId}:card`;
}

/** Desenha (ou pega do cache), publica e manda o cartão à cliente. Idempotente. */
export async function renderAndSendBotCard(
  db: DbOrTx,
  provider: MessagingProvider,
  storage: FileStorage,
  render: CardRenderer,
  input: z.input<typeof cardRenderPayloadSchema>,
): Promise<SendWaMessageResult & { cardUrl?: string }> {
  const payload = cardRenderPayloadSchema.parse(input);
  const card = await publishBotCard(db, storage, render, payload.request);
  const result = await sendMediaMessage(db, provider, {
    kind: "image",
    imageUrl: card.url,
    body: payload.caption,
    phoneE164: payload.phoneE164,
    ...(payload.customerId ? { customerId: payload.customerId } : {}),
    dedupeKey: cardMessageDedupeKey(payload.lastInboundId),
    requireOptIn: false,
  });
  return { ...result, cardUrl: card.url };
}
