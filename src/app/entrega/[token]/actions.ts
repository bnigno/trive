"use server";

// Os gestos do motoboy pela página da saída. Recebem SOMENTE o token do
// link (a credencial) e ids de parada; Zod na fronteira, um service por
// gesto; as mensagens do service voltam como estão para a tela.
import { revalidatePath } from "next/cache";
import { z, ZodError } from "zod";

import { getFileStorage } from "@/adapters/storage";
import { InvalidRunTransitionError, FAILURE_REASONS } from "@/core/delivery/state";
import { InvalidTransitionError } from "@/core/orders/state-machine";
import { getDb } from "@/db/client";
import { completeStop, failStop, finishDeliveryRun, startDeliveryRun } from "@/services/delivery-runs";
import { ServiceError } from "@/services/orders";
import { PACKAGE_PHOTO_MAX_BYTES } from "@/services/packing";
import { parseCompleteStopForm } from "./complete-form";

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

/** A foto da entrega é obrigatória: sem ela a parada não fecha (o service também confere). */
export async function completeStopAction(formData: FormData): Promise<CourierActionResult> {
  try {
    const { photo, ...fields } = parseCompleteStopForm(formData);
    const parsed = completeSchema.parse(fields);
    if (!photo) return { ok: false, error: "Tire a foto da entrega no endereço para confirmar." };
    if (!photo.type.startsWith("image/")) return { ok: false, error: "O arquivo precisa ser uma imagem (JPG, PNG ou HEIC)." };
    if (photo.size > PACKAGE_PHOTO_MAX_BYTES) return { ok: false, error: "A foto passou de 8 MB. Tire a foto direto pela câmera." };
    const result = await completeStop(getDb(), getFileStorage(), {
      courierToken: parsed.token,
      stopId: parsed.stopId,
      receivedBy: parsed.receivedBy ?? null,
      position: parsed.position ?? null,
      photo: { data: new Uint8Array(await photo.arrayBuffer()), contentType: photo.type },
    });
    revalidatePath(`/entrega/${parsed.token}`);
    const who = result.receivedBy ? ` para ${result.receivedBy}` : "";
    return {
      ok: true,
      message: result.idempotent
        ? `Pedido #${result.orderNumber} já estava marcado como entregue${who}${result.withPhoto ? "" : " (sem foto)"}.`
        : result.awaitingCash
          ? `Pedido #${result.orderNumber} entregue, foto registrada. O dinheiro você acerta com a loja na volta.`
          : `Pedido #${result.orderNumber} entregue${who} — a foto já foi para a loja.`,
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
