"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { getDb } from "@/db/client";
import { toE164BR } from "@/lib/phone";
import { requireUser } from "@/services/auth";
import { cancelStockAlert } from "@/services/stock-alerts";
import { createStockHold, HoldError, releaseStockHold } from "@/services/stock-holds";

export type HoldFormState = { error?: string; success?: string };

const createSchema = z.object({
  variantId: z.uuid(),
  phone: z.string().trim().min(8, "Informe o WhatsApp da cliente."),
  quantity: z.coerce.number().int().min(1).max(2).default(1),
});

export async function createHoldAction(_prev: HoldFormState, formData: FormData): Promise<HoldFormState> {
  const user = await requireUser();
  const parsed = createSchema.safeParse({
    variantId: formData.get("variantId"),
    phone: formData.get("phone"),
    quantity: formData.get("quantity") ?? 1,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Confira os dados." };
  const phoneE164 = toE164BR(parsed.data.phone);
  if (!phoneE164) return { error: "Telefone inválido — use DDD + número." };
  try {
    const hold = await createStockHold(getDb(), {
      variantId: parsed.data.variantId,
      phoneE164,
      quantity: parsed.data.quantity,
      createdBy: "admin",
      userId: user.id,
    });
    revalidatePath(`/admin/estoque/${parsed.data.variantId}`);
    return { success: `Separada: ${hold.description}.` };
  } catch (error) {
    if (error instanceof HoldError) return { error: error.message };
    return { error: error instanceof Error ? error.message : "Não deu para separar agora." };
  }
}

export async function releaseHoldAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const holdId = z.uuid().parse(formData.get("holdId"));
  const back = String(formData.get("back") ?? "/admin/estoque");
  await releaseStockHold(getDb(), { holdId, reason: "released", userId: user.id });
  revalidatePath(back);
}

export async function cancelAlertAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const alertId = z.uuid().parse(formData.get("alertId"));
  const back = String(formData.get("back") ?? "/admin/estoque");
  await cancelStockAlert(getDb(), { alertId, userId: user.id });
  revalidatePath(back);
}
