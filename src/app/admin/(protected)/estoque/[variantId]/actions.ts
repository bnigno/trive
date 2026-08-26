"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db/client";
import { requireOwner, requireUser } from "@/services/auth";
import { ServiceError as PricingServiceError } from "@/services/pricing";
import {
  adjustStock,
  receivePurchase,
  receiveStock,
  ServiceError,
} from "@/services/stock";
import { InsufficientStockError, SignError } from "@/core/stock/ledger";
import { parseBRLToCents } from "@/lib/money";

export type StockFormState = { error?: string; success?: string };

/** Erros de negócio têm mensagem pt-BR pronta; o resto vira mensagem genérica. */
function toErrorMessage(error: unknown): string {
  if (
    error instanceof ServiceError ||
    error instanceof PricingServiceError ||
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

  // Custo é dinheiro do negócio: a equipe nem vê o campo. Se o valor vier
  // assim mesmo (POST forjado), ele é IGNORADO em vez de aceito — aceitar
  // reescreveria o custo do produto e dispararia reprecificação. A entrada
  // continua valendo: a mercadoria chegou de verdade.
  const canSetCost = user.role === "owner";

  let unitCostCents: number | undefined;
  if (canSetCost && unitCostRaw !== "") {
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

/**
 * Entrada de compra COM fornecedor: custo obrigatório, gera conta a pagar
 * e sugestão de reprecificação. Entrada sem fornecedor usa receiveStockAction.
 *
 * Só o proprietário: a compra escolhe fornecedor, grava custo e mexe no
 * financeiro — as três coisas que a equipe não vê. A entrada simples
 * (receiveStockAction) continua liberada para quem recebe a mercadoria.
 */
export async function receivePurchaseAction(
  _prev: StockFormState,
  formData: FormData,
): Promise<StockFormState> {
  const user = await requireOwner("fornecedores");

  const variantId = String(formData.get("variantId") ?? "");
  const supplierId = z.uuid().safeParse(formData.get("supplierId"));
  if (!supplierId.success) {
    return { error: "Escolha o fornecedor da compra." };
  }

  const quantityRaw = String(formData.get("quantity") ?? "").trim();
  if (!/^\d+$/.test(quantityRaw) || Number(quantityRaw) <= 0) {
    return {
      error: "Informe a quantidade recebida: um número inteiro maior que zero.",
    };
  }

  const unitCostRaw = String(formData.get("unitCost") ?? "").trim();
  if (unitCostRaw === "") {
    return {
      error: "Informe o custo unitário — ele é obrigatório na compra com fornecedor.",
    };
  }
  let unitCostCents: number;
  try {
    unitCostCents = parseBRLToCents(unitCostRaw);
  } catch {
    return { error: "Custo unitário inválido. Use o formato 1.234,56." };
  }
  if (unitCostCents <= 0) {
    return { error: "O custo unitário da compra deve ser maior que zero." };
  }

  const dueDateRaw = String(formData.get("dueDate") ?? "").trim();
  if (dueDateRaw !== "" && !z.iso.date().safeParse(dueDateRaw).success) {
    return { error: "Vencimento inválido. Use o seletor de data." };
  }

  const invoiceNumber = String(formData.get("invoiceNumber") ?? "").trim();
  const noteRaw = String(formData.get("note") ?? "").trim();

  let repriced = false;
  try {
    const result = await receivePurchase(getDb(), {
      variantId,
      supplierId: supplierId.data,
      quantity: Number(quantityRaw),
      unitCostCents,
      invoiceNumber: invoiceNumber === "" ? undefined : invoiceNumber,
      dueDate: dueDateRaw === "" ? undefined : dueDateRaw,
      note: noteRaw === "" ? undefined : noteRaw,
      userId: user.id,
    });
    repriced = result.priceVersion !== null;
  } catch (error) {
    return { error: toErrorMessage(error) };
  }

  revalidateStock(variantId);
  revalidatePath("/admin/financeiro");
  revalidatePath(`/admin/fornecedores/${supplierId.data}`);
  return {
    success: repriced
      ? "Compra registrada: conta a pagar criada no financeiro e sugestão de reprecificação gerada em Preços."
      : "Compra registrada: conta a pagar criada no financeiro e custo do produto atualizado.",
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
