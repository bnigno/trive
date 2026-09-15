"use server";

// Os gestos do motoboy pela página da saída. Recebem SOMENTE o token do
// link (a credencial) e ids de parada; Zod na fronteira, um service por
// gesto; as mensagens do service voltam como estão para a tela.
import { revalidatePath } from "next/cache";
import { z, ZodError } from "zod";

import { InvalidRunTransitionError, FAILURE_REASONS } from "@/core/delivery/state";
import { InvalidTransitionError } from "@/core/orders/state-machine";
import { getDb } from "@/db/client";
import { completeStop, failStop, finishDeliveryRun, startDeliveryRun } from "@/services/delivery-runs";
import { ServiceError } from "@/services/orders";

export type CourierActionResult = { ok: true; message?: string } | { ok: false; error: string };

function friendly(error: unknown): CourierActionResult {
  if (error instanceof ServiceError || error instanceof InvalidRunTransitionError || error instanceof InvalidTransitionError) {
    return { ok: false, error: error.message };
  }
  if (error instanceof ZodError) return { ok: false, error: "Dados inválidos — recarregue a página e tente de novo." };
  console.error("[entrega] ação do motoboy falhou", error);
  return { ok: false, error: "Não deu certo agora. Confira a internet e tente de novo." };
}

const tokenSchema = z.uuid();
const positionSchema = z
  .object({ lat: z.number(), lng: z.number(), accuracyM: z.number().nullable().optional() })
  .nullable()
  .optional();

export async function startRunAction(token: string): Promise<CourierActionResult> {
  try {
    const courierToken = tokenSchema.parse(token);
    await startDeliveryRun(getDb(), { courierToken });
    revalidatePath(`/entrega/${courierToken}`);
    return { ok: true };
  } catch (error) {
    return friendly(error);
  }
}

const completeSchema = z.object({
  token: tokenSchema,
  stopId: z.uuid(),
  receivedBy: z.string().max(180).nullable().optional(),
  position: positionSchema,
});

export async function completeStopAction(input: z.input<typeof completeSchema>): Promise<CourierActionResult> {
  try {
    const parsed = completeSchema.parse(input);
    const result = await completeStop(getDb(), {
      courierToken: parsed.token,
      stopId: parsed.stopId,
      receivedBy: parsed.receivedBy ?? null,
      position: parsed.position ?? null,
    });
    revalidatePath(`/entrega/${parsed.token}`);
    return {
      ok: true,
      message: result.awaitingCash
        ? `Pedido #${result.orderNumber} entregue. O dinheiro você acerta com a loja na volta.`
        : `Pedido #${result.orderNumber} entregue${result.receivedBy ? ` para ${result.receivedBy}` : ""}.`,
    };
  } catch (error) {
    return friendly(error);
  }
}

const failSchema = z.object({
  token: tokenSchema,
  stopId: z.uuid(),
  reason: z.enum(FAILURE_REASONS),
  note: z.string().max(200).nullable().optional(),
});

export async function failStopAction(input: z.input<typeof failSchema>): Promise<CourierActionResult> {
  try {
    const parsed = failSchema.parse(input);
    const result = await failStop(getDb(), { courierToken: parsed.token, stopId: parsed.stopId, reason: parsed.reason, note: parsed.note ?? null });
    revalidatePath(`/entrega/${parsed.token}`);
    return { ok: true, message: `Pedido #${result.orderNumber} marcado como não entregue — a loja já foi avisada. Traga a peça de volta.` };
  } catch (error) {
    return friendly(error);
  }
}

export async function finishRunAction(token: string): Promise<CourierActionResult> {
  try {
    const courierToken = tokenSchema.parse(token);
    await finishDeliveryRun(getDb(), { courierToken });
    revalidatePath(`/entrega/${courierToken}`);
    return { ok: true };
  } catch (error) {
    return friendly(error);
  }
}
