// "Sua peça foi embalada": o dono fotografa o pacote ao separar o pedido; a
// foto vai à cliente pelo WhatsApp (evento order.packed) e vira o passo
// "Embalado" da página pública do pedido. Uma foto por pedido — refazer
// sobrescreve o mesmo path e NÃO reenvia (dedupe). O upload acontece antes
// da transação (como addProductImage): recusa nunca deixa a linha torta, e
// um arquivo órfão no path determinístico é inofensivo.
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import sharp from "sharp";
import { z } from "zod";

import type { FileStorage } from "@/adapters/storage";
import type { MessagingProvider } from "@/adapters/zapi";
import { isFirstPurchase } from "@/core/edition/debut";
import type { OrderStatus } from "@/core/orders/state-machine";
import { renderTemplate } from "@/core/whatsapp/render";
import {
  auditLog,
  customers,
  orderItems,
  orders,
  waMessages,
  waTemplates,
} from "@/db/schema";
import { STORE_NAME_DEFAULT } from "@/lib/brand";
import { enqueueOutboxEvent, type DbOrTx } from "@/queue/enqueue";
import { countPriorCountedOrders, editionCardsStatusByOrder } from "@/services/edition-cards";
import { ServiceError, transitionOrder } from "@/services/orders";
import { getSettingsMap } from "@/services/settings";
import {
  buildOrderVars,
  isWaEnabled,
  sendMediaMessage,
} from "@/services/wa-messaging";

export { ServiceError };

export const PACKED_TEMPLATE_KEY = "order_packed";
/** Lado maior da foto guardada; o WhatsApp comprime de novo mesmo. */
export const PACKAGE_PHOTO_MAX_EDGE = 1200;
export const PACKAGE_PHOTO_JPEG_QUALITY = 82;
export const PACKAGE_PHOTO_MAX_BYTES = 8 * 1024 * 1024;

export function packagePhotoStoragePath(orderId: string): string {
  return `packages/${orderId}/embalagem.jpg`;
}

export function packedDedupeKey(orderId: string): string {
  return `wa.packed:${orderId}`;
}

/** URL pública com ?v= para furar o cache da CDN quando a foto é refeita. */
export function packagePhotoUrl(
  storage: FileStorage,
  path: string,
  packedAt: Date,
): string {
  return `${storage.publicUrl(path)}?v=${packedAt.getTime()}`;
}

const packOrderSchema = z.object({
  orderId: z.uuid(),
  photo: z.object({
    // z.custom em vez de z.instanceof: Buffer é Uint8Array<ArrayBufferLike>.
    data: z.custom<Uint8Array>((value) => value instanceof Uint8Array, "Foto inválida."),
    contentType: z.string().min(1),
  }),
  userId: z.uuid(),
});

export type PackOrderInput = z.input<typeof packOrderSchema>;

/**
 * Processa a foto (rotação pelo EXIF, ≤ 1200 px, JPEG; o sharp descarta os
 * metadados — GPS incluso), sobe no path do pedido e, na transação: leva o
 * pedido de 'paid' a 'preparing' pela máquina de estados, grava a foto e o
 * carimbo, audita e enfileira order.packed (dedupe por pedido). Em
 * 'preparing' é refazer a foto: só o arquivo e o carimbo mudam.
 */
export async function packOrder(
  db: DbOrTx,
  storage: FileStorage,
  input: PackOrderInput,
): Promise<{
  orderId: string;
  status: OrderStatus;
  packagePhotoPath: string;
  packedAt: Date;
  transitioned: boolean;
  rephoto: boolean;
}> {
  const parsed = packOrderSchema.parse(input);
  if (!parsed.photo.contentType.startsWith("image/")) {
    throw new ServiceError("imagem_invalida", "O arquivo enviado não é uma imagem.");
  }
  if (parsed.photo.data.byteLength > PACKAGE_PHOTO_MAX_BYTES) {
    throw new ServiceError(
      "imagem_grande",
      "A foto passou de 8 MB. Tire a foto direto pela câmera ou escolha uma menor.",
    );
  }

  const [order] = await db
    .select({ id: orders.id, status: orders.status, packagePhotoPath: orders.packagePhotoPath })
    .from(orders)
    .where(eq(orders.id, parsed.orderId))
    .limit(1);
  if (!order) throw new ServiceError("ORDER_NOT_FOUND", "Pedido não encontrado.");
  if (order.status !== "paid" && order.status !== "preparing") {
    throw new ServiceError(
      "STATUS_INVALIDO",
      "Só dá para registrar a embalagem de um pedido pago ou em separação.",
    );
  }

  let jpeg: Buffer;
  try {
    jpeg = await sharp(Buffer.from(parsed.photo.data))
      .rotate()
      .resize({
        width: PACKAGE_PHOTO_MAX_EDGE,
        height: PACKAGE_PHOTO_MAX_EDGE,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: PACKAGE_PHOTO_JPEG_QUALITY })
      .toBuffer();
  } catch {
    throw new ServiceError(
      "imagem_invalida",
      "Não foi possível processar a foto. Tire a foto direto pela câmera ou escolha um JPG/PNG.",
    );
  }

  const path = packagePhotoStoragePath(order.id);
  await storage.upload({ path, data: jpeg, contentType: "image/jpeg" });

  return db.transaction(async (tx) => {
    let transitioned = false;
    let status = order.status as OrderStatus;
    if (status === "paid") {
      const result = await transitionOrder(tx, {
        orderId: order.id,
        to: "preparing",
        userId: parsed.userId,
      });
      status = result.to;
      transitioned = !result.idempotent;
    }

    const packedAt = new Date();
    await tx
      .update(orders)
      .set({ packagePhotoPath: path, packedAt, updatedAt: packedAt })
      .where(eq(orders.id, order.id));

    const rephoto = order.packagePhotoPath !== null;
    await tx.insert(auditLog).values({
      actorType: "user",
      actorId: parsed.userId,
      action: "order.packed",
      entityType: "order",
      entityId: order.id,
      before: { packagePhotoPath: order.packagePhotoPath },
      after: { packagePhotoPath: path, rephoto, transitioned },
    });

    // Uma mensagem por pedido: o retry ou a foto refeita não reenviam.
    await enqueueOutboxEvent(tx, {
      eventType: "order.packed",
      dedupeKey: `order.packed:${order.id}`,
      aggregateType: "order",
      aggregateId: order.id,
      payload: { orderId: order.id },
    });

    return {
      orderId: order.id,
      status,
      packagePhotoPath: path,
      packedAt,
      transitioned,
      rephoto,
    };
  });
}

export interface OrderAwaitingPacking {
  id: string;
  orderNumber: number;
  status: string;
  totalCents: number;
  paidAt: Date | null;
  customerName: string;
  itemsCount: number;
  packagePhotoPath: string | null;
  /** Presente: sem preço no pacote, bilhete impresso dentro. */
  isGift: boolean;
  /** Cartões da edição já gerados (o link diz "Imprimir" em vez de "Gerar"). */
  editionCardsAt: Date | null;
  /** O que sai nos cartões (ou na carta) mudou depois da geração: "Gerar de novo". */
  editionCardsStale: boolean;
  /** Quantas peças do pedido ganham cartão (0 = sem link de cartões). */
  editionCards: number;
  /** Primeira compra desta cliente: a carta de estreia vai na caixa. */
  isFirstPurchase: boolean;
}

/** Pedidos pagos ou em separação ainda sem foto do pacote, os mais antigos primeiro. */
export async function listOrdersAwaitingPacking(
  db: DbOrTx,
): Promise<OrderAwaitingPacking[]> {
  const rows = await db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      status: orders.status,
      totalCents: orders.totalCents,
      paidAt: orders.paidAt,
      customerName: customers.fullName,
      packagePhotoPath: orders.packagePhotoPath,
      isGift: orders.isGift,
      editionCardsAt: orders.editionCardsAt,
      editionCardsFingerprint: orders.editionCardsFingerprint,
      customerId: orders.customerId,
      createdAt: orders.createdAt,
    })
    .from(orders)
    .innerJoin(customers, eq(customers.id, orders.customerId))
    .where(
      and(inArray(orders.status, ["paid", "preparing"]), isNull(orders.packagePhotoPath)),
    )
    .orderBy(asc(orders.paidAt), asc(orders.orderNumber));
  if (rows.length === 0) return [];

  // Primeira compra: nenhum outro pedido pago da mesma cliente antes deste
  // (a regra mora em core/edition/debut; aqui só a contagem, uma por pedido).
  const firstPurchase = new Map<string, boolean>();
  for (const row of rows) {
    const prior = await countPriorCountedOrders(db, { customerId: row.customerId, orderId: row.id, createdAt: row.createdAt });
    firstPurchase.set(row.id, isFirstPurchase({ priorCountedOrders: prior }));
  }

  const counts = await db
    .select({ orderId: orderItems.orderId, quantity: orderItems.quantity })
    .from(orderItems)
    .where(
      inArray(
        orderItems.orderId,
        rows.map((row) => row.id),
      ),
    );
  const itemsByOrder = new Map<string, number>();
  for (const row of counts) {
    itemsByOrder.set(row.orderId, (itemsByOrder.get(row.orderId) ?? 0) + row.quantity);
  }

  // Cartões: quantos cada pedido tem e se os gerados ficaram velhos (a mesma régua da tela dos cartões).
  const editionStatus = await editionCardsStatusByOrder(db, rows);

  return rows.map(({ editionCardsFingerprint: _fingerprint, customerId: _customerId, createdAt: _createdAt, ...row }) => ({
    ...row,
    itemsCount: itemsByOrder.get(row.id) ?? 0,
    editionCardsStale: editionStatus.get(row.id)?.stale ?? false,
    editionCards: editionStatus.get(row.id)?.cards ?? 0,
    isFirstPurchase: firstPurchase.get(row.id) ?? false,
  }));
}

export async function countOrdersAwaitingPacking(db: DbOrTx): Promise<number> {
  const rows = await db
    .select({ id: orders.id })
    .from(orders)
    .where(
      and(inArray(orders.status, ["paid", "preparing"]), isNull(orders.packagePhotoPath)),
    );
  return rows.length;
}

export type SendPackedResult =
  | Awaited<ReturnType<typeof sendMediaMessage>>
  | { skipped: "sem_telefone" | "sem_template" | "sem_foto" };

/**
 * Envia a foto do pacote com a legenda do template order_packed, só com
 * opt-in e uma vez por pedido (dedupe wa.packed:<orderId>). Skips nunca
 * lançam; falha do provedor relança e o retry de order.packed reprocessa.
 */
export async function sendPackedWa(
  db: DbOrTx,
  provider: MessagingProvider,
  storage: FileStorage,
  input: { orderId: string },
): Promise<SendPackedResult> {
  const orderId = z.uuid().parse(input.orderId);

  if (!(await isWaEnabled(db))) return { skipped: "desabilitado" };

  const [row] = await db
    .select({
      orderNumber: orders.orderNumber,
      publicToken: orders.publicToken,
      paymentDueAt: orders.paymentDueAt,
      trackingCode: orders.shippingTrackingCode,
      totalCents: orders.totalCents,
      paymentMethod: orders.paymentMethod,
      packagePhotoPath: orders.packagePhotoPath,
      packedAt: orders.packedAt,
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
  if (!row.phoneE164) return { skipped: "sem_telefone" };
  if (!row.marketingOptIn) return { skipped: "sem_opt_in" };
  if (!row.packagePhotoPath || !row.packedAt) return { skipped: "sem_foto" };

  const dedupeKey = packedDedupeKey(orderId);
  const [existing] = await db
    .select({ status: waMessages.status })
    .from(waMessages)
    .where(eq(waMessages.dedupeKey, dedupeKey))
    .orderBy(desc(waMessages.createdAt))
    .limit(1);
  if (existing && existing.status !== "failed" && existing.status !== "queued") {
    return { skipped: "ja_enviado" };
  }

  const [template] = await db
    .select({ bodyTemplate: waTemplates.bodyTemplate, isActive: waTemplates.isActive })
    .from(waTemplates)
    .where(eq(waTemplates.key, PACKED_TEMPLATE_KEY))
    .limit(1);
  if (!template || !template.isActive) return { skipped: "sem_template" };

  const settings = await getSettingsMap(db, ["store_name"]);
  const storeName =
    typeof settings["store_name"] === "string" && settings["store_name"].trim() !== ""
      ? settings["store_name"].trim()
      : STORE_NAME_DEFAULT;
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
    imageUrl: packagePhotoUrl(storage, row.packagePhotoPath, row.packedAt),
    body,
    phoneE164: row.phoneE164,
    customerId: row.customerId,
    orderId,
    dedupeKey,
    requireOptIn: true,
  });
}
