"use server";
// "Me avisa quando voltar" na página da peça: telefone + consentimento
// explícito de UMA mensagem. Sem login: a identidade é o telefone (E.164),
// como no checkout e no WhatsApp. Honeypot silencioso contra robôs.
import { z } from "zod";

import type { SameDayPromise } from "@/core/shipping/delivery-windows";
import { getDb } from "@/db/client";
import { toE164BR } from "@/lib/phone";
import { computeTotalWeightGrams, quoteSameDayPromise } from "@/services/store-catalog";
import { BODY_LABELS, EASE_LABELS } from "@/core/style/fit";
import { adviseSizeForProduct, type FitAdviceView } from "@/services/fit-advice";
import { requestStockAlert } from "@/services/stock-alerts";
import { forgetBodyMeasurements, saveBodyMeasurements } from "@/services/style-profiles";

const schema = z.object({
  variantId: z.uuid(),
  phone: z.string().trim().min(8, "Informe o seu WhatsApp."),
  consent: z.literal(true, { error: "Marque a caixinha para receber o aviso." }),
  /** Honeypot: humano deixa vazio. */
  website: z.string().max(0).optional(),
});

export type RestockAlertResult =
  | { ok: true; created: boolean }
  | { ok: false; message: string };

export async function requestStockAlertAction(input: {
  variantId: string;
  phone: string;
  consent: boolean;
  website?: string;
}): Promise<RestockAlertResult> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? "Confira os dados." };
  }
  if (parsed.data.website) return { ok: true, created: false };
  const phoneE164 = toE164BR(parsed.data.phone);
  if (!phoneE164) return { ok: false, message: "Informe um WhatsApp válido com DDD." };
  try {
    const result = await requestStockAlert(getDb(), {
      variantId: parsed.data.variantId,
      phoneE164,
      source: "site",
    });
    return { ok: true, created: result.created };
  } catch (error) {
    console.error("requestStockAlertAction", error);
    return { ok: false, message: "Não deu para registrar agora. Tente de novo em instantes." };
  }
}

// "Pague até 13h e chega hoje": a promessa do motoboy para o CEP que a
// cliente já deu na sacola. Peso de 1 peça (a variação escolhida); sem CEP
// válido ou sem motoboy → null, e a página não mostra nada.
const promiseSchema = z.object({
  cep: z.string().regex(/^\d{8}$/),
  weightGrams: z.number().int().positive().nullable(),
});

export async function sameDayPromiseAction(input: {
  cep: string;
  weightGrams: number | null;
}): Promise<SameDayPromise | null> {
  const parsed = promiseSchema.safeParse(input);
  if (!parsed.success) return null;
  try {
    return await quoteSameDayPromise(getDb(), {
      cep: parsed.data.cep,
      totalWeightGrams: computeTotalWeightGrams([{ weightGrams: parsed.data.weightGrams, quantity: 1 }]),
    });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// "Vai me servir?": as medidas do corpo na cartela (token do navegador) e o
// veredito por tamanho. Controllers burros: Zod → um service.
// ---------------------------------------------------------------------------

const fitAdviceSchema = z.object({ slug: z.string().min(1), token: z.uuid() });

export type FitAdviceResult =
  | { ok: true; kind: FitAdviceView["advice"]["kind"]; text: string; verdicts: { size: string; overall: string; points: { label: string; cm: number }[] }[]; recommended: string | null }
  | { ok: false; message: string };

export async function fitAdviceAction(input: { slug: string; token: string }): Promise<FitAdviceResult> {
  const parsed = fitAdviceSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "Abra a sua cartela de estilo primeiro." };
  try {
    const view = await adviseSizeForProduct(getDb(), { slug: parsed.data.slug, siteToken: parsed.data.token });
    const advice = view.advice;
    return {
      ok: true,
      kind: advice.kind,
      text: view.text,
      verdicts:
        advice.kind === "advice"
          ? advice.verdicts.map((verdict) => ({
              size: verdict.size,
              overall: EASE_LABELS[verdict.overall],
              points: verdict.points.map((point) => ({ label: BODY_LABELS[point.key], cm: point.cm })),
            }))
          : [],
      recommended: advice.kind === "advice" ? advice.recommended : null,
    };
  } catch (error) {
    console.error("fitAdviceAction", error);
    return { ok: false, message: "Não consegui calcular agora. Tente de novo em instantes." };
  }
}

const saveBodySchema = z.object({
  token: z.uuid(),
  bustCm: z.coerce.number().min(40).max(200).optional(),
  waistCm: z.coerce.number().min(40).max(200).optional(),
  hipsCm: z.coerce.number().min(40).max(200).optional(),
});

export async function saveBodyMeasurementsAction(input: { token: string; bustCm?: number | string; waistCm?: number | string; hipsCm?: number | string }): Promise<{ ok: true } | { ok: false; message: string }> {
  const cleaned = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== "" && value !== undefined && value !== null));
  const parsed = saveBodySchema.safeParse(cleaned);
  if (!parsed.success) return { ok: false, message: "Medidas em centímetros, entre 40 e 200." };
  const { token, ...body } = parsed.data;
  if (Object.keys(body).length === 0) return { ok: false, message: "Informe ao menos uma medida." };
  try {
    const { saved } = await saveBodyMeasurements(getDb(), { siteToken: token, body });
    if (!saved) return { ok: false, message: "Não achei a sua cartela — faça o quiz de estilo de novo." };
    return { ok: true };
  } catch (error) {
    console.error("saveBodyMeasurementsAction", error);
    return { ok: false, message: "Não consegui guardar agora. Tente de novo em instantes." };
  }
}

export async function forgetBodyMeasurementsAction(input: { token: string }): Promise<{ ok: boolean }> {
  const token = z.uuid().safeParse(input.token);
  if (!token.success) return { ok: false };
  try {
    const { forgotten } = await forgetBodyMeasurements(getDb(), { siteToken: token.data });
    return { ok: forgotten };
  } catch (error) {
    console.error("forgetBodyMeasurementsAction", error);
    return { ok: false };
  }
}
