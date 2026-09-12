// Handler de order.edition_cards: desenha a carta de estreia (se couber) e os
// cartões da edição assim que o pedido é pago, para a mesa de embalagem já
// encontrá-los prontos. Dependências injetadas para ser testável fora do Next.

import { z } from "zod";

import type { FileStorage } from "@/adapters/storage";
import type { DbOrTx } from "@/queue/enqueue";
import { publishEditionCards, ServiceError, type EditionRenderers } from "@/services/edition-cards";

export const orderEditionCardsPayloadSchema = z.object({ orderId: z.uuid() });

export type OrderEditionCardsDeps = {
  db: DbOrTx;
  storage: FileStorage;
  render: EditionRenderers;
};

export type OrderEditionCardsResult =
  | { skipped: string }
  | { skipped: null; cards: number; letter: boolean };

/** O que é "nada a desenhar" (concluído, sem retry) — o resto propaga. */
const SKIP_CODES = new Set(["pedido_nao_encontrado", "pedido_sem_pecas"]);

/**
 * Pedido sumido ou sem peças de roupa é "nada a desenhar" (concluído, não
 * retry). Falha do desenho (cartao_falhou ou erro cru) propaga: a política
 * do evento tenta de novo uma vez e a dona sempre pode gerar na tela.
 */
export async function runOrderEditionCards(
  deps: OrderEditionCardsDeps,
  event: { id: string; eventType: string; payload: Record<string, unknown> },
): Promise<OrderEditionCardsResult> {
  const { orderId } = orderEditionCardsPayloadSchema.parse(event.payload);
  try {
    const result = await publishEditionCards(deps.db, deps.storage, deps.render, { orderId });
    console.info(
      `[${event.eventType}] ${orderId} → ${result.cards.length} cartão(ões)${result.letterPath ? " + carta de estreia" : ""}`,
    );
    return { skipped: null, cards: result.cards.length, letter: result.letterPath !== null };
  } catch (error) {
    if (error instanceof ServiceError && SKIP_CODES.has(error.code)) {
      console.info(`[${event.eventType}] ${orderId} → skipped: ${error.code}`);
      return { skipped: error.code };
    }
    throw error;
  }
}
