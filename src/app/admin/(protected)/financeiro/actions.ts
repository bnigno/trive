"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { getDb } from "@/db/client";
import { parseBRLToCents } from "@/lib/money";
import { requireUser } from "@/services/auth";
import {
  cancelEntry,
  createManualEntry,
  settleEntry,
} from "@/services/financial";
import { ServiceError } from "@/services/stock";

export type FormState = { error?: string; success?: string };

const DIRECTIONS = ["receivable", "payable"] as const;
const MANUAL_CATEGORIES = [
  "supplier",
  "shipping_cost",
  "mp_fee",
  "refund",
  "other",
] as const;

function toErrorState(error: unknown): FormState {
  if (error instanceof ServiceError) return { error: error.message };
  if (error instanceof z.ZodError) {
    const first = error.issues[0]?.message;
    if (first) return { error: first };
  }
  console.error("[financeiro] erro inesperado:", error);
  return { error: "Algo deu errado, tente novamente." };
}

function text(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value.trim() : "";
}

// ---------------------------------------------------------------------------
// Novo lançamento manual
// ---------------------------------------------------------------------------

export async function createEntryAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireUser();

  const direction = text(formData, "direction");
  if (!(DIRECTIONS as readonly string[]).includes(direction)) {
    return { error: "Escolha se o lançamento é uma entrada ou uma saída." };
  }

  const category = text(formData, "category");
  if (!(MANUAL_CATEGORIES as readonly string[]).includes(category)) {
    return { error: "Escolha a categoria do lançamento." };
  }

  const description = text(formData, "description");
  if (!description) {
    return { error: "Descreva o lançamento, ex.: Aluguel de agosto." };
  }

  let amountCents: number;
  try {
    amountCents = parseBRLToCents(text(formData, "amount"));
  } catch {
    return { error: "Valor inválido. Use números com vírgula, ex.: 1.234,56." };
  }
  if (amountCents <= 0) {
    return { error: "O valor deve ser maior que zero." };
  }

  const dueDate = text(formData, "dueDate");

  try {
    const db = getDb();
    await createManualEntry(db, {
      direction: direction as (typeof DIRECTIONS)[number],
      category,
      description,
      amountCents,
      dueDate: dueDate || undefined,
      userId: user.id,
    });
  } catch (error) {
    return toErrorState(error);
  }

  revalidatePath("/admin/financeiro");
  return { success: "Lançamento criado. Ele entra como pendente." };
}

// ---------------------------------------------------------------------------
// Liquidar (pending → settled)
// ---------------------------------------------------------------------------

export async function settleEntryAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireUser();

  const entryId = z.uuid().safeParse(formData.get("entryId"));
  if (!entryId.success) {
    return { error: "Algo deu errado, tente novamente." };
  }

  try {
    const db = getDb();
    await settleEntry(db, { entryId: entryId.data, userId: user.id });
  } catch (error) {
    return toErrorState(error);
  }

  revalidatePath("/admin/financeiro");
  return { success: "Lançamento liquidado." };
}

// ---------------------------------------------------------------------------
// Cancelar (pending → canceled, com motivo)
// ---------------------------------------------------------------------------

export async function cancelEntryAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireUser();

  const entryId = z.uuid().safeParse(formData.get("entryId"));
  if (!entryId.success) {
    return { error: "Algo deu errado, tente novamente." };
  }

  const reason = text(formData, "reason");
  if (!reason) {
    return { error: "Informe o motivo do cancelamento." };
  }

  try {
    const db = getDb();
    await cancelEntry(db, {
      entryId: entryId.data,
      userId: user.id,
      reason,
    });
  } catch (error) {
    return toErrorState(error);
  }

  revalidatePath("/admin/financeiro");
  return { success: "Lançamento cancelado." };
}
