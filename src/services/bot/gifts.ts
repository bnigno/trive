// oferecer_gentileza: a Lia pede; o servidor decide (core/coupons/lia-gift)
// e, se sim, emite o cupom pessoal e o deixa validado no caderninho. No
// ensaio (dryRun) só prevê — nenhum cupom nasce.
import { cartSubtotalCents } from "@/core/bot/memory";
import type { BotToolInputs } from "@/core/bot/tools";
import { liaGiftRefusalText, liaGiftToolText } from "@/core/coupons/lia-gift";
import type { DbOrTx } from "@/queue/enqueue";
import { getSellableVariantBySku } from "@/services/store-catalog";
import { offerLiaGift, previewLiaGift, type LiaGiftInput } from "@/services/lia-gifts";

import { readBotState, resolveConversationCustomerId, updateBotState } from "./shared";
import type { BotExecutorContext, ToolResult } from "./shared";

const dateFormatter = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit" });

export async function execOferecerGentileza(
  db: DbOrTx,
  ctx: BotExecutorContext,
  input: BotToolInputs["oferecer_gentileza"],
): Promise<ToolResult> {
  const state = await readBotState(db, ctx);
  // Uma por conversa: o caderninho já diz que ofereceu (o serviço decide o resto).
  if (state.liaGift) {
    return { ok: false, text: liaGiftRefusalText({ code: "already_offered", reason: "já ofereceu nesta conversa" }) };
  }
  const cart = state.cart ?? [];
  const items: { variantId: string; quantity: number }[] = [];
  for (const item of cart) {
    const variantId = item.variantId ?? (item.sku.trim() === "" ? null : (await getSellableVariantBySku(db, item.sku, { includeHidden: true }))?.variantId ?? null);
    if (variantId) items.push({ variantId, quantity: item.quantidade });
  }
  const now = ctx.now ?? new Date();
  const gift: LiaGiftInput = {
    conversationId: ctx.conversationId,
    customerId: await resolveConversationCustomerId(db, ctx),
    items,
    cartSubtotalCents: cartSubtotalCents(cart),
    motivo: input.motivo,
    now,
    alreadyOfferedInConversation: state.liaGift !== undefined,
    hasValidatedCoupon: state.coupon !== undefined,
    copilot: ctx.copilot === true,
    proactive: ctx.proactive === true,
  };

  if (ctx.dryRun) {
    const decision = await previewLiaGift(db, gift);
    if (!decision.ok) return { ok: false, text: liaGiftRefusalText(decision) };
    return {
      ok: true,
      text: `[Ensaio: as condições estão OK — na conversa real sairia um cupom de ${decision.percent}% válido até ${dateFormatter.format(decision.expiresAt)}. Nenhum cupom foi criado. Responda como se tivesse oferecido, chamando-o de ENSAIO-CARINHO.]`,
    };
  }

  const result = await offerLiaGift(db, gift);
  if (!result.ok) return { ok: false, text: liaGiftRefusalText({ code: result.refusal, reason: result.reason }) };

  await updateBotState(db, ctx, (current) => ({
    ...current,
    coupon: { code: result.code, discountCents: result.quote.discountCents, at: now.toISOString() },
    liaGift: { code: result.code, motivo: input.motivo, at: now.toISOString(), expiresAt: result.expiresAt.toISOString() },
  }));
  return {
    ok: true,
    text: liaGiftToolText({
      code: result.code,
      percent: result.percent,
      discountCents: result.quote.discountCents,
      subtotalCents: gift.cartSubtotalCents,
      expiresAt: result.expiresAt,
      motivo: input.motivo,
    }),
  };
}
