"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import { getDb } from "@/db/client";
import { parseBRLToCents } from "@/lib/money";
import { requireOwner } from "@/services/auth";
import {
  createProduct,
  ServiceError,
  type CreateProductInput,
} from "@/services/catalog";

export type FormState = { error?: string; success?: string };

type VariantRowPayload = {
  sku?: string;
  cost?: string;
  attributes?: Record<string, string>;
};

function toErrorState(error: unknown): FormState {
  if (error instanceof ServiceError) return { error: error.message };
  if (error instanceof ZodError) {
    return { error: error.issues[0]?.message ?? "Dados inválidos." };
  }
  return { error: "Algo deu errado, tente novamente." };
}

export async function createProductAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireOwner("produtos");

  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { error: "Informe o nome do produto." };
  const description = String(formData.get("description") ?? "").trim();
  const brand = String(formData.get("brand") ?? "").trim();
  const categoryId = String(formData.get("categoryId") ?? "").trim();

  // Eixos de variação: texto "cor, tamanho" → ["cor", "tamanho"].
  const axes = String(formData.get("axes") ?? "")
    .split(",")
    .map((axis) => axis.trim())
    .filter(Boolean);

  let rows: VariantRowPayload[];
  try {
    rows = JSON.parse(String(formData.get("variantsJson") ?? "[]"));
  } catch {
    return { error: "Algo deu errado, tente novamente." };
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    return { error: "Cadastre ao menos uma variação." };
  }

  const variants: CreateProductInput["variants"] = [];
  for (const [index, row] of rows.entries()) {
    const sku = (row.sku ?? "").trim();
    if (!sku) {
      return { error: `Informe o SKU da variação ${index + 1}.` };
    }

    const attributes: Record<string, string> = {};
    for (const axis of axes) {
      const value = (row.attributes?.[axis] ?? "").trim();
      if (!value) {
        return {
          error: `Preencha o campo "${axis}" da variação ${index + 1}.`,
        };
      }
      attributes[axis] = value;
    }

    let costCents: number | undefined;
    const costRaw = (row.cost ?? "").trim();
    if (costRaw) {
      try {
        costCents = parseBRLToCents(costRaw);
      } catch {
        return {
          error: `Custo inválido na variação "${sku}". Use o formato 1.234,56.`,
        };
      }
      if (costCents < 0) {
        return { error: `O custo da variação "${sku}" não pode ser negativo.` };
      }
    }

    variants.push({ sku, attributes, costCents });
  }

  let productId: string;
  try {
    const db = getDb();
    const result = await createProduct(db, {
      name,
      description: description || undefined,
      brand: brand || undefined,
      categoryId: categoryId || undefined,
      attributesSchema: axes,
      variants,
      userId: user.id,
    });
    productId = result.product.id;
  } catch (error) {
    return toErrorState(error);
  }

  revalidatePath("/admin/produtos");
  redirect(`/admin/produtos/${productId}`);
}
