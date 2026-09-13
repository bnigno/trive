"use server";
// Edições de Belém no painel: criar, editar, capa, peças, ativar/desativar e
// "Usar nos cartões e posts" (grava o setting edition_name — a fonte MANUAL
// do eyebrow dos cartões continua sendo o setting; a entidade manda em
// home, coleção, /belem e Lia). Zod na fronteira, um service por action.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { getFileStorage } from "@/adapters/storage";
import { getDb } from "@/db/client";
import { requireOwner } from "@/services/auth";
import {
  COVER_MAX_BYTES,
  createCityEdition,
  ServiceError,
  setCityEditionCover,
  setCityEditionProducts,
  updateCityEdition,
  type CityEditionFields,
} from "@/services/city-editions";
import { updateSetting } from "@/services/settings";

export type FormState = { error?: string; success?: string };

function toErrorMessage(error: unknown): string {
  if (error instanceof ServiceError) return error.message;
  if (error instanceof z.ZodError) return error.issues[0]?.message ?? "Dados inválidos. Confira os campos.";
  return "Algo deu errado, tente novamente.";
}

function revalidateEdition(editionId?: string): void {
  revalidatePath("/admin/edicoes");
  if (editionId) revalidatePath(`/admin/edicoes/${editionId}`);
  // A vitrine é estática (ISR): home, coleção, /belem e sitemap mudam com a edição.
  revalidatePath("/", "layout");
}

const text = (formData: FormData, key: string) => String(formData.get(key) ?? "").trim();
const optionalText = (formData: FormData, key: string) => text(formData, key) || null;
const optionalInt = (formData: FormData, key: string) => {
  const raw = text(formData, key);
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new ServiceError("numero_invalido", "Hora inválida: use um número inteiro.");
  return value;
};

function fieldsFromForm(formData: FormData): CityEditionFields {
  return {
    name: text(formData, "name"),
    slug: text(formData, "slug") || undefined,
    openingLine: optionalText(formData, "openingLine"),
    body: optionalText(formData, "body"),
    districts: optionalText(formData, "districts"),
    startsOn: optionalText(formData, "startsOn"),
    endsOn: optionalText(formData, "endsOn"),
    hourStart: optionalInt(formData, "hourStart"),
    hourEnd: optionalInt(formData, "hourEnd"),
    sortOrder: optionalInt(formData, "sortOrder") ?? undefined,
  };
}

export async function createCityEditionAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireOwner("edicoes");
  let editionId: string;
  try {
    const result = await createCityEdition(getDb(), { fields: fieldsFromForm(formData), userId: user.id });
    editionId = result.editionId;
  } catch (error) {
    return { error: toErrorMessage(error) };
  }
  revalidateEdition(editionId);
  redirect(`/admin/edicoes/${editionId}`);
}

export async function updateCityEditionAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireOwner("edicoes");
  try {
    const editionId = z.uuid().parse(formData.get("editionId"));
    const active = formData.get("isActive");
    await updateCityEdition(getDb(), {
      editionId,
      fields: fieldsFromForm(formData),
      isActive: active === null ? undefined : active === "on" || active === "true",
      userId: user.id,
    });
    revalidateEdition(editionId);
    return { success: "Edição salva." };
  } catch (error) {
    return { error: toErrorMessage(error) };
  }
}

export async function setCityEditionProductsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireOwner("edicoes");
  try {
    const editionId = z.uuid().parse(formData.get("editionId"));
    const productIds = formData.getAll("productIds").map((value) => z.uuid().parse(value));
    await setCityEditionProducts(getDb(), { editionId, productIds, userId: user.id });
    revalidateEdition(editionId);
    return { success: `${productIds.length} ${productIds.length === 1 ? "peça" : "peças"} na edição.` };
  } catch (error) {
    return { error: toErrorMessage(error) };
  }
}

export async function uploadCityEditionCoverAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireOwner("edicoes");
  try {
    const editionId = z.uuid().parse(formData.get("editionId"));
    const file = formData.get("cover");
    if (!(file instanceof File) || file.size === 0) return { error: "Escolha uma imagem para a capa." };
    if (file.size > COVER_MAX_BYTES) return { error: "A capa passou de 8 MB. Reduza a foto e tente de novo." };
    await setCityEditionCover(getDb(), getFileStorage(), { editionId, data: new Uint8Array(await file.arrayBuffer()), userId: user.id });
    revalidateEdition(editionId);
    return { success: "Capa atualizada." };
  } catch (error) {
    return { error: toErrorMessage(error) };
  }
}

/** Grava o nome da edição no setting que os cartões e posts leem (dispara o redesenho). */
export async function useEditionOnCardsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireOwner("edicoes");
  try {
    const name = z.string().trim().min(1).max(40, "O nome dos cartões tem no máximo 40 caracteres — encurte o nome da edição.").parse(formData.get("name"));
    await updateSetting(getDb(), { key: "edition_name", value: name, userId: user.id });
    revalidateEdition(String(formData.get("editionId") ?? "") || undefined);
    return { success: `Cartões e posts agora saem com “${name}”. As imagens são redesenhadas em segundo plano.` };
  } catch (error) {
    return { error: toErrorMessage(error) };
  }
}
