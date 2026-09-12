"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { getFileStorage } from "@/adapters/storage";
import { getDb } from "@/db/client";
import { loadReceiptAssets } from "@/receipts/assets";
import { renderEditionCardPng } from "@/receipts/render-edition-card";
import { requireUser } from "@/services/auth";
import { publishEditionCards, ServiceError } from "@/services/edition-cards";

export type CardsFormState = { error?: string; success?: string };

/**
 * Desenha e publica os cartões da edição do pedido (um por peça). Roda na
 * action porque é a dona esperando na mesa de embalagem — sem fila.
 */
export async function generateEditionCardsAction(
  _prev: CardsFormState,
  formData: FormData,
): Promise<CardsFormState> {
  await requireUser();
  const parsed = z.uuid().safeParse(formData.get("orderId"));
  if (!parsed.success) return { error: "Pedido inválido." };
  try {
    const assets = await loadReceiptAssets();
    const result = await publishEditionCards(
      getDb(),
      getFileStorage(),
      (data) => renderEditionCardPng(data, assets),
      { orderId: parsed.data },
    );
    revalidatePath(`/admin/pedidos/${parsed.data}/cartoes`);
    revalidatePath(`/admin/pedidos/${parsed.data}`);
    revalidatePath("/admin/pedidos/embalar");
    const n = result.cards.length;
    return { success: n === 1 ? "Cartão pronto para imprimir." : `${n} cartões prontos para imprimir.` };
  } catch (error) {
    if (error instanceof ServiceError) return { error: error.message };
    console.error("[edition-cards] falha ao gerar", error);
    return { error: "Não consegui desenhar os cartões agora. Tente de novo em instantes." };
  }
}
