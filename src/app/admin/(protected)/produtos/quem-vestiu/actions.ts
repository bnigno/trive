"use server";
// Quem já vestiu: aprovar, recusar e retirar — Zod na fronteira, um service, revalidação.
import { revalidatePath } from "next/cache";
import { z, ZodError } from "zod";

import { getDb } from "@/db/client";
import { requireOwner } from "@/services/auth";
import { approveCustomerLook, rejectCustomerLook, revokeCustomerLook } from "@/services/customer-looks";

export type LookFormState = { error?: string; success?: string };

const lookSchema = z.object({ lookId: z.uuid(), productSlug: z.string().min(1).optional() });

function revalidate(productSlug?: string): void {
  revalidatePath("/admin/produtos/quem-vestiu");
  revalidatePath("/admin");
  if (productSlug) revalidatePath(`/produto/${productSlug}`);
}

export async function approveLookAction(_prev: LookFormState, formData: FormData): Promise<LookFormState> {
  const user = await requireOwner("produtos");
  try {
    const { lookId, productSlug } = lookSchema.parse({ lookId: formData.get("lookId"), productSlug: formData.get("productSlug") ?? undefined });
    const result = await approveCustomerLook(getDb(), { lookId, userId: user.id });
    revalidate(productSlug);
    if (!result.approved) return { error: "Não deu para aprovar: a cliente ainda não autorizou, já foi decidido ou a foto foi retirada." };
    return { success: "Na vitrine." };
  } catch (error) {
    if (error instanceof ZodError) return { error: "Foto inválida. Recarregue a página." };
    return { error: error instanceof Error ? error.message : "Algo deu errado, tente novamente." };
  }
}

export async function rejectLookAction(_prev: LookFormState, formData: FormData): Promise<LookFormState> {
  const user = await requireOwner("produtos");
  try {
    const { lookId, productSlug } = lookSchema.parse({ lookId: formData.get("lookId"), productSlug: formData.get("productSlug") ?? undefined });
    const result = await rejectCustomerLook(getDb(), { lookId, userId: user.id });
    revalidate(productSlug);
    if (!result.rejected) return { error: "Não deu para recusar: já foi decidido ou a foto foi retirada." };
    return { success: "Recusada — fica só com ela." };
  } catch (error) {
    if (error instanceof ZodError) return { error: "Foto inválida. Recarregue a página." };
    return { error: error instanceof Error ? error.message : "Algo deu errado, tente novamente." };
  }
}

export async function revokeLookAction(_prev: LookFormState, formData: FormData): Promise<LookFormState> {
  const user = await requireOwner("produtos");
  try {
    const { lookId, productSlug } = lookSchema.parse({ lookId: formData.get("lookId"), productSlug: formData.get("productSlug") ?? undefined });
    const result = await revokeCustomerLook(getDb(), { lookId, userId: user.id, source: "owner" });
    revalidate(productSlug);
    if (!result.revoked) return { error: "Esta foto já tinha sido retirada." };
    return { success: "Retirada da vitrine." };
  } catch (error) {
    if (error instanceof ZodError) return { error: "Foto inválida. Recarregue a página." };
    return { error: error instanceof Error ? error.message : "Algo deu errado, tente novamente." };
  }
}
