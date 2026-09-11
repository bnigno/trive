// Ferramenta de frete da vendedora (cotar_frete).
import type { BotToolInputs } from "@/core/bot/tools";
import { formatCentsBRL } from "@/lib/money";
import type { DbOrTx } from "@/queue/enqueue";
import { formatLookedUpAddress, lookupAddressByCep } from "@/services/address-lookup";
import { DEFAULT_ITEM_WEIGHT_GRAMS, quoteShipping } from "@/services/store-catalog";

import { cartWeightGrams } from "./cart";
import { formatDeliveryDays, loadBotState, updateBotState } from "./shared";
import type { BotExecutorContext, ToolResult } from "./shared";

export async function execCotarFrete(
  db: DbOrTx,
  ctx: BotExecutorContext,
  input: BotToolInputs["cotar_frete"],
): Promise<ToolResult> {
  const state = await loadBotState(db, ctx.conversationId);
  const cart = state.cart ?? [];

  // Com peças na sacola, o peso é real; sem sacola, cotamos com o peso
  // padrão de 1 peça e dizemos com honestidade que é estimativa.
  const isEstimate = cart.length === 0;
  const totalWeightGrams = isEstimate
    ? DEFAULT_ITEM_WEIGHT_GRAMS
    : await cartWeightGrams(db, cart);

  const quotes = await quoteShipping(db, { cep: input.cep, totalWeightGrams });
  if (quotes.length === 0) {
    return {
      ok: false,
      text: "Não entregamos para este CEP no momento. Confira se o CEP está correto, por favor.",
    };
  }

  // Endereço do CEP (melhor esforço): a cliente digita só número e
  // complemento. Vendor fora do ar não atrapalha a cotação.
  let cepAddress: { street: string; district: string; city: string; state: string } | undefined;
  if (ctx.cepLookup) {
    const found = await lookupAddressByCep(ctx.cepLookup, input.cep);
    if (found.ok) {
      const { street, district, city, state: uf } = found.address;
      cepAddress = { street, district, city, state: uf };
    }
  }

  await updateBotState(db, ctx, (current) => ({
    ...current,
    lastCep: input.cep,
    lastCepAddress: cepAddress,
    lastQuotes: quotes,
    lastQuotedAt: new Date().toISOString(),
    chosenRateId: quotes.length === 1 ? quotes[0].rateId : undefined,
  }));

  const lines = quotes.map(
    (quote, index) =>
      `${index + 1}. ${quote.name} — ${formatCentsBRL(quote.priceCents)} (${formatDeliveryDays(quote.deliveryDaysMin, quote.deliveryDaysMax)})`,
  );
  if (isEstimate) {
    lines.push("Estimativa para 1 peça — o valor final aparece no resumo do pedido.");
  }
  if (quotes.length > 1) {
    lines.push(
      "[Pergunte à cliente qual opção ela prefere e passe a escolha em criar_pedido (campo frete).]",
    );
  }
  if (cepAddress) {
    lines.push(
      `Endereço do CEP: ${formatLookedUpAddress(cepAddress)}. [Confirme com a cliente e peça SÓ número e complemento; em criar_pedido use estes rua/bairro/cidade/uf.]`,
    );
  }
  return { ok: true, text: lines.join("\n") };
}
