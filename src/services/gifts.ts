// Presente com bilhete: monta os dados do bilhete a partir do pedido, publica
// a imagem (gifts/<orderId>/bilhete.jpg — o admin imprime dela) e manda a
// prévia à compradora pelo WhatsApp com a legenda do template
// gift_note_preview. A publicação acontece SEMPRE que o pedido é presente;
// só o envio depende de WhatsApp ligado, telefone e opt-in.
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { z } from "zod";

import type { FileStorage } from "@/adapters/storage";
import type { MessagingProvider } from "@/adapters/zapi";
import { giftSignature } from "@/core/gifts/text";
import type { GiftNoteData } from "@/core/gifts/types";
import { renderTemplate } from "@/core/whatsapp/render";
import { customers, orders, waMessages, waTemplates } from "@/db/schema";
import { STORE_NAME_DEFAULT } from "@/lib/brand";
import type { DbOrTx } from "@/queue/enqueue";
import { getSettingsMap } from "@/services/settings";
import {
  buildOrderVars,
  isWaEnabled,
  sendMediaMessage,
  type SendWaMessageResult,
} from "@/services/wa-messaging";

export class ServiceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ServiceError";
    this.code = code;
  }
}

export type GiftNoteRenderer = (data: GiftNoteData) => Promise<Buffer>;

export const GIFT_NOTE_TEMPLATE_KEY = "gift_note_preview";
export const GIFT_NOTE_JPEG_QUALITY = 88;

const orderIdSchema = z.object({ orderId: z.uuid() });

export function giftNoteStoragePath(orderId: string): string {
  return `gifts/${orderId}/bilhete.jpg`;
}

export function giftNoteDedupeKey(orderId: string): string {
  return `wa.gift_note:${orderId}`;
}

/** URL pública com cache-busting pela última alteração do pedido. */
export function giftNoteUrl(storage: FileStorage, path: string, updatedAt: Date): string {
  return `${storage.publicUrl(path)}?v=${updatedAt.getTime()}`;
}

async function loadGiftOrder(db: DbOrTx, orderId: string) {
  const [row] = await db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      publicToken: orders.publicToken,
      paymentDueAt: orders.paymentDueAt,
      trackingCode: orders.shippingTrackingCode,
      totalCents: orders.totalCents,
      paymentMethod: orders.paymentMethod,
      isGift: orders.isGift,
      giftRecipientName: orders.giftRecipientName,
      giftMessage: orders.giftMessage,
      giftNotePath: orders.giftNotePath,
      customerId: customers.id,
      customerName: customers.fullName,
      phoneE164: customers.phoneE164,
    })
    .from(orders)
    .innerJoin(customers, eq(customers.id, orders.customerId))
    .where(eq(orders.id, orderId))
    .limit(1);
  if (!row) throw new ServiceError("pedido_nao_encontrado", `Pedido ${orderId} não encontrado.`);
  return row;
}

async function storeNameOf(db: DbOrTx): Promise<string> {
  const map = await getSettingsMap(db, ["store_name"]);
  return typeof map["store_name"] === "string" && map["store_name"].trim() !== ""
    ? map["store_name"].trim()
    : STORE_NAME_DEFAULT;
}

/** Dados do bilhete; null quando o pedido não é presente. */
export async function buildGiftNoteData(db: DbOrTx, orderId: string): Promise<GiftNoteData | null> {
  const row = await loadGiftOrder(db, orderId);
  if (!row.isGift) return null;
  return {
    recipientName: row.giftRecipientName ?? "você",
    message: row.giftMessage,
    signature: giftSignature(row.customerName),
    storeName: await storeNameOf(db),
  };
}

/**
 * Desenha e publica o bilhete (upsert no mesmo path) e grava o path no
 * pedido. Idempotente: rodar de novo sobrescreve a mesma imagem.
 */
export async function publishGiftNote(
  db: DbOrTx,
  storage: FileStorage,
  render: GiftNoteRenderer,
  input: { orderId: string },
): Promise<{ path: string; url: string } | { skipped: "nao_presente" }> {
  const { orderId } = orderIdSchema.parse(input);
  const data = await buildGiftNoteData(db, orderId);
  if (!data) return { skipped: "nao_presente" };
  const png = await render(data);
  const jpeg = await sharp(png).jpeg({ quality: GIFT_NOTE_JPEG_QUALITY }).toBuffer();
  const path = giftNoteStoragePath(orderId);
  await storage.upload({ path, data: jpeg, contentType: "image/jpeg" });
  const updatedAt = new Date();
  await db.update(orders).set({ giftNotePath: path, updatedAt }).where(eq(orders.id, orderId));
  return { path, url: giftNoteUrl(storage, path, updatedAt) };
}

export type SendGiftNoteResult =
  | SendWaMessageResult
  | { skipped: "nao_presente" | "sem_telefone" | "sem_template" };

/**
 * Publica o bilhete (sempre) e manda a prévia à compradora: WhatsApp ligado,
 * telefone, opt-in, template ativo e dedupe wa.gift_note:<orderId>. Skips
 * nunca lançam; falha real do provedor relança e o retry reprocessa.
 */
export async function sendGiftNoteWa(
  db: DbOrTx,
  provider: MessagingProvider,
  storage: FileStorage,
  render: GiftNoteRenderer,
  input: { orderId: string },
): Promise<SendGiftNoteResult> {
  const { orderId } = orderIdSchema.parse(input);
  const row = await loadGiftOrder(db, orderId);
  if (!row.isGift) return { skipped: "nao_presente" };

  const published = await publishGiftNote(db, storage, render, { orderId });
  if ("skipped" in published) return published;

  if (!(await isWaEnabled(db))) return { skipped: "desabilitado" };
  if (!row.phoneE164) return { skipped: "sem_telefone" };

  const dedupeKey = giftNoteDedupeKey(orderId);
  const [existing] = await db
    .select({ status: waMessages.status })
    .from(waMessages)
    .where(eq(waMessages.dedupeKey, dedupeKey))
    .limit(1);
  if (existing && existing.status !== "failed" && existing.status !== "queued") {
    return { skipped: "ja_enviado" };
  }

  const [template] = await db
    .select({ bodyTemplate: waTemplates.bodyTemplate, isActive: waTemplates.isActive })
    .from(waTemplates)
    .where(eq(waTemplates.key, GIFT_NOTE_TEMPLATE_KEY))
    .limit(1);
  if (!template || !template.isActive) return { skipped: "sem_template" };

  const body = renderTemplate(template.bodyTemplate, {
    ...buildOrderVars({
      orderNumber: row.orderNumber,
      customerName: row.customerName,
      totalCents: row.totalCents,
      publicToken: row.publicToken,
      paymentDueAt: row.paymentDueAt,
      trackingCode: row.trackingCode,
      storeName: await storeNameOf(db),
      paymentMethod: row.paymentMethod,
      isGift: true,
    }),
    para: row.giftRecipientName ?? "",
  });

  return sendMediaMessage(db, provider, {
    kind: "image",
    imageUrl: published.url,
    body,
    phoneE164: row.phoneE164,
    customerId: row.customerId,
    orderId,
    dedupeKey,
    templateKey: GIFT_NOTE_TEMPLATE_KEY,
    // Prévia do cartão do pedido dela: não é novidade nem oferta.
    requireOptIn: false,
  });
}
