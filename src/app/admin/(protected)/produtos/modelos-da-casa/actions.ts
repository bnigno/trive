"use server";
// Modelos da casa: pedir candidatas de foto-base (pela fila), escolher e
// descartar — Zod na fronteira, um service, revalidação.
import { revalidatePath } from "next/cache";
import { z, ZodError } from "zod";

import { BODY_SIZE_KEYS, HOUSE_MODEL_KEYS, SCENE_KEYS } from "@/core/studio/presets";
import { getDb } from "@/db/client";
import { requireOwner } from "@/services/auth";
import { chooseStudioBasePhoto, discardStudioBasePhoto, enqueueStudioBasePhotos, ServiceError } from "@/services/studio";

export type BaseFormState = { error?: string; success?: string };

const PAGE = "/admin/produtos/modelos-da-casa";
/** Duas candidatas por pedido: dá escolha sem dobrar a conta. */
const CANDIDATES_PER_REQUEST = 2;

const keysSchema = z.object({
  modelKey: z.enum(HOUSE_MODEL_KEYS, { error: "Modelo desconhecido." }),
  sceneKey: z.enum(SCENE_KEYS, { error: "Cena desconhecida." }),
  sizeKey: z.enum(BODY_SIZE_KEYS, { error: "Corpo desconhecido." }),
});

function toError(error: unknown): BaseFormState {
  if (error instanceof ServiceError) return { error: error.message };
  if (error instanceof ZodError) return { error: error.issues[0]?.message ?? "Dados inválidos." };
  return { error: "Algo deu errado, tente novamente." };
}

export async function requestBasePhotosAction(_prev: BaseFormState, formData: FormData): Promise<BaseFormState> {
  const user = await requireOwner("produtos");
  try {
    const keys = keysSchema.parse({ modelKey: formData.get("modelKey"), sceneKey: formData.get("sceneKey"), sizeKey: formData.get("sizeKey") });
    const eventId = await enqueueStudioBasePhotos(getDb(), { ...keys, quality: "alta", count: CANDIDATES_PER_REQUEST, userId: user.id });
    revalidatePath(PAGE);
    if (!eventId) return { error: "Este pedido já estava na fila." };
    return { success: "Na fila — as candidatas aparecem em cerca de um minuto. Recarregue a página." };
  } catch (error) {
    return toError(error);
  }
}

const idSchema = z.object({ id: z.uuid("Foto-base inválida. Recarregue a página.") });

export async function chooseBasePhotoAction(_prev: BaseFormState, formData: FormData): Promise<BaseFormState> {
  const user = await requireOwner("produtos");
  try {
    const { id } = idSchema.parse({ id: formData.get("id") });
    await chooseStudioBasePhoto(getDb(), { id, userId: user.id });
    revalidatePath(PAGE);
    return { success: "Escolhida." };
  } catch (error) {
    return toError(error);
  }
}

export async function discardBasePhotoAction(_prev: BaseFormState, formData: FormData): Promise<BaseFormState> {
  const user = await requireOwner("produtos");
  try {
    const { id } = idSchema.parse({ id: formData.get("id") });
    await discardStudioBasePhoto(getDb(), { id, userId: user.id });
    revalidatePath(PAGE);
    return { success: "Descartada." };
  } catch (error) {
    return toError(error);
  }
}
