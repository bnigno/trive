"use server";
// A saída pelo painel: reenviar o link ao motoboy, encerrar (quando ele
// esqueceu) e cancelar (o "Saiu" dos pedidos não volta — a tela avisa).
import { revalidatePath } from "next/cache";
import { z, ZodError } from "zod";

import { InvalidRunTransitionError } from "@/core/delivery/state";
import { getDb } from "@/db/client";
import { requireUser } from "@/services/auth";
import { cancelDeliveryRun, finishDeliveryRun, resendCourierLink } from "@/services/delivery-runs";
import { ServiceError } from "@/services/orders";

export type FormState = { error?: string; success?: string };

function friendlyError(error: unknown): FormState {
  if (error instanceof ServiceError || error instanceof InvalidRunTransitionError) return { error: error.message };
  if (error instanceof ZodError) return { error: error.issues[0]?.message ?? "Dados inválidos. Recarregue a página e tente novamente." };
  return { error: "Algo deu errado, tente novamente." };
}

function revalidateRun(runId: string): void {
  revalidatePath(`/admin/pedidos/saidas/${runId}`);
  revalidatePath("/admin/pedidos/saidas");
  revalidatePath("/admin/pedidos/rota");
  revalidatePath("/admin/pedidos");
}

const runSchema = z.object({ runId: z.uuid() });

export async function resendCourierLinkAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  try {
    const { runId } = runSchema.parse({ runId: formData.get("runId") });
    await resendCourierLink(getDb(), { runId, userId: user.id });
    revalidateRun(runId);
    return { success: "Link reenviado ao motoboy pelo WhatsApp." };
  } catch (error) {
    return friendlyError(error);
  }
}

export async function finishRunAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  try {
    const { runId } = runSchema.parse({ runId: formData.get("runId") });
    const result = await finishDeliveryRun(getDb(), { runId, userId: user.id });
    revalidateRun(runId);
    return { success: result.idempotent ? "A saída já estava encerrada." : "Saída encerrada." };
  } catch (error) {
    return friendlyError(error);
  }
}

export async function cancelRunAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  try {
    const { runId } = runSchema.parse({ runId: formData.get("runId") });
    const result = await cancelDeliveryRun(getDb(), { runId, userId: user.id });
    revalidateRun(runId);
    return { success: result.idempotent ? "A saída já estava cancelada." : "Saída cancelada. Os pedidos continuam como saídos — trate cada um na Rota do dia ou na ficha." };
  } catch (error) {
    return friendlyError(error);
  }
}
