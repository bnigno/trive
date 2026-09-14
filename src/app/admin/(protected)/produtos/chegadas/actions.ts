"use server";
// Chegadas pelo WhatsApp: "Refazer" — Zod na fronteira, um service, revalidação.
import { revalidatePath } from "next/cache";
import { z, ZodError } from "zod";

import { getDb } from "@/db/client";
import { redoAtelierIntake } from "@/services/atelier";
import { requireOwner } from "@/services/auth";

export type RedoFormState = { error?: string; success?: string };

const REASON_LABELS: Record<string, string> = {
  chegada_inexistente: "Esta chegada não existe mais.",
  em_andamento: "Esta chegada ainda está sendo montada — espere um minuto.",
  estoque_lancado: "Esta chegada já lançou estoque: ajuste pelo painel.",
};

const redoSchema = z.object({ intakeId: z.uuid() });

export async function redoAtelierIntakeAction(_prev: RedoFormState, formData: FormData): Promise<RedoFormState> {
  const user = await requireOwner("produtos");
  try {
    const { intakeId } = redoSchema.parse({ intakeId: formData.get("intakeId") });
    const result = await redoAtelierIntake(getDb(), { intakeId, userId: user.id });
    revalidatePath("/admin/produtos/chegadas");
    revalidatePath("/admin/produtos");
    revalidatePath("/admin");
    if (!result.ok) return { error: REASON_LABELS[result.reason] ?? "Não deu para refazer." };
    return {
      success: `Voltou para a fila${result.archivedProductId ? "; o rascunho antigo foi arquivado" : ""}${result.canceledEntryId ? " e a conta a pagar, cancelada" : ""}. Em ~1 minuto chega o novo “Rascunho pronto”.`,
    };
  } catch (error) {
    if (error instanceof ZodError) return { error: "Chegada inválida. Recarregue a página." };
    return { error: error instanceof Error ? error.message : "Algo deu errado, tente novamente." };
  }
}
