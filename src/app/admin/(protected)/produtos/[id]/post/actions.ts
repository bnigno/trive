"use server";

import { revalidatePath } from "next/cache";
import { z, ZodError } from "zod";

import { getFileStorage } from "@/adapters/storage";
import { renderCardPng } from "@/cards/render";
import { getDb } from "@/db/client";
import { loadReceiptAssets } from "@/receipts/assets";
import { requireUser } from "@/services/auth";
import { publishProductPost } from "@/services/product-posts";
import { ServiceError } from "@/services/settings";

export type PostFormState = { error?: string; success?: string };

/**
 * Desenha o post e o story da peça (ou devolve os do cache). Roda na action
 * porque é a dona esperando na tela — sem fila, com o cache como rede.
 */
export async function generateProductPostAction(
  _prev: PostFormState,
  productId: string,
): Promise<PostFormState> {
  const user = await requireUser();
  try {
    const id = z.uuid().parse(productId);
    const assets = await loadReceiptAssets();
    await publishProductPost(
      getDb(),
      getFileStorage(),
      (data) => renderCardPng(data, assets),
      { productId: id, userId: user.id },
    );
    revalidatePath(`/admin/produtos/${id}/post`);
    // A prévia do link da peça passa a ser o cartão recém-desenhado.
    revalidatePath("/produto/[slug]", "page");
    return { success: "Post e story prontos." };
  } catch (error) {
    if (error instanceof ServiceError) return { error: error.message };
    if (error instanceof ZodError) return { error: "Peça inválida." };
    return { error: "Não consegui desenhar o post agora. Tente de novo." };
  }
}
