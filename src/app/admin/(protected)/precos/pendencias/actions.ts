"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { getDb } from "@/db/client";
import { formatCentsBRL } from "@/lib/money";
import { requireUser } from "@/services/auth";
import {
  approveBatch,
  approvePriceVersion,
  rejectBatch,
  rejectPriceVersion,
} from "@/services/pricing";
import { actionErrorMessage } from "../errors";

export type ApprovalState = { error?: string; success?: string };

function revalidatePriceScreens(): void {
  revalidatePath("/admin/precos");
  revalidatePath("/admin/precos/pendencias");
}

function parseUuid(
  formData: FormData,
  field: string,
  message: string,
): string {
  const parsed = z.uuid().safeParse(String(formData.get(field) ?? ""));
  if (!parsed.success) throw new RangeError(message);
  return parsed.data;
}

export async function approveVersionAction(
  _previous: ApprovalState,
  formData: FormData,
): Promise<ApprovalState> {
  const user = await requireUser();
  try {
    const versionId = parseUuid(
      formData,
      "versionId",
      "Versão inválida. Recarregue a página e tente novamente.",
    );
    const version = await approvePriceVersion(getDb(), {
      versionId,
      userId: user.id,
    });
    revalidatePriceScreens();
    revalidatePath(`/admin/precos/historico/${version.productVariantId}`);
    return {
      success: `Preço ${formatCentsBRL(version.priceCents)} aprovado e ativado.`,
    };
  } catch (error) {
    return { error: actionErrorMessage(error) };
  }
}

export async function rejectVersionAction(
  _previous: ApprovalState,
  formData: FormData,
): Promise<ApprovalState> {
  const user = await requireUser();
  try {
    const versionId = parseUuid(
      formData,
      "versionId",
      "Versão inválida. Recarregue a página e tente novamente.",
    );
    const motivo = String(formData.get("motivo") ?? "").trim();
    if (!motivo) {
      return { error: "Informe o motivo da rejeição." };
    }
    await rejectPriceVersion(getDb(), {
      versionId,
      userId: user.id,
      reason: motivo,
    });
    revalidatePriceScreens();
    return { success: "Versão rejeitada. O preço ativo atual foi mantido." };
  } catch (error) {
    return { error: actionErrorMessage(error) };
  }
}

export async function approveBatchAction(
  _previous: ApprovalState,
  formData: FormData,
): Promise<ApprovalState> {
  const user = await requireUser();
  try {
    const batchId = parseUuid(
      formData,
      "batchId",
      "Lote inválido. Recarregue a página e tente novamente.",
    );
    const result = await approveBatch(getDb(), { batchId, userId: user.id });
    revalidatePriceScreens();
    return {
      success:
        result.approvedCount === 1
          ? "Lote aprovado: 1 preço ativado."
          : `Lote aprovado: ${result.approvedCount} preços ativados.`,
    };
  } catch (error) {
    return { error: actionErrorMessage(error) };
  }
}

export async function rejectBatchAction(
  _previous: ApprovalState,
  formData: FormData,
): Promise<ApprovalState> {
  const user = await requireUser();
  try {
    const batchId = parseUuid(
      formData,
      "batchId",
      "Lote inválido. Recarregue a página e tente novamente.",
    );
    const motivo = String(formData.get("motivo") ?? "").trim();
    if (!motivo) {
      return { error: "Informe o motivo da rejeição do lote." };
    }
    const result = await rejectBatch(getDb(), {
      batchId,
      userId: user.id,
      reason: motivo,
    });
    revalidatePriceScreens();
    return {
      success:
        result.rejectedCount === 1
          ? "Lote rejeitado (1 versão). Os preços ativos foram mantidos."
          : `Lote rejeitado (${result.rejectedCount} versões). Os preços ativos foram mantidos.`,
    };
  } catch (error) {
    return { error: actionErrorMessage(error) };
  }
}
