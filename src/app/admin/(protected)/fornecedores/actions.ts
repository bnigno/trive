"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { getDb } from "@/db/client";
import { requireUser } from "@/services/auth";
import { ServiceError } from "@/services/catalog";
import { settleEntry } from "@/services/financial";
import { ServiceError as StockServiceError } from "@/services/stock";
import {
  createSupplier,
  deactivateSupplier,
  updateSupplier,
} from "@/services/suppliers";

export type FormState = { error?: string; success?: string };

/** Extrai a mensagem pt-BR de erros conhecidos; genérica para o resto. */
function toErrorState(error: unknown): FormState {
  if (error instanceof ServiceError || error instanceof StockServiceError) {
    return { error: error.message };
  }
  if (error instanceof z.ZodError) {
    const first = error.issues[0]?.message;
    if (first) return { error: first };
  }
  console.error("[fornecedores] erro inesperado:", error);
  return { error: "Algo deu errado, tente novamente." };
}

/** Campo de texto do form: string aparada ou undefined se vazio. */
function text(formData: FormData, name: string): string | undefined {
  const value = formData.get(name);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// ---------------------------------------------------------------------------
// Criar fornecedor
// ---------------------------------------------------------------------------

export async function createSupplierAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireUser();

  const name = text(formData, "name");
  if (!name) return { error: "Informe o nome do fornecedor." };

  let supplierId: string;
  try {
    const db = getDb();
    const supplier = await createSupplier(db, {
      name,
      contactName: text(formData, "contactName"),
      email: text(formData, "email"),
      phone: text(formData, "phone"),
      document: text(formData, "document"),
      pixKey: text(formData, "pixKey"),
      notes: text(formData, "notes"),
      userId: user.id,
    });
    supplierId = supplier.id;
  } catch (error) {
    return toErrorState(error);
  }

  revalidatePath("/admin/fornecedores");
  redirect(`/admin/fornecedores/${supplierId}`);
}

// ---------------------------------------------------------------------------
// Atualizar fornecedor
// ---------------------------------------------------------------------------

export async function updateSupplierAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireUser();

  const supplierId = z.uuid().safeParse(formData.get("supplierId"));
  if (!supplierId.success) {
    return { error: "Algo deu errado, tente novamente." };
  }

  const name = text(formData, "name");
  if (!name) return { error: "Informe o nome do fornecedor." };

  try {
    const db = getDb();
    await updateSupplier(db, {
      supplierId: supplierId.data,
      userId: user.id,
      name,
      // Campo vazio limpa o dado no cadastro.
      contactName: text(formData, "contactName") ?? null,
      email: text(formData, "email") ?? null,
      phone: text(formData, "phone") ?? null,
      document: text(formData, "document") ?? null,
      pixKey: text(formData, "pixKey") ?? null,
      notes: text(formData, "notes") ?? null,
    });
  } catch (error) {
    return toErrorState(error);
  }

  revalidatePath(`/admin/fornecedores/${supplierId.data}`);
  revalidatePath("/admin/fornecedores");
  return { success: "Dados do fornecedor salvos." };
}

// ---------------------------------------------------------------------------
// Desativar fornecedor (soft-delete)
// ---------------------------------------------------------------------------

export async function deactivateSupplierAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireUser();

  const supplierId = z.uuid().safeParse(formData.get("supplierId"));
  if (!supplierId.success) {
    return { error: "Algo deu errado, tente novamente." };
  }

  try {
    const db = getDb();
    await deactivateSupplier(db, {
      supplierId: supplierId.data,
      userId: user.id,
    });
  } catch (error) {
    return toErrorState(error);
  }

  revalidatePath("/admin/fornecedores");
  redirect("/admin/fornecedores");
}

// ---------------------------------------------------------------------------
// Liquidar conta a pagar direto do card do fornecedor
// ---------------------------------------------------------------------------

export async function settleSupplierEntryAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireUser();

  const supplierId = z.uuid().safeParse(formData.get("supplierId"));
  const entryId = z.uuid().safeParse(formData.get("entryId"));
  if (!supplierId.success || !entryId.success) {
    return { error: "Algo deu errado, tente novamente." };
  }

  try {
    const db = getDb();
    await settleEntry(db, { entryId: entryId.data, userId: user.id });
  } catch (error) {
    return toErrorState(error);
  }

  revalidatePath(`/admin/fornecedores/${supplierId.data}`);
  revalidatePath("/admin/financeiro");
  return { success: "Conta marcada como paga." };
}
