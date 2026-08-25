"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db/client";
import { requireUser } from "@/services/auth";
import {
  createShippingRate,
  listShippingRates,
  ServiceError,
  updateShippingRate,
} from "@/services/shipping";
import { parseBRLToCents } from "@/lib/money";

export type FormState = { error?: string; success?: string };

function toErrorMessage(error: unknown): string {
  if (error instanceof ServiceError) return error.message;
  if (error instanceof z.ZodError) {
    return error.issues[0]?.message ?? "Dados inválidos. Confira os campos.";
  }
  return "Algo deu errado, tente novamente.";
}

/** '24,90' -> 2490 centavos. */
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

/** '0,3' ou '0.3' (kg) -> 300 gramas. Aceita vírgula ou ponto como decimal. */
function parseKgToGrams(raw: string, label: string): number {
  const value = Number(raw.trim().replace(/\s/g, "").replace(",", "."));
  if (!Number.isFinite(value) || value < 0) {
    throw new ServiceError(
      "peso_invalido",
      `${label}: informe o peso em kg, ex.: 0,3 (300 g) ou 30.`,
    );
  }
  return Math.round(value * 1000);
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

function rateFieldsFromForm(formData: FormData) {
  return {
    name: String(formData.get("name") ?? ""),
    cepStart: String(formData.get("cepStart") ?? ""),
    cepEnd: String(formData.get("cepEnd") ?? ""),
    weightMinGrams: parseKgToGrams(
      String(formData.get("weightMinKg") ?? ""),
      "Peso mínimo (kg)",
    ),
    weightMaxGrams: parseKgToGrams(
      String(formData.get("weightMaxKg") ?? ""),
      "Peso máximo (kg)",
    ),
    priceCents: parseMoneyField(
      String(formData.get("price") ?? ""),
      "Preço do frete (R$)",
    ),
    deliveryDaysMin: parseIntField(
      String(formData.get("deliveryDaysMin") ?? ""),
      "Prazo mínimo (dias)",
    ),
    deliveryDaysMax: parseIntField(
      String(formData.get("deliveryDaysMax") ?? ""),
      "Prazo máximo (dias)",
    ),
  };
}

export async function createShippingRateAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireUser();
  try {
    await createShippingRate(getDb(), {
      ...rateFieldsFromForm(formData),
      userId: user.id,
    });
    revalidatePath("/admin/frete");
    return { success: "Faixa de frete criada. Ela já vale para novas cotações." };
  } catch (error) {
    return { error: toErrorMessage(error) };
  }
}

const idSchema = z.uuid();

export async function updateShippingRateAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireUser();
  try {
    const id = idSchema.parse(formData.get("id"));
    await updateShippingRate(getDb(), {
      id,
      ...rateFieldsFromForm(formData),
      isActive: formData.get("isActive") === "on",
      userId: user.id,
    });
    revalidatePath("/admin/frete");
    return { success: "Faixa de frete salva." };
  } catch (error) {
    return { error: toErrorMessage(error) };
  }
}

/** Alterna ativa/inativa mantendo os demais campos como estão. */
export async function toggleShippingRateAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = idSchema.parse(formData.get("id"));
  const db = getDb();
  const rate = (await listShippingRates(db)).find((r) => r.id === id);
  if (!rate) return;

  await updateShippingRate(db, {
    id: rate.id,
    name: rate.name,
    cepStart: rate.cepStart,
    cepEnd: rate.cepEnd,
    weightMinGrams: rate.weightMinGrams,
    weightMaxGrams: rate.weightMaxGrams,
    priceCents: rate.priceCents,
    deliveryDaysMin: rate.deliveryDaysMin,
    deliveryDaysMax: rate.deliveryDaysMax,
    isActive: !rate.isActive,
    userId: user.id,
  });
  revalidatePath("/admin/frete");
}
