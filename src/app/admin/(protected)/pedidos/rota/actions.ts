"use server";
// Rota do dia: "Saiu" (o pedido vai com o motoboy) e reagendar a janela.
// Zod na fronteira, um service por action, revalidação das telas que mostram
// o pedido. Mensagens do service (pt-BR) sobem como estão.
import { revalidatePath } from "next/cache";
import { z, ZodError } from "zod";

import { InvalidTransitionError } from "@/core/orders/state-machine";
import { deliveryWindowSchema } from "@/core/shipping/delivery-windows";
import { getDb } from "@/db/client";
import { requireUser } from "@/services/auth";
import { dispatchOrder, rescheduleOrderWindow } from "@/services/delivery-routes";
import { ServiceError } from "@/services/orders";

export type FormState = { error?: string; success?: string };

function friendlyError(error: unknown): FormState {
  if (error instanceof ServiceError || error instanceof InvalidTransitionError) {
    return { error: error.message };
  }
  if (error instanceof ZodError) {
    return { error: error.issues[0]?.message ?? "Dados inválidos. Recarregue a página e tente novamente." };
  }
  return { error: "Algo deu errado, tente novamente." };
}

function revalidateRoute(orderId: string): void {
  revalidatePath("/admin/pedidos/rota");
  revalidatePath("/admin/pedidos");
  revalidatePath(`/admin/pedidos/${orderId}`);
  revalidatePath("/admin/pedidos/embalar");
  revalidatePath("/admin");
}

const dispatchSchema = z.object({ orderId: z.uuid() });

export async function dispatchOrderAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  try {
    const { orderId } = dispatchSchema.parse({ orderId: formData.get("orderId") });
    const result = await dispatchOrder(getDb(), { orderId, userId: user.id });
    revalidateRoute(orderId);
    return {
      success: result.idempotent
        ? `Pedido #${result.orderNumber} já tinha saído.`
        : `Pedido #${result.orderNumber} saiu — a cliente recebe o aviso no WhatsApp.`,
    };
  } catch (error) {
    return friendlyError(error);
  }
}

// "dayKey|start|end|cutoff" — o valor de cada opção do select de reagendar.
const rescheduleSchema = z.object({
  orderId: z.uuid(),
  choice: z.string().regex(/^\d{4}-\d{2}-\d{2}\|\d{2}:\d{2}\|\d{2}:\d{2}\|\d{2}:\d{2}$/, "Escolha uma janela."),
});

export async function rescheduleWindowAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  try {
    const { orderId, choice } = rescheduleSchema.parse({ orderId: formData.get("orderId"), choice: formData.get("choice") });
    const [dayKey, start, end, cutoff] = choice.split("|");
    const window = deliveryWindowSchema.parse({ start, end, cutoff });
    await rescheduleOrderWindow(getDb(), { orderId, userId: user.id, dayKey, window });
    revalidateRoute(orderId);
    return { success: "Janela reagendada. Avise a cliente pelo WhatsApp." };
  } catch (error) {
    return friendlyError(error);
  }
}
