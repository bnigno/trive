"use server";

import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import { getDb } from "@/db/client";
import { createCategory, ServiceError } from "@/services/catalog";
import { requireUser } from "@/services/auth";

export type FormState = { error?: string; success?: string };

function toErrorState(error: unknown): FormState {
  if (error instanceof ServiceError) return { error: error.message };
  if (error instanceof ZodError) {
    return { error: error.issues[0]?.message ?? "Dados inválidos." };
  }
  return { error: "Algo deu errado, tente novamente." };
}

export async function createCategoryAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireUser();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { error: "Informe o nome da categoria." };

  try {
    const db = getDb();
    await createCategory(db, { name, userId: user.id });
  } catch (error) {
    return toErrorState(error);
  }

  revalidatePath("/admin/produtos");
  return { success: `Categoria "${name}" criada.` };
}
