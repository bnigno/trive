// Reserva gentil e aviso de reposição pela vendedora.
import type { BotToolInputs } from "@/core/bot/tools";
import type { DbOrTx } from "@/queue/enqueue";
import { requestStockAlert } from "@/services/stock-alerts";
import {
  createStockHold,
  getActiveHoldByPhone,
  HoldError,
  releaseStockHold,
} from "@/services/stock-holds";

import { findVariantForBot } from "./catalog";
import { DRY_RUN_TEXT } from "./shared";
import type { BotExecutorContext, ToolResult } from "./shared";

export async function execReservarPeca(
  db: DbOrTx,
  ctx: BotExecutorContext,
  input: BotToolInputs["reservar_peca"],
): Promise<ToolResult> {
  if (ctx.dryRun) return { ok: true, text: DRY_RUN_TEXT };
  const variant = await findVariantForBot(db, input.sku);
  if (!variant) {
    return { ok: false, text: `SKU "${input.sku}" não encontrado. Use o SKU exato devolvido por detalhar_produto.` };
  }
  try {
    const hold = await createStockHold(db, {
      variantId: variant.id,
      phoneE164: ctx.phoneE164,
      customerId: ctx.customerId,
      conversationId: ctx.conversationId,
      quantity: input.quantidade ?? 1,
      createdBy: "lia",
    });
    return {
      ok: true,
      text: `Reserva feita: ${hold.description}. Diga à cliente até quando a peça fica guardada e que, passado o prazo, ela volta para a vitrine. Para fechar, siga o caminho normal (sacola → frete → pedido): o pedido converte a reserva sozinho.`,
    };
  } catch (error) {
    if (error instanceof HoldError) return { ok: false, text: error.message };
    throw error;
  }
}

export async function execLiberarReserva(db: DbOrTx, ctx: BotExecutorContext): Promise<ToolResult> {
  if (ctx.dryRun) return { ok: true, text: DRY_RUN_TEXT };
  const hold = await getActiveHoldByPhone(db, ctx.phoneE164);
  if (!hold) return { ok: true, text: "Esta cliente não tem reserva ativa no momento." };
  await releaseStockHold(db, { holdId: hold.id, reason: "released" });
  return { ok: true, text: `Reserva liberada: ${hold.description}. A peça voltou para a vitrine.` };
}

export async function execAvisarQuandoVoltar(
  db: DbOrTx,
  ctx: BotExecutorContext,
  input: BotToolInputs["avisar_quando_voltar"],
): Promise<ToolResult> {
  if (ctx.dryRun) return { ok: true, text: DRY_RUN_TEXT };
  const variant = await findVariantForBot(db, input.sku);
  if (!variant) {
    return { ok: false, text: `SKU "${input.sku}" não encontrado. Use o SKU exato devolvido por detalhar_produto.` };
  }
  const result = await requestStockAlert(db, {
    variantId: variant.id,
    phoneE164: ctx.phoneE164,
    customerId: ctx.customerId,
    conversationId: ctx.conversationId,
    source: "lia",
  });
  return {
    ok: true,
    text: result.created
      ? `Aviso registrado para ${variant.label}. Diga à cliente que ela recebe UMA mensagem quando a peça voltar — sem prometer data.`
      : `A cliente já tinha pedido aviso para ${variant.label}. Confirme que está registrado, sem prometer data.`,
  };
}
