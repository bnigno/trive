// Comprovante de pagamento em imagem, enviado pelo WhatsApp quando o
// pagamento confirma (evento order.receipt, enfileirado pelo handler de
// order.paid). Ordem obrigatória: pré-checagens baratas (WhatsApp ligado,
// telefone, opt-in, já enviado, template) ANTES de renderizar — a maioria
// dos clientes não marca o opt-in, e para eles nem Satori nem JPG existem.
// Path determinístico + upsert = idempotente em retries. SEM dado pessoal na
// imagem (ela circula em encaminhamentos), como a página /pedido/[token].
import { eq, inArray } from "drizzle-orm";
import sharp from "sharp";
import { z } from "zod";

import type { FileStorage } from "@/adapters/storage";
import type { MessagingProvider } from "@/adapters/zapi";
import {
  PAYMENT_METHOD_LABELS_SHORT,
  type PaymentMethod,
} from "@/core/orders/payment-methods";
import { normalizeReceiptText, type ReceiptData } from "@/core/receipts/types";
import { renderTemplate } from "@/core/whatsapp/render";
import {
  customers,
  orderItems,
  orders,
  settings,
  waMessages,
  waTemplates,
} from "@/db/schema";
import { STORE_NAME_DEFAULT } from "@/lib/brand";
import type { DbOrTx } from "@/queue/enqueue";
import {
  buildOrderVars,
  isWaEnabled,
  sendMediaMessage,
} from "@/services/wa-messaging";

export class ServiceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ServiceError";
    this.code = code;
  }
}

/** Quem desenha o PNG (src/receipts/render + assets), injetado pelo handler. */
export type ReceiptRenderer = (data: ReceiptData) => Promise<Buffer>;

export const RECEIPT_TEMPLATE_KEY = "payment_receipt";
export const RECEIPT_JPEG_QUALITY = 88;

export function receiptStoragePath(orderId: string): string {
  return `receipts/${orderId}/comprovante.jpg`;
}

export function receiptDedupeKey(orderId: string): string {
  return `wa.receipt:${orderId}`;
}

const orderIdSchema = z.object({ orderId: z.uuid() });

async function loadStoreIdentity(
  db: DbOrTx,
): Promise<{ storeName: string; storeCnpj: string | null }> {
  const rows = await db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(inArray(settings.key, ["store_name", "store_cnpj"]));
  const text = (key: string): string => {
    const value = rows.find((row) => row.key === key)?.value;
    return typeof value === "string" ? value.trim() : "";
  };
  return {
    storeName: text("store_name") || STORE_NAME_DEFAULT,
    storeCnpj: text("store_cnpj") || null,
  };
}

/** Os dados da imagem — nenhum campo pessoal (o teste trava as chaves). */
export async function buildReceiptData(
  db: DbOrTx,
  orderId: string,
): Promise<ReceiptData> {
  const id = z.uuid().parse(orderId);
  const [order] = await db
    .select({
      orderNumber: orders.orderNumber,
      paidAt: orders.paidAt,
      paymentMethod: orders.paymentMethod,
      subtotalCents: orders.subtotalCents,
      discountCents: orders.discountCents,
      shippingCents: orders.shippingCents,
      totalCents: orders.totalCents,
    })
    .from(orders)
    .where(eq(orders.id, id))
    .limit(1);
  if (!order) {
    throw new ServiceError("pedido_nao_encontrado", `Pedido ${id} não encontrado.`);
  }
  if (!order.paidAt) {
    throw new ServiceError(
      "nao_pago",
      "O comprovante só existe depois que o pagamento é confirmado.",
    );
  }

  const items = await db
    .select({
      name: orderItems.nameSnapshot,
      sku: orderItems.skuSnapshot,
      quantity: orderItems.quantity,
      unitPriceCents: orderItems.unitPriceCents,
      totalCents: orderItems.totalCents,
    })
    .from(orderItems)
    .where(eq(orderItems.orderId, id))
    .orderBy(orderItems.skuSnapshot);

  const identity = await loadStoreIdentity(db);
  const method = order.paymentMethod as PaymentMethod | null;
  const paymentLabel =
    (method && PAYMENT_METHOD_LABELS_SHORT[method]) || method || "pagamento confirmado";

  return {
    orderNumber: order.orderNumber,
    paidAt: order.paidAt,
    paymentLabel,
    items: items.map((item) => ({
      name: normalizeReceiptText(item.name) || "Peça",
      sku: normalizeReceiptText(item.sku),
      quantity: item.quantity,
      unitPriceCents: item.unitPriceCents,
      totalCents: item.totalCents,
    })),
    subtotalCents: order.subtotalCents,
    discountCents: order.discountCents,
    shippingCents: order.shippingCents,
    totalCents: order.totalCents,
    storeName: normalizeReceiptText(identity.storeName) || STORE_NAME_DEFAULT,
    storeCnpj: identity.storeCnpj,
  };
}

/**
 * Renderiza, converte para JPEG (o dono pediu JPG; o bucket aceita
 * image/jpeg), sobe com upsert no path determinístico e grava
 * orders.receipt_path. A URL leva ?v=<paidAt> para furar o cache da CDN se a
 * imagem for gerada de novo (a query não entra no dedupe da mensagem).
 */
export async function publishOrderReceipt(
  db: DbOrTx,
  storage: FileStorage,
  render: ReceiptRenderer,
  input: { orderId: string },
): Promise<{ path: string; url: string }> {
  const { orderId } = orderIdSchema.parse(input);
  const data = await buildReceiptData(db, orderId);
  const png = await render(data);
  const jpeg = await sharp(png).jpeg({ quality: RECEIPT_JPEG_QUALITY }).toBuffer();
  const path = receiptStoragePath(orderId);
  await storage.upload({ path, data: jpeg, contentType: "image/jpeg" });
  await db
    .update(orders)
    .set({ receiptPath: path, updatedAt: new Date() })
    .where(eq(orders.id, orderId));
  return { path, url: `${storage.publicUrl(path)}?v=${data.paidAt.getTime()}` };
}

export type SendReceiptResult =
  | Awaited<ReturnType<typeof sendMediaMessage>>
  | { skipped: "sem_telefone" | "sem_template" };

/**
 * Pré-checa tudo, só então publica a imagem e envia pelo WhatsApp com a
 * legenda do template payment_receipt (editável no admin), requireOptIn e
 * dedupe wa.receipt:<orderId>. Skips nunca lançam; falha do provedor relança
 * e o retry do evento order.receipt reprocessa (upsert + dedupe).
 */
export async function sendReceiptWa(
  db: DbOrTx,
  provider: MessagingProvider,
  storage: FileStorage,
  render: ReceiptRenderer,
  input: { orderId: string },
): Promise<SendReceiptResult> {
  const { orderId } = orderIdSchema.parse(input);

  if (!(await isWaEnabled(db))) return { skipped: "desabilitado" };

  const [row] = await db
    .select({
      orderNumber: orders.orderNumber,
      publicToken: orders.publicToken,
      paymentDueAt: orders.paymentDueAt,
      trackingCode: orders.shippingTrackingCode,
      totalCents: orders.totalCents,
      paymentMethod: orders.paymentMethod,
      customerId: customers.id,
      customerName: customers.fullName,
      phoneE164: customers.phoneE164,
      marketingOptIn: customers.marketingOptIn,
    })
    .from(orders)
    .innerJoin(customers, eq(customers.id, orders.customerId))
    .where(eq(orders.id, orderId))
    .limit(1);
  if (!row) {
    throw new ServiceError("pedido_nao_encontrado", `Pedido ${orderId} não encontrado.`);
  }
  if (!row.phoneE164) return { skipped: "sem_telefone" };
  if (!row.marketingOptIn) return { skipped: "sem_opt_in" };

  const dedupeKey = receiptDedupeKey(orderId);
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
    .where(eq(waTemplates.key, RECEIPT_TEMPLATE_KEY))
    .limit(1);
  if (!template || !template.isActive) return { skipped: "sem_template" };

  const { url } = await publishOrderReceipt(db, storage, render, { orderId });

  const { storeName } = await loadStoreIdentity(db);
  const body = renderTemplate(
    template.bodyTemplate,
    buildOrderVars({
      orderNumber: row.orderNumber,
      customerName: row.customerName,
      totalCents: row.totalCents,
      publicToken: row.publicToken,
      paymentDueAt: row.paymentDueAt,
      trackingCode: row.trackingCode,
      storeName,
      paymentMethod: row.paymentMethod,
    }),
  );

  return sendMediaMessage(db, provider, {
    kind: "image",
    imageUrl: url,
    body,
    phoneE164: row.phoneE164,
    customerId: row.customerId,
    orderId,
    dedupeKey,
    requireOptIn: true,
  });
}
