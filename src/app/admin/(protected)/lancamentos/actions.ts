"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { getDb } from "@/db/client";
import { requireOwner } from "@/services/auth";
import {
  cancelDrop,
  createDrop,
  previewDropAudience,
  scheduleDrop,
  ServiceError,
  setDropProducts,
  updateDrop,
  type AudiencePreview,
} from "@/services/drops";

export type FormState = { error?: string; success?: string };

function toErrorMessage(error: unknown): string {
  if (error instanceof ServiceError) return error.message;
  if (error instanceof z.ZodError) return error.issues[0]?.message ?? "Dados inválidos. Confira os campos.";
  return "Algo deu errado, tente novamente.";
}

/** 'AAAA-MM-DDTHH:mm' digitado no horário de São Paulo → Date (UTC-3 fixo). */
function parseSpDateTime(raw: string, label: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(raw.trim());
  if (!match) throw new ServiceError("data_invalida", `${label}: informe data e hora.`);
  const date = new Date(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:00-03:00`);
  if (Number.isNaN(date.getTime())) throw new ServiceError("data_invalida", `${label}: data inválida.`);
  return date;
}

function parseIntField(raw: string, label: string, min: number, max: number): number {
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ServiceError("numero_invalido", `${label}: informe um número inteiro entre ${min} e ${max}.`);
  }
  return value;
}

export async function createDropAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireOwner("lancamentos");
  let dropId: string;
  try {
    const result = await createDrop(getDb(), {
      name: String(formData.get("name") ?? ""),
      publishAt: parseSpDateTime(String(formData.get("publishAt") ?? ""), "Publicação"),
      vipWindowHours: parseIntField(String(formData.get("vipWindowHours") ?? "24"), "Janela VIP (horas)", 1, 168),
      audienceLimit: parseIntField(String(formData.get("audienceLimit") ?? "60"), "Limite de convidadas", 1, 500),
      messageOverride: String(formData.get("messageOverride") ?? "").trim() || undefined,
      userId: user.id,
    });
    dropId = result.dropId;
  } catch (error) {
    return { error: toErrorMessage(error) };
  }
  revalidatePath("/admin/lancamentos");
  redirect(`/admin/lancamentos/${dropId}`);
}

export async function updateDropAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireOwner("lancamentos");
  try {
    const dropId = z.uuid().parse(formData.get("dropId"));
    const publishAtRaw = String(formData.get("publishAt") ?? "").trim();
    await updateDrop(getDb(), {
      dropId,
      name: String(formData.get("name") ?? "").trim() || undefined,
      ...(publishAtRaw ? { publishAt: parseSpDateTime(publishAtRaw, "Publicação") } : {}),
      ...(formData.get("vipWindowHours") ? { vipWindowHours: parseIntField(String(formData.get("vipWindowHours")), "Janela VIP (horas)", 1, 168) } : {}),
      ...(formData.get("audienceLimit") ? { audienceLimit: parseIntField(String(formData.get("audienceLimit")), "Limite de convidadas", 1, 500) } : {}),
      messageOverride: String(formData.get("messageOverride") ?? "").trim(),
      userId: user.id,
    });
    revalidatePath(`/admin/lancamentos/${dropId}`);
    return { success: "Lançamento salvo." };
  } catch (error) {
    return { error: toErrorMessage(error) };
  }
}

export async function setDropProductsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireOwner("lancamentos");
  try {
    const dropId = z.uuid().parse(formData.get("dropId"));
    const productIds = formData.getAll("productIds").map((value) => z.uuid().parse(value));
    await setDropProducts(getDb(), { dropId, productIds, userId: user.id });
    revalidatePath(`/admin/lancamentos/${dropId}`);
    return { success: `${productIds.length} ${productIds.length === 1 ? "peça" : "peças"} no lançamento.` };
  } catch (error) {
    return { error: toErrorMessage(error) };
  }
}

export type PreviewState = { error?: string; preview?: AudiencePreview };

export async function previewAudienceAction(_prev: PreviewState, formData: FormData): Promise<PreviewState> {
  await requireOwner("lancamentos");
  try {
    const dropId = z.uuid().parse(formData.get("dropId"));
    return { preview: await previewDropAudience(getDb(), dropId) };
  } catch (error) {
    return { error: toErrorMessage(error) };
  }
}

export async function scheduleDropAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireOwner("lancamentos");
  try {
    const dropId = z.uuid().parse(formData.get("dropId"));
    const result = await scheduleDrop(getDb(), { dropId, userId: user.id });
    revalidatePath(`/admin/lancamentos/${dropId}`);
    revalidatePath("/admin/lancamentos");
    return { success: `Agendado: ${result.invites} ${result.invites === 1 ? "convidada" : "convidadas"} recebem o convite quando a janela VIP abrir.` };
  } catch (error) {
    return { error: toErrorMessage(error) };
  }
}

export async function cancelDropAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireOwner("lancamentos");
  try {
    const dropId = z.uuid().parse(formData.get("dropId"));
    await cancelDrop(getDb(), { dropId, userId: user.id });
    revalidatePath(`/admin/lancamentos/${dropId}`);
    revalidatePath("/admin/lancamentos");
    return { success: "Lançamento cancelado. As peças deixaram de ficar escondidas." };
  } catch (error) {
    return { error: toErrorMessage(error) };
  }
}
