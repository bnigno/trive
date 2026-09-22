// O story do lançamento para o Instagram: "ESTREIA · SÁBADO, 20H", até três
// peças atrás do véu (silhuetas, sem preço) ou abertas (foto e preço) e o
// endereço /estreia. A dona toca em "Gerar" no painel: a imagem é desenhada
// na hora (engine de cartões), guardada no Storage e o link/arquivo vai para
// o WhatsApp dela pela fila (regra 5: efeito externo só via outbox).

import { eq } from "drizzle-orm";
import sharp from "sharp";
import { z } from "zod";

import type { FileStorage } from "@/adapters/storage";
import type { MessagingProvider } from "@/adapters/zapi";
import {
  cardFrameSize,
  DROP_STORY_MAX_ITEMS,
  dropStoryCaption,
  dropStoryEyebrow,
  type CardItem,
  type DropStoryCardData,
} from "@/core/cards/types";
import { publicDropLabel } from "@/core/drops";
import { drops } from "@/db/schema";
import { formatCentsBRL } from "@/lib/money";
import { siteUrl } from "@/lib/site-url";
import { enqueueOutboxEvent, type DbOrTx } from "@/queue/enqueue";
import { loadCardPhotoDataUrl, PhotoUnavailableError, type CardRenderer } from "@/services/bot-cards";
import { getDrop } from "@/services/drops";
import { getSettingsMap } from "@/services/settings";
import { listPublicProducts } from "@/services/store-catalog";
import { sendToOwner, type SendWaMessageResult } from "@/services/wa-messaging";

export const DROP_STORY_EVENT = "wa.drop_story_send";
export const DROP_STORY_JPEG_QUALITY = 88;
/** Desfoque das silhuetas (em 2× da moldura): formas e cores, nunca a peça. */
export const DROP_STORY_BLUR = 28;

export const dropStoryVariantSchema = z.enum(["teaser", "open"]);
export type DropStoryVariant = z.infer<typeof dropStoryVariantSchema>;

export class ServiceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ServiceError";
    this.code = code;
  }
}

function priceLabelOf(fromCents: number, toCents: number): string {
  return fromCents === toCents ? formatCentsBRL(fromCents) : `a partir de ${formatCentsBRL(fromCents)}`;
}

/** Caminho no Storage, datado: a prévia do painel nunca pega cache velho. */
export function dropStoryStoragePath(dropId: string, variant: DropStoryVariant, at: Date): string {
  return `drops/${dropId}/story-${variant}-${at.getTime()}.jpg`;
}

/**
 * Monta os dados do story: as primeiras peças do lançamento com foto (até
 * três). Teaser: silhuetas desfocadas, sem preço nem nome. Aberta: foto e
 * preço (peça ainda escondida pela janela VIP entra — o story é da dona).
 */
export async function buildDropStoryInput(
  db: DbOrTx,
  storage: FileStorage,
  input: { dropId: string; variant: DropStoryVariant; now?: Date },
): Promise<DropStoryCardData> {
  const now = input.now ?? new Date();
  const drop = await getDrop(db, input.dropId, now);
  if (!drop) throw new ServiceError("lancamento_nao_encontrado", "Lançamento não encontrado.");
  if (drop.phase === "draft" || drop.phase === "canceled") {
    throw new ServiceError("lancamento_sem_data", "Agende o lançamento antes de gerar o story.");
  }
  // Só o que está à venda de fato (ativa, com preço) e tem foto: peça
  // arquivada ou sem preço depois do agendamento não pode virar destaque.
  const withPhoto = drop.products
    .filter((p) => p.imagePath && p.status === "active" && p.hasActivePrice)
    .slice(0, DROP_STORY_MAX_ITEMS);
  if (withPhoto.length === 0) {
    throw new ServiceError("sem_fotos", "Nenhuma peça do lançamento está ativa, com preço e foto.");
  }
  const priced = new Map(
    (await listPublicProducts(db, { productIds: withPhoto.map((p) => p.id), includeHidden: true, aiPhotos: "prefer", limit: withPhoto.length })).map((p) => [
      p.id,
      priceLabelOf(p.priceFromCents, p.priceToCents),
    ]),
  );
  const frame = cardFrameSize("drop_story", "item", withPhoto.length);
  const items: CardItem[] = [];
  for (const product of withPhoto) {
    try {
      items.push({
        slug: product.slug,
        name: product.name,
        priceLabel: input.variant === "open" ? (priced.get(product.id) ?? "") : "",
        imageDataUrl: await loadCardPhotoDataUrl(storage, product.imagePath as string, frame, {
          blur: input.variant === "teaser" ? DROP_STORY_BLUR : 0,
        }),
      });
    } catch (error) {
      if (error instanceof PhotoUnavailableError) continue; // foto que não abriu fica de fora
      throw error;
    }
  }
  if (items.length === 0) throw new ServiceError("sem_fotos", "Não consegui abrir as fotos das peças.");
  // Molduras dimensionadas pelo que de fato entrou.
  if (items.length !== withPhoto.length) {
    const resized = cardFrameSize("drop_story", "item", items.length);
    for (const item of items) {
      const product = withPhoto.find((p) => p.slug === item.slug)!;
      item.imageDataUrl = await loadCardPhotoDataUrl(storage, product.imagePath as string, resized, {
        blur: input.variant === "teaser" ? DROP_STORY_BLUR : 0,
      });
    }
  }
  const settings = await getSettingsMap(db, ["store_name"]);
  const storeName = (typeof settings.store_name === "string" && settings.store_name.trim()) || "TRIVÉ";
  const dateLabel = publicDropLabel(drop.publishAt, now);
  return {
    kind: "drop_story",
    variant: input.variant,
    storeName,
    eyebrow: dropStoryEyebrow(dateLabel),
    title: drop.name,
    caption: dropStoryCaption(input.variant, dateLabel),
    items,
    siteLine: `${siteUrl().replace(/^https?:\/\//, "")}/estreia`,
  };
}

export type PublishedDropStory = { path: string; url: string; renderMs: number };

/**
 * Desenha, guarda e registra o story em drops.story_*_path; enfileira o
 * envio para o WhatsApp da dona (wa.drop_story_send). Chamado pela action
 * do painel (a prévia aparece na hora; o WhatsApp chega pela fila).
 */
export async function publishDropStory(
  db: DbOrTx,
  storage: FileStorage,
  render: CardRenderer,
  input: { dropId: string; variant: DropStoryVariant; now?: Date },
): Promise<PublishedDropStory> {
  const now = input.now ?? new Date();
  const data = await buildDropStoryInput(db, storage, { ...input, now });
  const started = Date.now();
  const png = await render(data);
  const jpeg = await sharp(png).jpeg({ quality: DROP_STORY_JPEG_QUALITY }).toBuffer();
  const renderMs = Date.now() - started;
  const path = dropStoryStoragePath(input.dropId, input.variant, now);
  await storage.upload({ path, data: jpeg, contentType: "image/jpeg" });
  await db
    .update(drops)
    .set(input.variant === "teaser" ? { storyTeaserPath: path, updatedAt: now } : { storyOpenPath: path, updatedAt: now })
    .where(eq(drops.id, input.dropId));
  await enqueueOutboxEvent(db, {
    eventType: DROP_STORY_EVENT,
    dedupeKey: `${DROP_STORY_EVENT}:${input.dropId}:${input.variant}:${now.getTime()}`,
    aggregateType: "drop",
    aggregateId: input.dropId,
    payload: { dropId: input.dropId, variant: input.variant, path },
  });
  return { path, url: storage.publicUrl(path), renderMs };
}

/** Handler de wa.drop_story_send: a imagem vai para o WhatsApp da dona, uma vez por arquivo. */
export async function sendDropStoryToOwner(
  db: DbOrTx,
  storage: FileStorage,
  provider: MessagingProvider,
  input: { dropId: string; variant: DropStoryVariant; path: string },
): Promise<SendWaMessageResult> {
  const [drop] = await db.select({ name: drops.name }).from(drops).where(eq(drops.id, input.dropId)).limit(1);
  const name = drop?.name ?? "o lançamento";
  const body =
    input.variant === "teaser"
      ? `Story do véu de ${name} pronto ✨ Salve a imagem e poste com o link ${siteUrl()}/estreia na bio (ou no sticker).`
      : `Story da cortina aberta de ${name} pronto ✨ Salve e poste — o link ${siteUrl()}/estreia leva às peças.`;
  return sendToOwner(db, provider, {
    bodyOverride: body,
    dedupeKey: `wa.drop_story:${input.path}`,
    image: { url: storage.publicUrl(input.path) },
  });
}
