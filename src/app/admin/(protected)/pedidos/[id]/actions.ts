"use server";

import { revalidatePath } from "next/cache";
import { z, ZodError } from "zod";

import { getFileStorage } from "@/adapters/storage";
import { InvalidTransitionError, type OrderStatus } from "@/core/orders/state-machine";
import { getDb } from "@/db/client";
import { requireOwner, requireUser } from "@/services/auth";
import { returnOrderItem } from "@/services/order-returns";
import { formatCentsBRL } from "@/lib/money";
import {
  ServiceError,
  deliverByHand,
  shipOrder,
  transitionOrder,
} from "@/services/orders";
import { deliverOrderWithPhoto } from "@/services/delivery";
import { PACKAGE_PHOTO_MAX_BYTES, packOrder } from "@/services/packing";

export type FormState = { error?: string; success?: string };

const orderIdSchema = z.uuid();

function friendlyError(error: unknown): FormState {
  if (error instanceof ServiceError || error instanceof InvalidTransitionError) {
    return { error: error.message };
  }
  if (error instanceof ZodError) {
    return { error: "Dados inválidos. Recarregue a página e tente novamente." };
  }
  return { error: "Algo deu errado, tente novamente." };
}

function revalidateOrder(orderId: string): void {
  revalidatePath("/admin/pedidos");
  revalidatePath(`/admin/pedidos/${orderId}`);
  revalidatePath("/admin/pedidos/embalar");
  revalidatePath("/admin/pedidos/rota");
  revalidatePath("/admin");
}

async function runTransition(
  formData: FormData,
  to: OrderStatus,
  successMessage: string,
  options?: { reason?: string; restock?: boolean },
): Promise<FormState> {
  const user = await requireUser();
  try {
    const orderId = orderIdSchema.parse(formData.get("orderId"));
    const db = getDb();
    await transitionOrder(db, {
      orderId,
      to,
      userId: user.id,
      reason: options?.reason,
      restock: options?.restock,
    });
    revalidateOrder(orderId);
    return { success: successMessage };
  } catch (error) {
    return friendlyError(error);
  }
}

export async function confirmOrderAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return runTransition(
    formData,
    "pending_payment",
    "Pedido confirmado — o estoque dos itens foi reservado.",
  );
}

export async function markPaidAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return runTransition(
    formData,
    "paid",
    "Pedido marcado como pago — estoque baixado e venda lançada no financeiro.",
  );
}

export async function startPreparingAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return runTransition(formData, "preparing", "Separação iniciada.");
}

export async function markShippedAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireUser();
  try {
    const orderId = orderIdSchema.parse(formData.get("orderId"));
    const trackingCode = String(formData.get("trackingCode") ?? "").trim();
    await shipOrder(getDb(), { orderId, ...(trackingCode ? { trackingCode } : {}), userId: user.id });
    revalidateOrder(orderId);
    return {
      success: trackingCode
        ? "Pedido marcado como enviado com código de rastreio."
        : "Pedido marcado como enviado.",
    };
  } catch (error) {
    return friendlyError(error);
  }
}

/**
 * "Entregue — enviar foto": foto na mão da cliente + quem recebeu →
 * deliverOrderWithPhoto (processa, guarda, leva a 'delivered' pela máquina
 * de estados e a fila manda a foto à cliente).
 */
export async function deliverWithPhotoAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  try {
    const orderId = orderIdSchema.parse(formData.get("orderId"));
    const photo = formData.get("photo");
    if (!(photo instanceof File) || photo.size === 0) {
      return { error: "Tire (ou escolha) a foto da entrega antes de enviar." };
    }
    if (!photo.type.startsWith("image/")) {
      return { error: "O arquivo precisa ser uma imagem (JPG, PNG ou HEIC)." };
    }
    if (photo.size > PACKAGE_PHOTO_MAX_BYTES) {
      return { error: "A foto passou de 8 MB. Tire a foto direto pela câmera ou escolha uma menor." };
    }
    const receivedBy = String(formData.get("receivedBy") ?? "").slice(0, 180);
    const result = await deliverOrderWithPhoto(getDb(), getFileStorage(), {
      orderId,
      photo: { data: new Uint8Array(await photo.arrayBuffer()), contentType: photo.type },
      receivedBy,
      userId: user.id,
    });
    revalidateOrder(orderId);
    revalidatePath("/admin/pedidos/entregar");
    revalidatePath("/admin/pedidos/rota");
    return {
      success: result.rephoto
        ? "Foto trocada. A cliente não recebe uma segunda mensagem — a nova foto fica na página do pedido."
        : result.alreadyDelivered
          ? "Foto registrada na página do pedido. A cliente já tinha o aviso de entrega — ela não recebe outro."
          : `Pedido #${result.orderNumber} entregue${result.receivedBy ? ` — recebido por ${result.receivedBy}` : ""}. Se a cliente aceitou avisos, ela recebe a foto pelo WhatsApp em instantes.`,
    };
  } catch (error) {
    return friendlyError(error);
  }
}

export async function markDeliveredAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireUser();
  try {
    const orderId = orderIdSchema.parse(formData.get("orderId"));
    await deliverByHand(getDb(), { orderId, userId: user.id });
    revalidateOrder(orderId);
    return { success: "Pedido marcado como entregue." };
  } catch (error) {
    return friendlyError(error);
  }
}

export async function cancelOrderAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const reason = String(formData.get("reason") ?? "").trim();
  const restock = formData.get("restock") === "on";
  return runTransition(formData, "canceled", "Pedido cancelado.", {
    reason: reason || undefined,
    restock,
  });
}

/**
 * Reembolso é dinheiro saindo do caixa (cria lançamento no financeiro): só o
 * proprietário. As demais transições do pedido seguem com a equipe — o
 * requireUser de runTransition continua valendo para elas.
 */
export async function refundOrderAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  await requireOwner("financeiro");
  const reason = String(formData.get("reason") ?? "").trim();
  const restock = formData.get("restock") === "on";
  return runTransition(
    formData,
    "refunded",
    "Pedido reembolsado — lançamento de reembolso criado no financeiro.",
    { reason: reason || undefined, restock },
  );
}

/**
 * "Embalei": foto do pacote → packOrder (processa, guarda, leva o pedido a
 * 'preparing' e enfileira a foto para a cliente). A validação do arquivo
 * fica aqui, na fronteira; o service revalida o tipo.
 */
export async function packOrderAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireUser();
  try {
    const orderId = orderIdSchema.parse(formData.get("orderId"));
    const photo = formData.get("photo");
    if (!(photo instanceof File) || photo.size === 0) {
      return { error: "Escolha (ou tire) a foto do pacote antes de enviar." };
    }
    if (!photo.type.startsWith("image/")) {
      return { error: "O arquivo precisa ser uma imagem (JPG, PNG ou HEIC)." };
    }
    if (photo.size > PACKAGE_PHOTO_MAX_BYTES) {
      return { error: "A foto passou de 8 MB. Tire a foto direto pela câmera ou escolha uma menor." };
    }
    const result = await packOrder(getDb(), getFileStorage(), {
      orderId,
      photo: { data: new Uint8Array(await photo.arrayBuffer()), contentType: photo.type },
      userId: user.id,
    });
    revalidateOrder(orderId);
    return {
      success: result.rephoto
        ? "Foto trocada. A cliente não recebe uma segunda mensagem — a nova foto fica na página do pedido."
        : result.status === "pending_payment"
          ? "Foto guardada: o pedido já pode sair com o motoboy (pagamento na entrega). Se a cliente aceitou avisos, ela recebe a foto pelo WhatsApp em instantes."
          : "Foto guardada e pedido em separação. Se a cliente aceitou avisos, ela recebe a foto pelo WhatsApp em instantes.",
    };
  } catch (error) {
    return friendlyError(error);
  }
}

/**
 * Uma peça voltou. Só o dono: mexe em estoque e em dinheiro (crédito ou
 * estorno parcial). O valor vem calculado da tela, mas quem confirma é ele.
 */
export async function returnOrderItemAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireOwner("financeiro");
  const refundRaw = String(formData.get("refundCents") ?? "").trim();
  try {
    const result = await returnOrderItem(getDb(), {
      orderId: String(formData.get("orderId") ?? ""),
      orderItemId: String(formData.get("orderItemId") ?? ""),
      quantity: Number(formData.get("quantity") ?? 1),
      resolution: String(formData.get("resolution") ?? "") === "dinheiro" ? "dinheiro" : "credito",
      ...(refundRaw === "" ? {} : { refundCents: Math.round(Number(refundRaw.replace(",", ".")) * 100) }),
      reason: String(formData.get("reason") ?? "").trim() || undefined,
      userId: user.id,
    });
    revalidateOrder(String(formData.get("orderId") ?? ""));
    return {
      success:
        result.resolution === "credito"
          ? `Peça devolvida ao estoque. Crédito de ${formatCentsBRL(result.refundCents)} no cupom ${result.couponCode} — a cliente recebe o código pelo WhatsApp.`
          : `Peça devolvida ao estoque. Estorno de ${formatCentsBRL(result.refundCents)} pedido ao Mercado Pago — a cliente é avisada quando o dinheiro sair.`,
    };
  } catch (error) {
    return friendlyError(error);
  }
}
