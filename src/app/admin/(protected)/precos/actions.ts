"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { getDb } from "@/db/client";
import { formatCentsBRL, parseBRLToCents } from "@/lib/money";
import { requireOwner } from "@/services/auth";
import {
  applyPriceToProduct,
  recalculateAllPrices,
  type ApplyPriceToProductResult,
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

export type ApplyPriceState = { error?: string; success?: string };

const applyPriceFormSchema = z.object({
  productId: z.uuid("Produto inválido. Recarregue a página e tente novamente."),
  preco: z
    .string()
    .trim()
    .min(1, "Informe o preço a aplicar (ex.: 149,90)."),
});

function applyPriceSummary(result: ApplyPriceToProductResult): string {
  const price = formatCentsBRL(result.priceCents);
  if (result.created === 0) {
    return `Nada a fazer: todas as variantes ativas já estão em ${price}.`;
  }
  const variantes =
    result.created === 1 ? "1 variante" : `${result.created} variantes`;
  const extra =
    result.skipped > 0
      ? ` Outras ${result.skipped} já estavam nesse preço.`
      : "";
  return (
    `${price} aplicado a ${variantes}: ${result.autoActivated} já valendo e ` +
    `${result.pendingApproval} aguardando aprovação.${extra}`
  );
}

/** Aplica o mesmo preço a todas as variantes ativas de um produto. */
export async function applyPriceToProductAction(
  _previous: ApplyPriceState,
  formData: FormData,
): Promise<ApplyPriceState> {
  const user = await requireOwner("precos");

  const parsed = applyPriceFormSchema.safeParse({
    productId: formData.get("productId"),
    preco: formData.get("preco"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0].message };
  }

  try {
    const priceCents = parseBRLToCents(parsed.data.preco);
    if (priceCents <= 0) {
      throw new RangeError("O preço deve ser maior que zero.");
    }
    const result = await applyPriceToProduct(getDb(), {
      productId: parsed.data.productId,
      priceCents,
      userId: user.id,
    });

    revalidatePath("/admin/precos");
    revalidatePath("/admin/precos/pendencias");

    return { success: applyPriceSummary(result) };
  } catch (error) {
    return { error: actionErrorMessage(error) };
  }
}
