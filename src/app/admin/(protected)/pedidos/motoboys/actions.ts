"use server";
// Motoboys: cadastrar, editar e ativar/desativar. Zod na fronteira, um
// service por action; as mensagens do service sobem como estão.
import { revalidatePath } from "next/cache";
import { z, ZodError } from "zod";

import { getDb } from "@/db/client";
import { requireUser } from "@/services/auth";
import { createCourier, updateCourier } from "@/services/couriers";
import { ServiceError } from "@/services/orders";

export type FormState = { error?: string; success?: string };

function friendlyError(error: unknown): FormState {
  if (error instanceof ServiceError) return { error: error.message };
  if (error instanceof ZodError) return { error: error.issues[0]?.message ?? "Dados inválidos. Confira os campos." };
  return { error: "Algo deu errado, tente novamente." };
}

function revalidate(): void {
  revalidatePath("/admin/pedidos/motoboys");
  revalidatePath("/admin/pedidos/rota");
}

const createSchema = z.object({ name: z.string(), phone: z.string() });

export async function createCourierAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  try {
    const { name, phone } = createSchema.parse({ name: formData.get("name") ?? "", phone: formData.get("phone") ?? "" });
    const courier = await createCourier(getDb(), { name, phone, userId: user.id });
    revalidate();
    return { success: `${courier.name} cadastrado. Ele recebe o link de cada saída no WhatsApp ${courier.phoneE164}.` };
  } catch (error) {
    return friendlyError(error);
  }
}

const updateSchema = z.object({ courierId: z.uuid(), name: z.string(), phone: z.string() });

export async function updateCourierAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  try {
    const { courierId, name, phone } = updateSchema.parse({ courierId: formData.get("courierId"), name: formData.get("name") ?? "", phone: formData.get("phone") ?? "" });
    await updateCourier(getDb(), { courierId, name, phone, userId: user.id });
    revalidate();
    return { success: "Motoboy atualizado." };
  } catch (error) {
    return friendlyError(error);
  }
}

const toggleSchema = z.object({ courierId: z.uuid(), isActive: z.enum(["true", "false"]) });

export async function toggleCourierAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const { courierId, isActive } = toggleSchema.parse({ courierId: formData.get("courierId"), isActive: formData.get("isActive") });
  await updateCourier(getDb(), { courierId, isActive: isActive === "true", userId: user.id });
  revalidate();
}
