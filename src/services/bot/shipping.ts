// Ferramenta de frete da vendedora (cotar_frete).
import { formatQuoteLines } from "@/core/bot/shipping";
import { quoteKey, type BotQuote } from "@/core/bot/memory";
import type { DeliveryOption } from "@/core/shipping/delivery-windows";
import { assessNeededBy } from "@/core/shipping/needed-by";
import { isValidNeededBy } from "@/core/shipping/needed-by";
import { spDayKey } from "@/lib/sp-day";
import type { BotToolInputs } from "@/core/bot/tools";
import type { DbOrTx } from "@/queue/enqueue";
import { formatLookedUpAddress, lookupAddressByCep } from "@/services/address-lookup";
import { DEFAULT_ITEM_WEIGHT_GRAMS, quoteDeliveryOptions } from "@/services/store-catalog";

import { cartWeightGrams } from "./cart";
import { readBotState, updateBotState } from "./shared";
import type { BotExecutorContext, ToolResult } from "./shared";

export async function execCotarFrete(
  db: DbOrTx,
  ctx: BotExecutorContext,
  input: BotToolInputs["cotar_frete"],
): Promise<ToolResult> {
  const state = await readBotState(db, ctx);
  const cart = state.cart ?? [];

  // Com peças na sacola, o peso é real; sem sacola, cotamos com o peso
  // padrão de 1 peça e dizemos com honestidade que é estimativa.
  const isEstimate = cart.length === 0;
  const totalWeightGrams = isEstimate
    ? DEFAULT_ITEM_WEIGHT_GRAMS
    : await cartWeightGrams(db, cart);

  const now = ctx.now ?? new Date();
  const todayKey = spDayKey(now);
  // A data desta chamada; sem ela, a do caderninho continua valendo enquanto não passou.
  const stateNeededBy = state.neededBy && isValidNeededBy(state.neededBy, todayKey) ? state.neededBy : undefined;
  const neededBy = input.entregar_ate && isValidNeededBy(input.entregar_ate, todayKey) ? input.entregar_ate : stateNeededBy;
  const occasion = input.ocasiao?.trim() || (neededBy === state.neededBy ? state.occasion : undefined);
  const options = await quoteDeliveryOptions(db, { cep: input.cep, totalWeightGrams, now });
  const quotes = options.map((option) => toBotQuote(option, neededBy, now));
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
    lastQuotedAt: now.toISOString(),
    // Uma opção só já é a escolha (as duas chaves: leitores antigos olham chosenRateId).
    chosenRateId: quotes.length === 1 ? quotes[0].rateId : undefined,
    chosenOptionKey: quotes.length === 1 ? quoteKey(quotes[0]) : undefined,
    neededBy,
    occasion: neededBy ? occasion : undefined,
  }));

  const lines = formatQuoteLines(quotes);
  if (input.entregar_ate && !neededBy) {
    lines.push("[A data entregar_ate veio no passado ou inválida e foi ignorada: confirme com a cliente até que dia ela precisa.]");
  }
  if (quotes.some((quote) => quote.kind === "motoboy")) {
    lines.push("[Motoboy: cada linha é uma janela de horário; 'pague até' é a hora-limite do pagamento para sair naquela janela. A cliente escolhe a janela; passe-a em criar_pedido (campo frete, pelo número ou pelo texto).]");
  }
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

/** A opção da vitrine como a Lia a guarda no caderninho (com "chega dia…" quando há data marcada). */
export function toBotQuote(option: DeliveryOption, neededBy: string | undefined, now: Date): BotQuote {
  const arrival = neededBy
    ? assessNeededBy(
        option.kind === "motoboy" ? { kind: "motoboy", dayKey: option.window.dayKey } : { kind: "correios", deliveryDaysMax: option.deliveryDaysMax },
        neededBy,
        now,
      ).label
    : undefined;
  if (option.kind === "motoboy") {
    return {
      rateId: option.rateId,
      name: option.name,
      priceCents: option.priceCents,
      deliveryDaysMin: 0,
      deliveryDaysMax: 0,
      optionKey: option.optionKey,
      kind: "motoboy",
      label: option.label,
      window: option.window,
      ...(arrival ? { arrival } : {}),
    };
  }
  return {
    rateId: option.rateId,
    name: option.name,
    priceCents: option.priceCents,
    deliveryDaysMin: option.deliveryDaysMin,
    deliveryDaysMax: option.deliveryDaysMax,
    optionKey: option.optionKey,
    kind: "correios",
    ...(arrival ? { arrival } : {}),
  };
}
