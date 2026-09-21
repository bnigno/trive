"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db/client";
import { requireOwner } from "@/services/auth";
import { ServiceError } from "@/services/orders";
import { createCoupon, deleteCoupon, updateCoupon, type CreateCouponInput } from "@/services/coupons";
import { updateSetting } from "@/services/settings";
import { parseProductRefs, parseTimeToMinutes, parseWeekdays } from "@/lib/coupon-fields";
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
function parsePositiveIntField(raw: string, label: string): number | null {
  const value = raw.trim();
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new ServiceError(
      "limite_invalido",
      `${label}: informe um número inteiro maior que zero (ou deixe vazio).`,
    );
  }
  return parsed;
}

/** "14:00" -> 840; vazio -> null; inválido -> erro. */
function parseTimeField(raw: string, label: string): number | null {
  const value = raw.trim();
  if (!value) return null;
  const minutes = parseTimeToMinutes(value);
  if (minutes === null) {
    throw new ServiceError("horario_invalido", `${label}: informe a hora como 14:00.`);
  }
  return minutes;
}

const typeSchema = z.enum(["percent", "fixed", "free_shipping"], {
  message: "Tipo de desconto inválido.",
});
const scopeSchema = z.enum(["any", "motoboy", "correios"], {
  message: "Escopo do frete grátis inválido.",
});

function text(formData: FormData, name: string): string {
  return String(formData.get(name) ?? "");
}

/** Os campos de regra do cupom, compartilhados por criar e editar. */
function readRuleFields(formData: FormData): Omit<CreateCouponInput, "code" | "userId" | "isActive"> {
  const type = typeSchema.parse(formData.get("type"));
  const rawValue = text(formData, "value");
  const value =
    type === "free_shipping"
      ? 0
      : type === "percent"
        ? parsePercentField(rawValue, "Valor do desconto (%)")
        : parseMoneyField(rawValue, "Valor do desconto (R$)");
  if (type === "fixed" && value <= 0) {
    throw new ServiceError("valor_invalido", "Valor do desconto (R$): informe um valor maior que zero.");
  }
  const rawMin = text(formData, "minOrder").trim();
  const minOrderCents = rawMin ? parseMoneyField(rawMin, "Pedido mínimo (R$)") : 0;
  const startsAt = parseDatetimeField(text(formData, "startsAt"), "Início da vigência");
  const expiresAt = parseDatetimeField(text(formData, "expiresAt"), "Fim da vigência");
  if (startsAt && expiresAt && expiresAt.getTime() <= startsAt.getTime()) {
    throw new ServiceError("vigencia_invalida", "O fim da vigência deve ser depois do início.");
  }
  const validFromMinute = parseTimeField(text(formData, "validFrom"), "Horário de início");
  const validToMinute = parseTimeField(text(formData, "validTo"), "Horário de fim");
  if ((validFromMinute === null) !== (validToMinute === null)) {
    throw new ServiceError("horario_invalido", "Informe o horário de início e o de fim (ou deixe os dois vazios).");
  }
  if (validFromMinute !== null && validToMinute !== null && validFromMinute >= validToMinute) {
    throw new ServiceError("horario_invalido", "O fim do horário deve ser depois do início.");
  }
  const customerPhone = text(formData, "customerPhone").trim();
  return {
    type,
    value,
    minOrderCents,
    startsAt,
    expiresAt,
    maxUses: parsePositiveIntField(text(formData, "maxUses"), "Limite de usos"),
    perCustomerLimit: parsePositiveIntField(text(formData, "perCustomerLimit"), "Limite por cliente"),
    customerPhone: customerPhone === "" ? null : customerPhone,
    firstPurchaseOnly: formData.get("firstPurchaseOnly") === "on",
    freeShippingScope: type === "free_shipping" ? scopeSchema.parse(formData.get("freeShippingScope") ?? "any") : "any",
    validWeekdays: parseWeekdays(formData.getAll("weekdays").map(String)),
    validFromMinute,
    validToMinute,
    productRefs: parseProductRefs(text(formData, "productRefs")),
    categoryIds: formData.getAll("categoryIds").map(String).filter((id) => id !== ""),
    note: text(formData, "note").trim() || null,
  };
}

export async function createCouponAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireOwner("cupons");
  try {
    const code = text(formData, "code").trim().toUpperCase();
    if (!code) {
      throw new ServiceError("codigo_obrigatorio", "Informe o código do cupom.");
    }
    await createCoupon(getDb(), { code, ...readRuleFields(formData), userId: user.id });
    revalidatePath("/admin/cupons");
    return {
      success: `Cupom ${code} criado. Divulgue o código — ou o link /c/${code} — para suas clientes!`,
    };
  } catch (error) {
    return { error: toErrorMessage(error) };
  }
}

const idSchema = z.uuid();

/**
 * Edita o cupom. mode=limited (cupom já usado): só fim da vigência, limite
 * de usos e nota; mode=full: tudo. O serviço recusa regras em cupom usado
 * mesmo que o form minta.
 */
export async function updateCouponAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireOwner("cupons");
  try {
    const couponId = idSchema.parse(formData.get("id"));
    if (formData.get("mode") === "full") {
      await updateCoupon(getDb(), { couponId, ...readRuleFields(formData), userId: user.id });
    } else {
      await updateCoupon(getDb(), {
        couponId,
        expiresAt: parseDatetimeField(text(formData, "expiresAt"), "Fim da vigência"),
        maxUses: parsePositiveIntField(text(formData, "maxUses"), "Limite de usos"),
        note: text(formData, "note").trim() || null,
        userId: user.id,
      });
    }
    revalidatePath("/admin/cupons");
    return { success: "Cupom salvo." };
  } catch (error) {
    return { error: toErrorMessage(error) };
  }
}

/** Alterna ativo/inativo; o valor novo vem do form (nextActive). */
export async function toggleCouponAction(formData: FormData): Promise<void> {
  const user = await requireOwner("cupons");
  const couponId = idSchema.parse(formData.get("id"));
  const nextActive = formData.get("nextActive") === "true";
  await updateCoupon(getDb(), {
    couponId,
    isActive: nextActive,
    userId: user.id,
  });
  revalidatePath("/admin/cupons");
}

/** Apaga um cupom que ninguém usou (o serviço recusa os demais). */
export async function deleteCouponAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireOwner("cupons");
  try {
    const couponId = idSchema.parse(formData.get("id"));
    await deleteCoupon(getDb(), { couponId, userId: user.id });
    revalidatePath("/admin/cupons");
    return { success: "Cupom excluído." };
  } catch (error) {
    return { error: toErrorMessage(error) };
  }
}

/** Inteiro dentro de [min, max]; o form manda sempre o valor. */
function parseIntField(raw: string, label: string, min: number, max: number): number {
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ServiceError("numero_invalido", `${label}: informe um número inteiro entre ${min} e ${max}.`);
  }
  return value;
}

/** Cupons automáticos — desculpas pelo atraso do motoboy. */
export async function saveLateDeliverySettingsAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireOwner("cupons");
  try {
    const db = getDb();
    const values: Array<{ key: string; value: unknown }> = [
      { key: "late_delivery_coupon_enabled", value: formData.get("enabled") === "on" },
      { key: "late_delivery_grace_minutes", value: parseIntField(text(formData, "graceMinutes"), "Carência (minutos)", 0, 240) },
      { key: "late_delivery_coupon_percent", value: parseIntField(text(formData, "percent"), "Desconto (%)", 1, 50) },
      { key: "late_delivery_coupon_days", value: parseIntField(text(formData, "days"), "Vale por (dias)", 1, 180) },
    ];
    for (const { key, value } of values) {
      await updateSetting(db, { key, value, userId: user.id });
    }
    revalidatePath("/admin/cupons");
    return { success: "Cupons automáticos salvos." };
  } catch (error) {
    return { error: toErrorMessage(error) };
  }
}
