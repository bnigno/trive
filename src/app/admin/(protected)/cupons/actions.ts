"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db/client";
import { requireUser } from "@/services/auth";
import { ServiceError } from "@/services/orders";
import { createCoupon, updateCoupon } from "@/services/coupons";
import { parseBRLToCents } from "@/lib/money";

export type FormState = { error?: string; success?: string };

/** Cobre o ServiceError local e o do serviço de cupons (mesmo name). */
function isServiceError(error: unknown): error is Error {
  return error instanceof Error && error.name === "ServiceError";
}

function toErrorMessage(error: unknown): string {
  if (isServiceError(error)) return error.message;
  if (error instanceof z.ZodError) {
    return error.issues[0]?.message ?? "Dados inválidos. Confira os campos.";
  }
  return "Algo deu errado, tente novamente.";
}

/** '10' ou '10%' -> 10 (inteiro de 1 a 100). */
function parsePercentField(raw: string, label: string): number {
  const value = Number(raw.trim().replace(/%/g, ""));
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new ServiceError(
      "percentual_invalido",
      `${label}: informe um número inteiro de 1 a 100.`,
    );
  }
  return value;
}

/** '24,90' -> 2490 centavos (não-negativo). */
function parseMoneyField(raw: string, label: string): number {
  try {
    const cents = parseBRLToCents(raw.trim());
    if (cents < 0) throw new RangeError("negativo");
    return cents;
  } catch {
    throw new ServiceError(
      "valor_invalido",
      `${label}: informe um valor em reais, ex.: 24,90.`,
    );
  }
}

/** datetime-local ('2026-08-24T15:30') -> Date; vazio -> null. */
function parseDatetimeField(raw: string, label: string): Date | null {
  const value = raw.trim();
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new ServiceError("data_invalida", `${label}: data/hora inválida.`);
  }
  return date;
}

/** Inteiro >= 1; vazio -> null (sem limite). */
function parseMaxUsesField(raw: string): number | null {
  const value = raw.trim();
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new ServiceError(
      "limite_invalido",
      "Limite de usos: informe um número inteiro maior que zero (ou deixe vazio para ilimitado).",
    );
  }
  return parsed;
}

const typeSchema = z.enum(["percent", "fixed"], {
  message: "Tipo de desconto inválido.",
});

export async function createCouponAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireUser();
  try {
    const code = String(formData.get("code") ?? "").trim().toUpperCase();
    if (!code) {
      throw new ServiceError("codigo_obrigatorio", "Informe o código do cupom.");
    }
    const type = typeSchema.parse(formData.get("type"));
    const rawValue = String(formData.get("value") ?? "");
    const value =
      type === "percent"
        ? parsePercentField(rawValue, "Valor do desconto (%)")
        : parseMoneyField(rawValue, "Valor do desconto (R$)");
    if (type === "fixed" && value <= 0) {
      throw new ServiceError(
        "valor_invalido",
        "Valor do desconto (R$): informe um valor maior que zero.",
      );
    }
    const rawMin = String(formData.get("minOrder") ?? "").trim();
    const minOrderCents = rawMin
      ? parseMoneyField(rawMin, "Pedido mínimo (R$)")
      : 0;
    const startsAt = parseDatetimeField(
      String(formData.get("startsAt") ?? ""),
      "Início da vigência",
    );
    const expiresAt = parseDatetimeField(
      String(formData.get("expiresAt") ?? ""),
      "Fim da vigência",
    );
    if (startsAt && expiresAt && expiresAt.getTime() <= startsAt.getTime()) {
      throw new ServiceError(
        "vigencia_invalida",
        "O fim da vigência deve ser depois do início.",
      );
    }
    const maxUses = parseMaxUsesField(String(formData.get("maxUses") ?? ""));

    await createCoupon(getDb(), {
      code,
      type,
      value,
      minOrderCents,
      startsAt,
      expiresAt,
      maxUses,
      userId: user.id,
    });
    revalidatePath("/admin/cupons");
    return {
      success: `Cupom ${code} criado. Divulgue o código para seus clientes!`,
    };
  } catch (error) {
    return { error: toErrorMessage(error) };
  }
}

const idSchema = z.uuid();

/** Edita vigência (fim) e limite de usos — campos vazios removem o limite. */
export async function updateCouponAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireUser();
  try {
    const couponId = idSchema.parse(formData.get("id"));
    const expiresAt = parseDatetimeField(
      String(formData.get("expiresAt") ?? ""),
      "Fim da vigência",
    );
    const maxUses = parseMaxUsesField(String(formData.get("maxUses") ?? ""));

    await updateCoupon(getDb(), {
      couponId,
      expiresAt,
      maxUses,
      userId: user.id,
    });
    revalidatePath("/admin/cupons");
    return { success: "Cupom salvo." };
  } catch (error) {
    return { error: toErrorMessage(error) };
  }
}

/** Alterna ativo/inativo; o valor novo vem do form (nextActive). */
export async function toggleCouponAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const couponId = idSchema.parse(formData.get("id"));
  const nextActive = formData.get("nextActive") === "true";
  await updateCoupon(getDb(), {
    couponId,
    isActive: nextActive,
    userId: user.id,
  });
  revalidatePath("/admin/cupons");
}
