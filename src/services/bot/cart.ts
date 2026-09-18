// Ferramentas da sacola da vendedora.
import { cartAdd, cartRemoveAt, cartSubtotalCents, findCartItem, formatCartLines, mergeCartByVariant, type BotCartItem, type BotState } from "@/core/bot/memory";
import type { BotToolInputs } from "@/core/bot/tools";
import { variantLabel } from "@/core/catalog/attributes";
import { formatCentsBRL } from "@/lib/money";
import type { DbOrTx } from "@/queue/enqueue";
import { quoteCoupon, ServiceError as CouponServiceError } from "@/services/coupons";
import { computeTotalWeightGrams, getSellableVariantById, getSellableVariantBySku } from "@/services/store-catalog";

import { availableQtyOf, resolveVariantBySku } from "./catalog";
import { readBotState, updateBotState } from "./shared";
import type { BotExecutorContext, ToolResult } from "./shared";

/**
 * A sacola mudou: o cupom validado é refeito sobre o subtotal novo (o
 * caderninho mostra o desconto certo) ou esquecido, com o motivo — nunca um
 * desconto velho até o fechamento.
 */
async function refreshCoupon(
  db: DbOrTx,
  state: BotState,
): Promise<{ coupon: BotState["coupon"]; note: string | null }> {
  if (!state.coupon) return { coupon: undefined, note: null };
  const code = state.coupon.code;
  const cart = state.cart ?? [];
  if (cart.length === 0) {
    return {
      coupon: undefined,
      note: `[O cupom ${code} validado antes foi esquecido: a sacola ficou vazia. Valide de novo quando houver peças.]`,
    };
  }
  try {
    const quote = await quoteCoupon(db, { code, subtotalCents: cartSubtotalCents(cart) });
    return {
      coupon: { code: quote.code, discountCents: quote.discountCents, at: new Date().toISOString() },
      note: `[Cupom ${quote.code} continua válido: desconto de ${formatCentsBRL(quote.discountCents)} nesta sacola.]`,
    };
  } catch (error) {
    if (error instanceof CouponServiceError) {
      return {
        coupon: undefined,
        note: `[O cupom ${code} deixou de valer para esta sacola: ${error.message} Esqueci o cupom — avise a cliente se ela contava com ele.]`,
      };
    }
    throw error;
  }
}

/** Aplica a mudança na sacola e acerta o cupom validado (se houver) para a sacola nova. */
async function changeCart(
  db: DbOrTx,
  ctx: BotExecutorContext,
  change: (current: BotState) => BotState,
): Promise<{ state: BotState; couponNote: string | null }> {
  const changed = await updateBotState(db, ctx, change);
  if (!changed.coupon) return { state: changed, couponNote: null };
  const refreshed = await refreshCoupon(db, changed);
  const state = await updateBotState(db, ctx, (current) => ({ ...current, coupon: refreshed.coupon }));
  return { state, couponNote: refreshed.note };
}

export async function execAdicionarASacola(
  db: DbOrTx,
  ctx: BotExecutorContext,
  input: BotToolInputs["adicionar_a_sacola"],
): Promise<ToolResult> {
  const variant = await resolveVariantBySku(db, input.sku);
  if (!variant) {
    return {
      ok: false,
      text: `Não encontrei o SKU "${input.sku}" no catálogo. Confirme a peça com detalhar_produto antes de pôr na sacola.`,
    };
  }
  const axes = (variant.attributesSchema ?? []) as string[];
  const variacao = variantLabel(
    (variant.attributes ?? {}) as Record<string, string>,
    axes,
  );
  const rotulo = variacao ? `${variant.name} (${variacao})` : variant.name;

  // Quantidade é o TOTAL da linha (nunca soma): repetir a chamada no turno
  // do "SIM" não pode dobrar a peça. Já está igual → nada muda, e a cotação
  // de frete e o cupom ficam como estão.
  const before = await readBotState(db, ctx);
  const existente = (before.cart ?? []).find((item) => item.sku.toLowerCase() === variant.sku.toLowerCase()) ?? null;
  const quantidade = input.quantidade ?? existente?.quantidade ?? 1;
  if (existente && existente.quantidade === quantidade && existente.variantId === variant.variantId) {
    return {
      ok: true,
      text: [
        `[Já estava na sacola: ${existente.quantidade}× ${rotulo} — nada mudou. Para outra quantidade, passe o TOTAL em quantidade; para tirar, remover_da_sacola.]`,
        ...formatCartLines(before.cart),
      ].join("\n"),
    };
  }
  const available = await availableQtyOf(db, variant.variantId);
  if (available < quantidade) {
    return {
      ok: false,
      text:
        available === 0
          ? `${rotulo} está esgotada agora. Ofereça outra cor ou tamanho disponível (detalhar_produto) ou avisar_quando_voltar com este SKU.`
          : `${rotulo} tem só ${available} ${available === 1 ? "unidade" : "unidades"} disponível — pedi ${quantidade}. Ajuste a quantidade com a cliente.`,
    };
  }

  const added = cartAdd(before.cart, {
    sku: variant.sku,
    variantId: variant.variantId,
    quantidade,
    nome: variant.name,
    variacao,
    precoCents: variant.priceCents,
  });
  const { state, couponNote } = await changeCart(db, ctx, (current) => ({
    ...current,
    cart: added.cart,
    // Sacola mudou: a cotação anterior valia para outro peso.
    lastQuotes: undefined,
    chosenRateId: undefined,
    chosenOptionKey: undefined,
  }));
  return {
    ok: true,
    text: [
      existente
        ? `Ajustei ${rotulo} de ${existente.quantidade}× para ${quantidade}× (quantidade = total na sacola).`
        : `Adicionei ${quantidade}× ${rotulo} à sacola.`,
      ...formatCartLines(state.cart),
      ...(couponNote ? [couponNote] : []),
      "[Se a sacola tiver tudo, siga para o CEP e cotar_frete. Sugira UMA peça que completa o look só depois do pedido fechado.]",
    ].join("\n"),
  };
}

/**
 * Como a variante da linha está no catálogo HOJE: `sellable` quando ativa
 * (com o SKU/nome/preço atuais), `gone` quando não existe mais, foi
 * desativada ou não tem preço.
 */
type CartLineStatus = { item: BotCartItem; healed: BotCartItem | null; gone: boolean };

/**
 * Confere cada linha da sacola com o catálogo: por variantId (o SKU é
 * rótulo editável — a dona renomeia a peça e a linha ficaria órfã), senão
 * pelo SKU. Linha que resolve com SKU/nome/preço diferentes é CURADA; linha
 * que não resolve é marcada para a Lia tirar pelo nome. Grava só se algo
 * mudou. A cura junta linha velha e nova da mesma variante.
 */
export async function reconcileCartLines(
  db: DbOrTx,
  ctx: BotExecutorContext,
): Promise<{ cart: BotCartItem[]; notes: string[]; gone: BotCartItem[] }> {
  const state = await readBotState(db, ctx);
  const statuses: CartLineStatus[] = [];
  for (const item of state.cart ?? []) {
    const byId = item.variantId ? await getSellableVariantById(db, item.variantId) : null;
    const variant = byId ?? (await getSellableVariantBySku(db, item.sku, { includeHidden: true }));
    if (!variant) {
      statuses.push({ item, healed: null, gone: true });
      continue;
    }
    const variacao = variantLabel(variant.attributes, variant.attributesSchema);
    const fresh: BotCartItem = { ...item, sku: variant.sku, variantId: variant.variantId, nome: variant.name, variacao, precoCents: variant.priceCents };
    const changed = fresh.sku !== item.sku || fresh.variantId !== item.variantId || fresh.nome !== item.nome || fresh.variacao !== item.variacao || fresh.precoCents !== item.precoCents;
    statuses.push({ item, healed: changed ? fresh : null, gone: false });
  }
  const notes = statuses
    .filter((line) => line.healed && line.healed.sku !== line.item.sku)
    .map((line) => `[Linha atualizada: o SKU de "${line.item.nome}" mudou de ${line.item.sku} para ${line.healed!.sku}.]`);
  const merged = mergeCartByVariant(statuses.map((line) => line.healed ?? line.item));
  const changed = statuses.some((line) => line.healed) || merged.length !== (state.cart ?? []).length;
  const cart = changed
    ? (await updateBotState(db, ctx, (current) => ({ ...current, cart: merged }))).cart ?? merged
    : merged;
  return { cart, notes, gone: statuses.filter((line) => line.gone).map((line) => line.item) };
}

function goneLines(gone: readonly BotCartItem[]): string[] {
  return gone.map(
    (item) => `[A linha "${item.variacao ? `${item.nome} (${item.variacao})` : item.nome}" não está mais à venda (peça desativada ou fora do catálogo): tire da sacola com remover_da_sacola usando esse nome, e ofereça outra.]`,
  );
}

export async function execVerSacola(
  db: DbOrTx,
  ctx: BotExecutorContext,
): Promise<ToolResult> {
  const { cart, notes, gone } = await reconcileCartLines(db, ctx);
  return { ok: true, text: [...formatCartLines(cart), ...notes, ...goneLines(gone)].join("\n") };
}

export async function execRemoverDaSacola(
  db: DbOrTx,
  ctx: BotExecutorContext,
  input: BotToolInputs["remover_da_sacola"],
): Promise<ToolResult> {
  const before = await readBotState(db, ctx);
  const cart = before.cart ?? [];
  let match = findCartItem(cart, input.sku);
  // A Lia tem o SKU atual (detalhar_produto) e a sacola guarda o velho: a variante decide.
  if (match === null) {
    const variant = await resolveVariantBySku(db, input.sku);
    const index = variant ? cart.findIndex((item) => item.variantId === variant.variantId) : -1;
    if (index >= 0) match = { item: cart[index], index };
  }
  if (match === null) {
    return {
      ok: false,
      text: `Nada na sacola casa com "${input.sku}". Use o [sku: …] ou o nome como está na sacola:\n${formatCartLines(cart).join("\n")}`,
    };
  }
  if ("ambiguous" in match) {
    return {
      ok: false,
      text: `"${input.sku}" serve para mais de uma linha — passe o [sku: …] da que a cliente quer tirar:\n${formatCartLines(match.ambiguous).join("\n")}`,
    };
  }
  const { index, item } = match;
  const { state, couponNote } = await changeCart(db, ctx, (current) => ({
    ...current,
    cart: cartRemoveAt(current.cart, index),
    lastQuotes: undefined,
    chosenRateId: undefined,
    chosenOptionKey: undefined,
  }));
  return {
    ok: true,
    text: [`Tirei ${item.quantidade}× ${item.variacao ? `${item.nome} (${item.variacao})` : item.nome} da sacola.`, ...formatCartLines(state.cart), ...(couponNote ? [couponNote] : [])].join("\n"),
  };
}

/** Peso da sacola pela variante (o SKU da linha pode ter mudado); linha que não resolve entra com o peso padrão. */
export async function cartWeightGrams(db: DbOrTx, cart: readonly BotCartItem[]): Promise<number> {
  const lines: { weightGrams: number | null; quantity: number }[] = [];
  for (const item of cart) {
    const variant = (item.variantId ? await getSellableVariantById(db, item.variantId) : null) ?? (await getSellableVariantBySku(db, item.sku, { includeHidden: true }));
    lines.push({ weightGrams: variant?.weightGrams ?? null, quantity: item.quantidade });
  }
  return computeTotalWeightGrams(lines);
}

/**
 * validar_cupom: o desconto REAL sobre a sacola desta conversa, sem consumir
 * o cupom (quem consome é criar_pedido, na transação do pedido). Válido vai
 * para o caderninho; criar_pedido aplica quando o campo cupom vier ausente.
 * No ensaio (dryRun) vale com a sacola do turno (overlay) e nada é gravado.
 */
export async function execValidarCupom(
  db: DbOrTx,
  ctx: BotExecutorContext,
  input: BotToolInputs["validar_cupom"],
): Promise<ToolResult> {
  const state = await readBotState(db, ctx);
  const cart = state.cart ?? [];
  if (cart.length === 0) {
    return {
      ok: false,
      text: "A sacola está vazia — o desconto é calculado sobre as peças da sacola. Confirme as peças com adicionar_a_sacola e valide o cupom de novo.",
    };
  }
  const subtotalCents = cartSubtotalCents(cart);
  const codigo = input.cupom.trim().toUpperCase();
  let quote;
  try {
    quote = await quoteCoupon(db, { code: codigo, subtotalCents });
  } catch (error) {
    if (error instanceof CouponServiceError) {
      return {
        ok: false,
        text: `O cupom ${codigo} não vale para esta sacola: ${error.message}\n[Explique com gentileza e siga sem desconto — nunca invente outro.]`,
      };
    }
    throw error;
  }
  await updateBotState(db, ctx, (current) => ({
    ...current,
    coupon: { code: quote.code, discountCents: quote.discountCents, at: new Date().toISOString() },
  }));
  return {
    ok: true,
    text: [
      `Cupom ${quote.code} válido: desconto de ${formatCentsBRL(quote.discountCents)} sobre o subtotal de ${formatCentsBRL(subtotalCents)} das peças → ${formatCentsBRL(subtotalCents - quote.discountCents)} (o frete não entra no desconto).`,
      `Passe cupom: "${quote.code}" em criar_pedido — o desconto só é aplicado ao fechar o pedido, e o resumo oficial virá com o valor final.`,
    ].join("\n"),
  };
}
