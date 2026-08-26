"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { getDb } from "@/db/client";
import { requireOwner } from "@/services/auth";
import {
  recalculateAllPrices,
  type RecalculateAllPricesResult,
} from "@/services/pricing";
import { actionErrorMessage } from "./errors";

export type RecalcState = { error?: string; success?: string };

/**
 * Recalcula o preço de todas as variantes ativas com preço ativo e leva o
 * usuário direto para a tela de pendências com o resumo do lote na URL.
 */
export async function recalculateAllAction(
  _previous: RecalcState,
  _formData: FormData,
): Promise<RecalcState> {
  const user = await requireOwner("precos");
  const db = getDb();

  let result: RecalculateAllPricesResult | undefined;
  try {
    result = await recalculateAllPrices(db, { userId: user.id });
  } catch (error) {
    return { error: actionErrorMessage(error) };
  }
  if (!result) {
    return { error: "Algo deu errado, tente novamente." };
  }

  revalidatePath("/admin/precos");
  revalidatePath("/admin/precos/pendencias");

  const params = new URLSearchParams({
    lote: result.batchId,
    criadas: String(result.created),
    ativadas: String(result.autoActivated),
    pendentes: String(result.pendingApproval),
    iguais: String(result.unchanged),
  });
  redirect(`/admin/precos/pendencias?${params.toString()}`);
}
