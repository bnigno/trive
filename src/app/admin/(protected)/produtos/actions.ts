"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z, ZodError } from "zod";
import { getDb } from "@/db/client";
import { getFileStorage } from "@/adapters/storage";
import {
  createCategory,
  removeCategoryCover,
  ServiceError,
  setCategoryCover,
  updateCategoryCoverFocus,
} from "@/services/catalog";
import { deleteProduct, restoreProduct } from "@/services/catalog-delete";
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

// ---------------------------------------------------------------------------
// Excluir e restaurar peça
//
// Excluir marca deleted_at (a peça some de tudo e pode voltar) e apaga as
// fotos de verdade. O aviso do que vai acontecer mora na tela
// /admin/produtos/[id]/excluir — aqui só se executa o que ela já explicou.
// ---------------------------------------------------------------------------

/** A peça pode estar na vitrine e nos cartões: revalida painel e loja. */
function revalidateProductEverywhere(productId: string): void {
  revalidatePath("/admin/produtos");
  revalidatePath(`/admin/produtos/${productId}`);
  revalidatePath("/");
  revalidatePath("/produtos");
  // A tag da página leva o grupo de rota: sem "(store)" nada é invalidado.
  revalidatePath("/(store)/produto/[slug]", "page");
}

export async function deleteProductAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireOwner("produtos");
  const productId = z.uuid().safeParse(formData.get("productId"));
  if (!productId.success) return { error: "Algo deu errado, tente novamente." };

  let result;
  try {
    result = await deleteProduct(getDb(), getFileStorage(), {
      productId: productId.data,
      userId: user.id,
    });
  } catch (error) {
    return toErrorState(error);
  }

  revalidateProductEverywhere(productId.data);
  const params = new URLSearchParams({ status: "excluidas", excluida: result.name });
  // O banco já está certo; arquivo que resistiu é recado, não erro.
  if (result.filesFailed.length > 0) {
    params.set("arquivos", String(result.filesFailed.length));
  }
  redirect(`/admin/produtos?${params.toString()}`);
}

export async function restoreProductAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireOwner("produtos");
  const productId = z.uuid().safeParse(formData.get("productId"));
  if (!productId.success) return { error: "Algo deu errado, tente novamente." };

  let result;
  try {
    result = await restoreProduct(getDb(), {
      productId: productId.data,
      userId: user.id,
    });
  } catch (error) {
    return toErrorState(error);
  }

  revalidateProductEverywhere(productId.data);
  return {
    success: result.restored
      ? `«${result.name}» voltou como rascunho. Suba as fotos antes de ativar.`
      : `«${result.name}» já estava no catálogo.`,
  };
}
