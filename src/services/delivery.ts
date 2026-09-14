// "Entregue com foto": no celular, a dona fotografa o pacote na mão da
// cliente (ou na portaria), diz quem recebeu e o pedido vira 'delivered'
// pela máquina de estados. A cliente recebe a foto pelo WhatsApp com a
// legenda "Entregue hoje às 17:42, recebido por Maria" (evento
// order.delivered, que o transitionOrder já emite) e a foto vira o passo
// "Entregue" da página pública. Uma foto por pedido — refazer sobrescreve
// o mesmo path e NÃO reenvia (dedupe). O upload acontece antes da
// transação (como o pacote): recusa nunca deixa a linha torta.
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import sharp from "sharp";
import { z } from "zod";

import type { FileStorage } from "@/adapters/storage";
import type { MessagingProvider } from "@/adapters/zapi";
import { deliveryLine, normalizeReceivedBy, RECEIVED_BY_MAX_CHARS } from "@/core/orders/delivery";
import { type OrderStatus } from "@/core/orders/state-machine";
import { renderTemplate } from "@/core/whatsapp/render";
import { auditLog, customers, orders, waMessages, waTemplates } from "@/db/schema";
import { STORE_NAME_DEFAULT } from "@/lib/brand";
import type { DbOrTx } from "@/queue/enqueue";
import { ServiceError, transitionOrder } from "@/services/orders";
import { PACKAGE_PHOTO_JPEG_QUALITY, PACKAGE_PHOTO_MAX_BYTES, PACKAGE_PHOTO_MAX_EDGE } from "@/services/packing";
import { getSettingsMap } from "@/services/settings";
import { buildOrderVars, isWaEnabled, sendMediaMessage, sendTemplateMessage, type WaSkipReason } from "@/services/wa-messaging";

export { ServiceError };

export const DELIVERED_TEMPLATE_KEY = "order_delivered";

export function deliveryPhotoStoragePath(orderId: string): string {
  return `deliveries/${orderId}/entrega.jpg`;
}

export function deliveredDedupeKey(orderId: string): string {
  return `wa.delivered:${orderId}`;
}

/** URL pública com ?v= para furar o cache da CDN quando a foto é refeita (use o updated_at do pedido: muda a cada foto). */
export function deliveryPhotoUrl(storage: FileStorage, path: string, at: Date): string {
  return `${storage.publicUrl(path)}?v=${at.getTime()}`;
}

const deliverSchema = z.object({
  orderId: z.uuid(),
  photo: z
    .object({
      data: z.custom<Uint8Array>((value) => value instanceof Uint8Array, "Foto inválida."),
      contentType: z.string().min(1),
    })
    .nullable(),
  receivedBy: z.string().max(RECEIVED_BY_MAX_CHARS * 3).nullable().optional(),
  userId: z.uuid(),
});

export type DeliverOrderInput = z.input<typeof deliverSchema>;

/**
 * Onde a câmera faz sentido: enviado; pago em dinheiro na entrega (entrega
 * em mãos) ou motoboy que já saiu. Pago pelos Correios ainda na prateleira,
 * não — esse embala primeiro.
 */
export function canDeliverWithPhoto(status: OrderStatus, input: { dispatched: boolean; paymentMethod: string | null }): boolean {
  if (status === "shipped") return true;
  if (status === "paid") return input.paymentMethod === "cash" || input.dispatched;
  // Em separação: só o motoboy que já saiu (a máquina passa por 'shipped').
  return status === "preparing" && input.dispatched;
}

/**
 * Processa a foto (rotação pelo EXIF, ≤ 1200 px, JPEG sem metadados), sobe
 * no path do pedido e, na transação: grava foto/quem recebeu e leva o pedido
 * a 'delivered' pela máquina de estados (preparing passa por shipped). Já
 * entregue = refazer: só a foto e o nome mudam, sem segunda mensagem.
 */
export async function deliverOrderWithPhoto(
  db: DbOrTx,
  storage: FileStorage,
  input: DeliverOrderInput,
): Promise<{ orderId: string; orderNumber: number; status: OrderStatus; deliveredPhotoPath: string | null; receivedBy: string | null; rephoto: boolean; alreadyDelivered: boolean }> {
  const parsed = deliverSchema.parse(input);
  if (parsed.photo && !parsed.photo.contentType.startsWith("image/")) {
    throw new ServiceError("imagem_invalida", "O arquivo enviado não é uma imagem.");
  }
  if (parsed.photo && parsed.photo.data.byteLength > PACKAGE_PHOTO_MAX_BYTES) {
    throw new ServiceError("imagem_grande", "A foto passou de 8 MB. Tire a foto direto pela câmera ou escolha uma menor.");
  }
  const receivedBy = normalizeReceivedBy(parsed.receivedBy ?? null);

  const selectOrder = (tx: DbOrTx) =>
    tx
      .select({
        id: orders.id,
        orderNumber: orders.orderNumber,
        status: orders.status,
        deliveredPhotoPath: orders.deliveredPhotoPath,
        deliveryWindow: orders.deliveryWindow,
        paymentMethod: orders.paymentMethod,
      })
      .from(orders)
      .where(eq(orders.id, parsed.orderId));
  const assertAllowed = (order: { status: string; deliveryWindow: { dispatchedAt?: string } | null; paymentMethod: string | null }): OrderStatus => {
    const status = order.status as OrderStatus;
    const dispatched = Boolean(order.deliveryWindow?.dispatchedAt);
    if (status !== "delivered" && !canDeliverWithPhoto(status, { dispatched, paymentMethod: order.paymentMethod })) {
      throw new ServiceError(
        "STATUS_INVALIDO",
        status === "pending_payment"
          ? "Registre o pagamento antes de marcar como entregue."
          : status === "paid" || status === "preparing"
            ? "Este pedido ainda não saiu: embale e envie (ou marque a saída com o motoboy) antes de registrar a entrega."
            : "Só dá para registrar a entrega de um pedido enviado ou pago para entrega em mãos.",
      );
    }
    return status;
  };

  const [preview] = await selectOrder(db).limit(1);
  if (!preview) throw new ServiceError("ORDER_NOT_FOUND", "Pedido não encontrado.");
  assertAllowed(preview);
  if (!parsed.photo && preview.status === "delivered") {
    throw new ServiceError("SEM_FOTO", "Este pedido já está entregue: mande a foto para registrar.");
  }

  let path: string | null = preview.deliveredPhotoPath;
  if (parsed.photo) {
    let jpeg: Buffer;
    try {
      jpeg = await sharp(Buffer.from(parsed.photo.data))
        .rotate()
        .resize({ width: PACKAGE_PHOTO_MAX_EDGE, height: PACKAGE_PHOTO_MAX_EDGE, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: PACKAGE_PHOTO_JPEG_QUALITY })
        .toBuffer();
    } catch {
      throw new ServiceError("imagem_invalida", "Não foi possível processar a foto. Tire a foto direto pela câmera ou escolha um JPG/PNG.");
    }
    path = deliveryPhotoStoragePath(preview.id);
    await storage.upload({ path, data: jpeg, contentType: "image/jpeg" });
  }

  return db.transaction(async (tx) => {
    // Decide com a linha trancada: dois toques ao mesmo tempo (ficha + mesa)
    // não encadeiam duas transições — o segundo vira "refazer".
    const [order] = await selectOrder(tx).for("update");
    if (!order) throw new ServiceError("ORDER_NOT_FOUND", "Pedido não encontrado.");
    const status = assertAllowed(order);
    const rephoto = order.deliveredPhotoPath !== null;
    const now = new Date();
    // A foto e o nome entram ANTES da transição: o evento order.delivered
    // (na mesma transação) já encontra tudo quando for entregue.
    await tx
      .update(orders)
      .set({
        deliveredPhotoPath: path,
        receivedBy,
        deliveryConfirmedBy: "owner",
        updatedAt: now,
      })
      .where(eq(orders.id, order.id));

    let finalStatus: OrderStatus = status;
    if (status !== "delivered") {
      if (status === "preparing") {
        await transitionOrder(tx, { orderId: order.id, to: "shipped", userId: parsed.userId });
      }
      const result = await transitionOrder(tx, { orderId: order.id, to: "delivered", userId: parsed.userId });
      finalStatus = result.to;
    }

    await tx.insert(auditLog).values({
      actorType: "user",
      actorId: parsed.userId,
      action: "order.delivered_with_photo",
      entityType: "order",
      entityId: order.id,
      before: { status, deliveredPhotoPath: order.deliveredPhotoPath },
      after: { status: finalStatus, deliveredPhotoPath: path, receivedBy, rephoto, photoAt: now.toISOString() },
    });

    return { orderId: order.id, orderNumber: order.orderNumber, status: finalStatus, deliveredPhotoPath: path, receivedBy, rephoto, alreadyDelivered: status === "delivered" };
  });
}

export type SendDeliveredResult =
  | { sent: true; waMessageId: string; withPhoto: boolean }
  | { skipped: WaSkipReason | "nao_entregue" | "sem_telefone" | "sem_foto" };

/**
 * A mensagem de entrega (evento order.delivered): com foto, a imagem com a
 * legenda; sem foto ("marcar como entregue" sem câmera), só o texto. Uma
 * vez por pedido (dedupe); só com opt-in; cancelado/reembolsado nunca.
 */
export async function sendDeliveredWa(
  db: DbOrTx,
  provider: MessagingProvider,
  storage: FileStorage,
  input: { orderId: string; now?: Date },
): Promise<SendDeliveredResult> {
  const orderId = z.uuid().parse(input.orderId);
  if (!(await isWaEnabled(db))) return { skipped: "desabilitado" };

  const [row] = await db
    .select({
      status: orders.status,
      orderNumber: orders.orderNumber,
      publicToken: orders.publicToken,
      paymentDueAt: orders.paymentDueAt,
      trackingCode: orders.shippingTrackingCode,
      totalCents: orders.totalCents,
      paymentMethod: orders.paymentMethod,
      deliveredAt: orders.deliveredAt,
      deliveredPhotoPath: orders.deliveredPhotoPath,
      receivedBy: orders.receivedBy,
      deliveryConfirmedBy: orders.deliveryConfirmedBy,
      updatedAt: orders.updatedAt,
      isGift: orders.isGift,
      customerId: customers.id,
      customerName: customers.fullName,
      phoneE164: customers.phoneE164,
      marketingOptIn: customers.marketingOptIn,
    })
    .from(orders)
    .innerJoin(customers, eq(customers.id, orders.customerId))
    .where(eq(orders.id, orderId))
    .limit(1);
  if (!row) throw new ServiceError("ORDER_NOT_FOUND", `Pedido ${orderId} não encontrado.`);
  if (row.status !== "delivered" || !row.deliveredAt) return { skipped: "nao_entregue" };
  // Sem foto, só quando foi a própria cliente que confirmou (página ou Lia):
  // "marcar entregue" pelo rastreio dos Correios não sabe a hora real e
  // não manda nada, como antes.
  const customerConfirmed = row.deliveryConfirmedBy === "customer" || row.deliveryConfirmedBy === "lia";
  if (!row.deliveredPhotoPath && !customerConfirmed) return { skipped: "sem_foto" };
  if (!row.phoneE164) return { skipped: "sem_telefone" };
  if (!row.marketingOptIn) return { skipped: "sem_opt_in" };

  const dedupeKey = deliveredDedupeKey(orderId);
  const [existing] = await db
    .select({ status: waMessages.status })
    .from(waMessages)
    .where(eq(waMessages.dedupeKey, dedupeKey))
    .orderBy(desc(waMessages.createdAt))
    .limit(1);
  if (existing && existing.status !== "failed" && existing.status !== "queued") return { skipped: "ja_enviado" };

  const [template] = await db
    .select({ bodyTemplate: waTemplates.bodyTemplate, isActive: waTemplates.isActive })
    .from(waTemplates)
    .where(eq(waTemplates.key, DELIVERED_TEMPLATE_KEY))
    .limit(1);
  if (!template || !template.isActive) return { skipped: "sem_template" };

  const settings = await getSettingsMap(db, ["store_name"]);
  const storeName =
    typeof settings["store_name"] === "string" && settings["store_name"].trim() !== "" ? settings["store_name"].trim() : STORE_NAME_DEFAULT;
  const now = input.now ?? new Date();
  // Com a foto, a hora é a da entrega de verdade; confirmada pela cliente,
  // a frase fica sem hora ("foi entregue 🤎").
  const body = renderTemplate(template.bodyTemplate, {
    ...buildOrderVars({
      orderNumber: row.orderNumber,
      customerName: row.customerName,
      totalCents: row.totalCents,
      publicToken: row.publicToken,
      paymentDueAt: row.paymentDueAt,
      trackingCode: row.trackingCode,
      storeName,
      paymentMethod: row.paymentMethod,
      isGift: row.isGift,
    }),
    entrega: row.deliveredPhotoPath ? deliveryLine({ deliveredAt: row.deliveredAt, receivedBy: row.receivedBy, now }) : "",
    recebido_por: row.receivedBy ?? "",
  }).replace(/[ \t]{2,}/g, " ");

  if (row.deliveredPhotoPath) {
    const result = await sendMediaMessage(db, provider, {
      kind: "image",
      imageUrl: deliveryPhotoUrl(storage, row.deliveredPhotoPath, row.updatedAt),
      body,
      phoneE164: row.phoneE164,
      customerId: row.customerId,
      orderId,
      dedupeKey,
      requireOptIn: true,
    });
    return "sent" in result ? { ...result, withPhoto: true } : result;
  }
  const result = await sendTemplateMessage(db, provider, {
    bodyOverride: body,
    phoneE164: row.phoneE164,
    customerId: row.customerId,
    orderId,
    dedupeKey,
    requireOptIn: true,
  });
  return "sent" in result ? { ...result, withPhoto: false } : result;
}

export interface OrderAwaitingDelivery {
  id: string;
  orderNumber: number;
  status: string;
  /** Dinheiro na entrega que saiu com o motoboy: primeiro o pagamento, depois a foto. */
  awaitingPayment: boolean;
  totalCents: number;
  customerName: string;
  shippedAt: Date | null;
  paidAt: Date | null;
  isMotoboy: boolean;
  dispatchedAt: Date | null;
  paymentMethod: string | null;
  trackingCode: string | null;
}

/**
 * A mesa de entrega: pedidos enviados (Correios com rastreio, motoboy que
 * saiu), os pagos em dinheiro na entrega (entrega em mãos) e o motoboy que
 * saiu — inclusive o de dinheiro ainda por receber (sem câmera: primeiro o
 * pagamento). Motoboy pago que ainda não saiu é da Rota do dia, não daqui.
 */
export async function listOrdersAwaitingDelivery(db: DbOrTx): Promise<OrderAwaitingDelivery[]> {
  const rows = await db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      status: orders.status,
      totalCents: orders.totalCents,
      customerName: customers.fullName,
      shippedAt: orders.shippedAt,
      paidAt: orders.paidAt,
      deliveryWindow: orders.deliveryWindow,
      paymentMethod: orders.paymentMethod,
      trackingCode: orders.shippingTrackingCode,
    })
    .from(orders)
    .innerJoin(customers, eq(customers.id, orders.customerId))
    .where(
      and(
        isNull(orders.deliveredPhotoPath),
        or(
          eq(orders.status, "shipped"),
          and(eq(orders.status, "paid"), or(eq(orders.paymentMethod, "cash"), sql`${orders.deliveryWindow}->>'dispatchedAt' IS NOT NULL`)),
          and(inArray(orders.status, ["preparing", "pending_payment"]), sql`${orders.deliveryWindow}->>'dispatchedAt' IS NOT NULL`),
        ),
      ),
    )
    .orderBy(sql`coalesce(${orders.shippedAt}, ${orders.paidAt}) asc`);
  return rows.map((row) => ({
    id: row.id,
    orderNumber: row.orderNumber,
    status: row.status,
    awaitingPayment: row.status === "pending_payment",
    totalCents: row.totalCents,
    customerName: row.customerName,
    shippedAt: row.shippedAt,
    paidAt: row.paidAt,
    isMotoboy: row.deliveryWindow !== null,
    dispatchedAt: row.deliveryWindow?.dispatchedAt ? new Date(row.deliveryWindow.dispatchedAt) : null,
    paymentMethod: row.paymentMethod,
    trackingCode: row.trackingCode,
  }));
}

export async function countOrdersAwaitingDelivery(db: DbOrTx): Promise<number> {
  return (await listOrdersAwaitingDelivery(db)).length;
}
