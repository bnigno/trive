"use server";

import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import { getDb } from "@/db/client";
import { getFileStorage } from "@/adapters/storage";
import { requireOwner } from "@/services/auth";
import {
  addProductImage,
  addVariant,
  removeProductImage,
  ServiceError,
  updateProduct,
  updateVariant,
} from "@/services/catalog";

export type FormState = { error?: string; success?: string };

function toErrorState(error: unknown): FormState {
  if (error instanceof ServiceError) return { error: error.message };
  if (error instanceof ZodError) {
    return { error: error.issues[0]?.message ?? "Dados inválidos." };
  }
  return { error: "Algo deu errado, tente novamente." };
}

function revalidateProduct(productId: string): void {
  revalidatePath("/admin/produtos");
  revalidatePath(`/admin/produtos/${productId}`);
}

/** Reconstrói atributos a partir de inputs nomeados "attr:<eixo>". */
function attributesFromForm(formData: FormData): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (key.startsWith("attr:") && typeof value === "string") {
      attributes[key.slice("attr:".length)] = value.trim();
    }
  }
  return attributes;
}

// ---------------------------------------------------------------------------
// Dados básicos e status
// ---------------------------------------------------------------------------

export async function updateProductAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireOwner("produtos");
  const productId = String(formData.get("productId") ?? "");

  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { error: "Informe o nome do produto." };
  const description = String(formData.get("description") ?? "").trim();
  const brand = String(formData.get("brand") ?? "").trim();
  const categoryId = String(formData.get("categoryId") ?? "").trim();
  const supplierId = String(formData.get("supplierId") ?? "").trim();
  const axes = String(formData.get("axes") ?? "")
    .split(",")
    .map((axis) => axis.trim())
    .filter(Boolean);

  try {
    const db = getDb();
    await updateProduct(db, {
      productId,
      userId: user.id,
      name,
      description: description || null,
      brand: brand || null,
      categoryId: categoryId || null,
      supplierId: supplierId || null,
      attributesSchema: axes,
    });
  } catch (error) {
    return toErrorState(error);
  }

  revalidateProduct(productId);
  return { success: "Produto atualizado." };
}

export async function setProductStatusAction(
  formData: FormData,
): Promise<void> {
  const user = await requireOwner("produtos");
  const productId = String(formData.get("productId") ?? "");
  const status = String(formData.get("status") ?? "");
  if (status !== "draft" && status !== "active" && status !== "archived") {
    return;
  }

  try {
    const db = getDb();
    await updateProduct(db, { productId, userId: user.id, status });
  } catch {
    // Sem estado de formulário aqui: em caso de erro a tela apenas não muda.
    return;
  }

  revalidateProduct(productId);
}

// ---------------------------------------------------------------------------
// Imagens
// ---------------------------------------------------------------------------

export async function uploadImagesAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireOwner("produtos");
  const productId = String(formData.get("productId") ?? "");

  const files = formData
    .getAll("files")
    .filter((entry): entry is File => entry instanceof File && entry.size > 0);
  if (files.length === 0) {
    return { error: "Selecione ao menos uma imagem." };
  }

  const db = getDb();
  const storage = getFileStorage();
  let uploaded = 0;
  try {
    for (const file of files) {
      const data = Buffer.from(await file.arrayBuffer());
      await addProductImage(db, storage, {
        productId,
        data,
        contentType: file.type || "application/octet-stream",
        userId: user.id,
      });
      uploaded += 1;
    }
  } catch (error) {
    revalidateProduct(productId);
    const base = toErrorState(error);
    return uploaded > 0
      ? {
          error: `${base.error} (${uploaded} de ${files.length} imagens foram enviadas antes do erro.)`,
        }
      : base;
  }

  revalidateProduct(productId);
  return {
    success:
      uploaded === 1 ? "1 imagem enviada." : `${uploaded} imagens enviadas.`,
  };
}

export async function removeImageAction(formData: FormData): Promise<void> {
  const user = await requireOwner("produtos");
  const imageId = String(formData.get("imageId") ?? "");
  const productId = String(formData.get("productId") ?? "");

  try {
    const db = getDb();
    const storage = getFileStorage();
    await removeProductImage(db, storage, { imageId, userId: user.id });
  } catch {
    return;
  }

  revalidateProduct(productId);
}

// ---------------------------------------------------------------------------
// Variações
// ---------------------------------------------------------------------------

export async function addVariantAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireOwner("produtos");
  const productId = String(formData.get("productId") ?? "");
  const sku = String(formData.get("sku") ?? "").trim();
  if (!sku) return { error: "Informe o SKU da variação." };

  const attributes = attributesFromForm(formData);
  for (const [axis, value] of Object.entries(attributes)) {
    if (!value) return { error: `Preencha o campo "${axis}".` };
  }

  try {
    const db = getDb();
    await addVariant(db, { productId, userId: user.id, sku, attributes });
  } catch (error) {
    return toErrorState(error);
  }

  revalidateProduct(productId);
  return {
    success: `Variação "${sku}" criada. Defina o custo e o preço na calculadora de preços.`,
  };
}

export async function updateVariantAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireOwner("produtos");
  const productId = String(formData.get("productId") ?? "");
  const variantId = String(formData.get("variantId") ?? "");

  const attributes = attributesFromForm(formData);
  for (const [axis, value] of Object.entries(attributes)) {
    if (!value) return { error: `Preencha o campo "${axis}".` };
  }

  try {
    const db = getDb();
    await updateVariant(db, { variantId, userId: user.id, attributes });
  } catch (error) {
    return toErrorState(error);
  }

  revalidateProduct(productId);
  return { success: "Variação atualizada." };
}
