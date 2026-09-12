"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { getDb } from "@/db/client";
import { requireOwner } from "@/services/auth";
import { createCampaignLink, updateCampaignLink } from "@/services/campaign-links";

export type FormState = { error?: string; success?: string };

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.name === "ServiceError") return error.message;
  if (error instanceof z.ZodError) {
    return error.issues[0]?.message ?? "Dados inválidos. Confira os campos.";
  }
  return "Algo deu errado, tente novamente.";
}

const createSchema = z.object({
  slug: z.string().trim().min(1, "Escolha o nome do link.").max(80),
  label: z.string().trim().min(1, "Dê um rótulo ao link.").max(60),
  productId: z.union([z.literal(""), z.uuid()]),
});

export async function createCampaignLinkAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireOwner("whatsapp");
  try {
    const parsed = createSchema.parse({
      slug: formData.get("slug") ?? "",
      label: formData.get("label") ?? "",
      productId: formData.get("productId") ?? "",
    });
    const link = await createCampaignLink(getDb(), {
      slug: parsed.slug,
      label: parsed.label,
      productId: parsed.productId || null,
      userId: user.id,
    });
    revalidatePath("/admin/whatsapp/links");
    revalidatePath("/admin/whatsapp");
    return { success: `Link "${link.slug}" criado. Copie a URL e cole no sticker do story.` };
  } catch (error) {
    return { error: toErrorMessage(error) };
  }
}

const toggleSchema = z.object({
  id: z.uuid(),
  nextActive: z.enum(["true", "false"]),
});

export async function toggleCampaignLinkAction(formData: FormData): Promise<void> {
  const user = await requireOwner("whatsapp");
  const parsed = toggleSchema.parse({
    id: formData.get("id"),
    nextActive: formData.get("nextActive"),
  });
  await updateCampaignLink(getDb(), { id: parsed.id, isActive: parsed.nextActive === "true", userId: user.id });
  revalidatePath("/admin/whatsapp/links");
  revalidatePath("/admin/whatsapp");
}

const updateSchema = z.object({
  id: z.uuid(),
  label: z.string().trim().min(1, "Dê um rótulo ao link.").max(60),
  productId: z.union([z.literal(""), z.uuid()]),
});

export async function updateCampaignLinkAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireOwner("whatsapp");
  try {
    const parsed = updateSchema.parse({
      id: formData.get("id"),
      label: formData.get("label") ?? "",
      productId: formData.get("productId") ?? "",
    });
    await updateCampaignLink(getDb(), {
      id: parsed.id,
      label: parsed.label,
      productId: parsed.productId || null,
      userId: user.id,
    });
    revalidatePath("/admin/whatsapp/links");
    return { success: "Link atualizado." };
  } catch (error) {
    return { error: toErrorMessage(error) };
  }
}
