"use server";

import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import { getDb } from "@/db/client";
import { getFileStorage } from "@/adapters/storage";
import {
  createCategory,
  removeCategoryCover,
  ServiceError,
  setCategoryCover,
  updateCategoryCoverFocus,
} from "@/services/catalog";
import { requireOwner } from "@/services/auth";

export type FormState = { error?: string; success?: string };

function toErrorState(error: unknown): FormState {
  if (error instanceof ServiceError) return { error: error.message };
  if (error instanceof ZodError) {
    return { error: error.issues[0]?.message ?? "Dados inválidos." };
  }
  return { error: "Algo deu errado, tente novamente." };
}

/** A capa aparece no admin, na home e na coleção. */
function revalidateCategoryCover(): void {
  revalidatePath("/admin/produtos");
  revalidatePath("/");
  revalidatePath("/produtos");
}

export async function createCategoryAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireOwner("produtos");
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

function focalYFrom(formData: FormData): number {
  return Number(String(formData.get("focalY") ?? "50"));
}

export async function uploadCategoryCoverAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireOwner("produtos");
  const categoryId = String(formData.get("categoryId") ?? "");
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { error: "Escolha uma foto para a capa." };
  }

  try {
    const db = getDb();
    const storage = getFileStorage();
    await setCategoryCover(db, storage, {
      categoryId,
      data: Buffer.from(await file.arrayBuffer()),
      contentType: file.type || "application/octet-stream",
      focalY: focalYFrom(formData),
      userId: user.id,
    });
  } catch (error) {
    return toErrorState(error);
  }

  revalidateCategoryCover();
  return { success: "Capa da sala atualizada." };
}

export async function updateCategoryCoverFocusAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireOwner("produtos");
  const categoryId = String(formData.get("categoryId") ?? "");

  try {
    const db = getDb();
    await updateCategoryCoverFocus(db, {
      categoryId,
      focalY: focalYFrom(formData),
      userId: user.id,
    });
  } catch (error) {
    return toErrorState(error);
  }

  revalidateCategoryCover();
  return { success: "Foco da capa salvo." };
}

export async function removeCategoryCoverAction(formData: FormData): Promise<void> {
  const user = await requireOwner("produtos");
  const categoryId = String(formData.get("categoryId") ?? "");
  const db = getDb();
  const storage = getFileStorage();
  await removeCategoryCover(db, storage, { categoryId, userId: user.id });
  revalidateCategoryCover();
}
