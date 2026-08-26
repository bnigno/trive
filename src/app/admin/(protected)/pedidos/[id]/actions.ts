"use server";

import { revalidatePath } from "next/cache";
import { z, ZodError } from "zod";

import { InvalidTransitionError, type OrderStatus } from "@/core/orders/state-machine";
import { getDb } from "@/db/client";
import { requireOwner, requireUser } from "@/services/auth";
import {
  ServiceError,
  transitionOrder,
  updateOrderTracking,
} from "@/services/orders";

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
    const db = getDb();
    if (trackingCode) {
      await updateOrderTracking(db, { orderId, trackingCode, userId: user.id });
    }
    await transitionOrder(db, { orderId, to: "shipped", userId: user.id });
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

export async function markDeliveredAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return runTransition(formData, "delivered", "Pedido marcado como entregue.");
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
