"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db/client";
import { requireUser } from "@/services/auth";
import {
  PAYMENT_METHODS,
  replaceFeeRule,
  ServiceError,
  updateDefaultPolicy,
  updateSetting,
} from "@/services/settings";
import { parseBRLToCents } from "@/lib/money";

export type FormState = { error?: string; success?: string };

function toErrorMessage(error: unknown): string {
  if (error instanceof ServiceError) return error.message;
  if (error instanceof z.ZodError) {
    return error.issues[0]?.message ?? "Dados inválidos. Confira os campos.";
  }
  return "Algo deu errado, tente novamente.";
}

/** '4,98' (por cento) -> 0.0498 (fração). Aceita '30' -> 0.3. */
function parsePercentField(raw: string, label: string): number {
  let cents: number;
  try {
    cents = parseBRLToCents(raw.trim());
  } catch {
    throw new ServiceError(
      "percentual_invalido",
      `${label}: informe um número, ex.: 4,98 (para 4,98%).`,
    );
  }
  const rate = cents / 10000;
  if (rate < 0 || rate >= 1) {
    throw new ServiceError(
      "percentual_invalido",
      `${label}: informe um percentual entre 0 e 100.`,
    );
  }
  return rate;
}

/** '2,50' -> 250 centavos. */
function parseMoneyField(raw: string, label: string): number {
  try {
    const cents = parseBRLToCents(raw.trim());
    if (cents < 0) throw new RangeError("negativo");
    return cents;
  } catch {
    throw new ServiceError(
      "valor_invalido",
      `${label}: informe um valor em reais, ex.: 2,50.`,
    );
  }
}

function parseIntField(raw: string, label: string): number {
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ServiceError(
      "numero_invalido",
      `${label}: informe um número inteiro maior ou igual a zero.`,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Taxas do Mercado Pago — nova vigência
// ---------------------------------------------------------------------------

const paymentMethodSchema = z.enum(PAYMENT_METHODS);

export async function replaceFeeRuleAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireUser();
  try {
    const paymentMethod = paymentMethodSchema.parse(formData.get("paymentMethod"));
    const percentRate = parsePercentField(
      String(formData.get("percent") ?? ""),
      "Taxa percentual",
    );
    const fixedFeeCents = parseMoneyField(
      String(formData.get("fixedFee") ?? "0"),
      "Tarifa fixa",
    );
    const settlementDays = parseIntField(
      String(formData.get("settlementDays") ?? ""),
      "Prazo de repasse",
    );
    const installmentsRaw = String(formData.get("installmentsMax") ?? "").trim();
    const installmentsMax =
      installmentsRaw === ""
        ? undefined
        : parseIntField(installmentsRaw, "Parcelas (máximo)");
    if (installmentsMax !== undefined && installmentsMax < 1) {
      return { error: "Parcelas (máximo): informe um número a partir de 1." };
    }

    await replaceFeeRule(getDb(), {
      paymentMethod,
      percentRate,
      fixedFeeCents,
      settlementDays,
      installmentsMax,
      isReferenceForPricing: formData.get("isReference") === "on",
      userId: user.id,
    });

    revalidatePath("/admin/configuracoes");
    return {
      success:
        "Nova vigência salva. Os preços já cadastrados NÃO mudam sozinhos — recalcule quando quiser.",
    };
  } catch (error) {
    return { error: toErrorMessage(error) };
  }
}

// ---------------------------------------------------------------------------
// Política de precificação
// ---------------------------------------------------------------------------

const roundingModeSchema = z.enum(["none", "to_90", "to_99", "to_50", "integer"]);
const roundingDirectionSchema = z.enum(["up", "nearest"]);

export async function updatePolicyAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireUser();
  try {
    const targetMarginRate = parsePercentField(
      String(formData.get("targetMargin") ?? ""),
      "Margem alvo",
    );
    const minMarginRate = parsePercentField(
      String(formData.get("minMargin") ?? ""),
      "Margem mínima",
    );
    const roundingMode = roundingModeSchema.parse(formData.get("roundingMode"));
    const roundingDirection = roundingDirectionSchema.parse(
      formData.get("roundingDirection"),
    );
    const otherCostsFixedCents = parseMoneyField(
      String(formData.get("otherCostsFixed") ?? "0"),
      "Custos fixos por venda",
    );

    await updateDefaultPolicy(getDb(), {
      targetMarginRate,
      minMarginRate,
      roundingMode,
      roundingDirection,
      otherCostsFixedCents,
      userId: user.id,
    });

    revalidatePath("/admin/configuracoes");
    return { success: "Política de precificação salva." };
  } catch (error) {
    return { error: toErrorMessage(error) };
  }
}

// ---------------------------------------------------------------------------
// Regras de aprovação
// ---------------------------------------------------------------------------

export async function updateApprovalRulesAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireUser();
  try {
    const threshold = parsePercentField(
      String(formData.get("changeThreshold") ?? ""),
      "Limite de variação",
    );
    const db = getDb();
    await updateSetting(db, {
      key: "price_change_pct_threshold",
      value: threshold,
      userId: user.id,
    });
    await updateSetting(db, {
      key: "first_price_requires_approval",
      value: formData.get("firstPriceRequiresApproval") === "on",
      userId: user.id,
    });

    revalidatePath("/admin/configuracoes");
    return { success: "Regras de aprovação salvas." };
  } catch (error) {
    return { error: toErrorMessage(error) };
  }
}

// ---------------------------------------------------------------------------
// Estoque
// ---------------------------------------------------------------------------

export async function updateStockSettingsAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireUser();
  try {
    const lowStockThreshold = parseIntField(
      String(formData.get("lowStockThreshold") ?? ""),
      "Limiar de estoque baixo",
    );
    const ttlMinutes = parseIntField(
      String(formData.get("reservationTtlMinutes") ?? ""),
      "Tempo de reserva",
    );

    const db = getDb();
    await updateSetting(db, {
      key: "default_low_stock_threshold",
      value: lowStockThreshold,
      userId: user.id,
    });
    await updateSetting(db, {
      key: "stock_reservation_ttl_minutes",
      value: ttlMinutes,
      userId: user.id,
    });

    revalidatePath("/admin/configuracoes");
    return { success: "Configurações de estoque salvas." };
  } catch (error) {
    return { error: toErrorMessage(error) };
  }
}
