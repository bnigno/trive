"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/db/client";
import { requireUser } from "@/services/auth";
import { adjustStock, receiveStock, ServiceError } from "@/services/stock";
import { InsufficientStockError, SignError } from "@/core/stock/ledger";
import { parseBRLToCents } from "@/lib/money";

export type StockFormState = { error?: string; success?: string };

/** Erros de negócio têm mensagem pt-BR pronta; o resto vira mensagem genérica. */
function toErrorMessage(error: unknown): string {
  if (
    error instanceof ServiceError ||
    error instanceof InsufficientStockError ||
    error instanceof SignError
  ) {
    return error.message;
  }
  return "Algo deu errado, tente novamente.";
}

function revalidateStock(variantId: string): void {
  revalidatePath("/admin/estoque");
  revalidatePath(`/admin/estoque/${variantId}`);
}

export async function receiveStockAction(
  _prev: StockFormState,
  formData: FormData,
): Promise<StockFormState> {
  const user = await requireUser();

  const variantId = String(formData.get("variantId") ?? "");
  const quantityRaw = String(formData.get("quantity") ?? "").trim();
  const unitCostRaw = String(formData.get("unitCost") ?? "").trim();
  const noteRaw = String(formData.get("note") ?? "").trim();

  if (!/^\d+$/.test(quantityRaw) || Number(quantityRaw) <= 0) {
    return {
      error: "Informe a quantidade recebida: um número inteiro maior que zero.",
    };
  }

  let unitCostCents: number | undefined;
  if (unitCostRaw !== "") {
    try {
      unitCostCents = parseBRLToCents(unitCostRaw);
    } catch {
      return { error: "Custo unitário inválido. Use o formato 1.234,56." };
    }
    if (unitCostCents < 0) {
      return { error: "O custo unitário não pode ser negativo." };
    }
  }

  try {
    await receiveStock(getDb(), {
      variantId,
      quantity: Number(quantityRaw),
      unitCostCents,
      note: noteRaw === "" ? undefined : noteRaw,
      userId: user.id,
    });
  } catch (error) {
    return { error: toErrorMessage(error) };
  }

  revalidateStock(variantId);
  return {
    success:
      unitCostCents !== undefined
        ? "Entrada registrada. O custo do produto foi atualizado."
        : "Entrada registrada com sucesso.",
  };
}

export async function adjustStockAction(
  _prev: StockFormState,
  formData: FormData,
): Promise<StockFormState> {
  const user = await requireUser();

  const variantId = String(formData.get("variantId") ?? "");
  const quantityRaw = String(formData.get("quantityDelta") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim();
  const asLoss = formData.get("asLoss") === "on";

  if (!/^[+-]?\d+$/.test(quantityRaw)) {
    return {
      error:
        "Informe a quantidade do ajuste com sinal: por exemplo, 5 para acrescentar ou -5 para retirar.",
    };
  }
  const quantityDelta = Number(quantityRaw);
  if (quantityDelta === 0) {
    return { error: "O ajuste precisa de uma quantidade diferente de zero." };
  }
  if (note === "") {
    return {
      error: "Explique o motivo do ajuste — a nota é obrigatória.",
    };
  }
  if (asLoss && quantityDelta > 0) {
    return {
      error:
        "Perda ou quebra sempre retira do estoque: use quantidade negativa, por exemplo -2.",
    };
  }

  try {
    await adjustStock(getDb(), {
      variantId,
      quantityDelta,
      note,
      asLoss,
      userId: user.id,
    });
  } catch (error) {
    return { error: toErrorMessage(error) };
  }

  revalidateStock(variantId);
  return {
    success: asLoss
      ? "Perda registrada no histórico."
      : "Ajuste registrado no histórico.",
  };
}
