"use server";
// Rota do dia: "Saiu" (o pedido vai com o motoboy) e reagendar a janela.
// Zod na fronteira, um service por action, revalidação das telas que mostram
// o pedido. Mensagens do service (pt-BR) sobem como estão.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z, ZodError } from "zod";

import { InvalidTransitionError } from "@/core/orders/state-machine";
import { deliveryWindowSchema } from "@/core/shipping/delivery-windows";
import { getDb } from "@/db/client";
import { requireUser } from "@/services/auth";
import { completeDispatchedOrder, rescheduleOrderWindow } from "@/services/delivery-routes";
import { createDeliveryRun, dispatchOrderWithCourier } from "@/services/delivery-runs";
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
  // "Entregue — o motoboy voltou" também fecha a linha na Mesa de entrega.
  revalidatePath("/admin/pedidos/entregar");
  revalidatePath("/admin");
}

const dispatchSchema = z.object({ orderId: z.uuid() });

const dispatchWithCourierSchema = dispatchSchema.extend({
  // "" = "Outro — sem link de GPS": só o "Saiu", como antes.
  courierId: z.union([z.literal(""), z.uuid("Escolha o motoboy.")]).optional(),
});

/** "Saiu" — com o motoboy escolhido, ele recebe o link com o GPS (dispatchOrderWithCourier). */
export async function dispatchOrderAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  try {
    const { orderId, courierId } = dispatchWithCourierSchema.parse({ orderId: formData.get("orderId"), courierId: formData.get("courierId") ?? undefined });
    const result = await dispatchOrderWithCourier(getDb(), { orderId, courierId: courierId || null, userId: user.id });
    revalidateRoute(orderId);
    if (result.withCourier) revalidatePath("/admin/pedidos/saidas");
    const n = `#${result.orderNumber}`;
    if (result.withCourier) {
      return {
        success: result.alreadyDispatched
          ? `O motoboy recebe o link do pedido ${n} no WhatsApp. A cliente não recebe outro aviso: o mapa aparece no link que ela já tem.`
          : `Pedido ${n} saiu — a cliente recebe o aviso e o motoboy, o link com o GPS no WhatsApp.`,
      };
    }
    return { success: result.alreadyDispatched ? `Pedido ${n} já tinha saído.` : `Pedido ${n} saiu — a cliente recebe o aviso no WhatsApp.` };
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

/** O motoboy voltou: pedido que saiu vira entregue (paid/preparing/shipped → delivered). */
export async function completeDispatchedOrderAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  try {
    const { orderId } = dispatchSchema.parse({ orderId: formData.get("orderId") });
    const result = await completeDispatchedOrder(getDb(), { orderId, userId: user.id });
    revalidateRoute(orderId);
    return { success: result.idempotent ? `Pedido #${result.orderNumber} já estava entregue.` : `Pedido #${result.orderNumber} entregue.` };
  } catch (error) {
    return friendlyError(error);
  }
}

const mountRunSchema = z.object({
  courierId: z.uuid("Escolha o motoboy."),
  orderIds: z.array(z.uuid()).min(1, "Marque pelo menos um pedido para a saída."),
});

/**
 * "Montar saída": os pedidos marcados recebem o "Saiu" (a cliente é avisada
 * na hora) e o motoboy recebe o link no WhatsApp. Depois, a página da saída.
 */
export async function createDeliveryRunAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  let runId: string;
  try {
    const { courierId, orderIds } = mountRunSchema.parse({ courierId: formData.get("courierId"), orderIds: formData.getAll("orderIds") });
    const created = await createDeliveryRun(getDb(), { courierId, orderIds, userId: user.id });
    runId = created.runId;
    for (const stop of created.stops) revalidateRoute(stop.orderId);
    revalidatePath("/admin/pedidos/saidas");
  } catch (error) {
    return friendlyError(error);
  }
  redirect(`/admin/pedidos/saidas/${runId}`);
}
