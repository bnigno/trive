// Ferramentas da sacola da vendedora.
import { cartAdd, cartIndexOf, cartRemoveAt, cartSubtotalCents, findCartItem, formatCartLines, mergeCartByVariant, quoteKey, sameProductName, type BotCartItem, type BotState } from "@/core/bot/memory";
import type { BotToolInputs } from "@/core/bot/tools";
import { variantLabel } from "@/core/catalog/attributes";
import { formatCentsBRL } from "@/lib/money";
import type { DbOrTx } from "@/queue/enqueue";
import { pendingNotice } from "@/core/coupons/messages";
import { quoteCoupon, ServiceError as CouponServiceError, type CouponQuote } from "@/services/coupons";
import { computeTotalWeightGrams, getSellableVariantById, getSellableVariantBySku } from "@/services/store-catalog";

import { availableQtyOf, resolveVariantBySku } from "./catalog";
import { readBotState, resolveConversationCustomerId, updateBotState } from "./shared";
import type { BotExecutorContext, ToolResult } from "./shared";

/** As linhas da sacola como o cupom precisa (variante + quantidade); linha sem variante resolvida não entra. */
async function cartCouponItems(db: DbOrTx, cart: readonly BotCartItem[]): Promise<{ variantId: string; quantity: number }[]> {
  const items: { variantId: string; quantity: number }[] = [];
  for (const item of cart) {
    const variantId = item.variantId ?? (item.sku.trim() === "" ? null : (await getSellableVariantBySku(db, item.sku, { includeHidden: true }))?.variantId ?? null);
    if (variantId) items.push({ variantId, quantity: item.quantidade });
  }
  return items;
}

/** A entrega escolhida no caderninho (valor + tipo), se houver — o cupom de frete grátis depende dela. */
function chosenShipping(state: BotState): { cents: number; kind: "motoboy" | "correios" } | null {
  const chosenKey = state.chosenOptionKey ?? state.chosenRateId;
  if (!chosenKey) return null;
  const quote = (state.lastQuotes ?? []).find((q) => quoteKey(q) === chosenKey);
  if (!quote) return null;
  return { cents: quote.priceCents, kind: quote.kind === "motoboy" ? "motoboy" : "correios" };
}

/** Cota o cupom para a sacola DESTA conversa (identidade = a cliente da conversa, pelo cadastro ou telefone). */
async function quoteCartCoupon(db: DbOrTx, ctx: BotExecutorContext, state: BotState, code: string): Promise<CouponQuote> {
  const cart = state.cart ?? [];
  return quoteCoupon(db, {
    code,
    items: await cartCouponItems(db, cart),
    identity: { customerId: await resolveConversationCustomerId(db, ctx), phoneE164: ctx.phoneE164 },
    shipping: chosenShipping(state),
    now: ctx.now,
  });
}

/** "desconto de R$ 20,00 nesta sacola" / "frete grátis (motoboy)" — o que o cupom faz, numa frase curta. */
function quoteSummary(quote: CouponQuote, subtotalCents: number): string {
  if (quote.freeShipping) {
    const scope = quote.pending.includes("shipping_scope") ? " (o escopo motoboy/Correios é conferido com a entrega escolhida)" : "";
    return `frete grátis${quote.shippingDiscountCents > 0 ? ` (${formatCentsBRL(quote.shippingDiscountCents)} da entrega escolhida)` : ""}${scope}; as peças continuam ${formatCentsBRL(subtotalCents)}`;
  }
  return `desconto de ${formatCentsBRL(quote.discountCents)} sobre o subtotal de ${formatCentsBRL(subtotalCents)} das peças → ${formatCentsBRL(subtotalCents - quote.discountCents)} (o frete não entra no desconto)`;
}

/**
 * A sacola mudou: o cupom validado é refeito sobre o subtotal novo (o
 * caderninho mostra o desconto certo) ou esquecido, com o motivo — nunca um
 * desconto velho até o fechamento.
 */
async function refreshCoupon(
  db: DbOrTx,
  ctx: BotExecutorContext,
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
    const quote = await quoteCartCoupon(db, ctx, state, code);
    return {
      coupon: { code: quote.code, discountCents: quote.discountCents, freeShipping: quote.freeShipping || undefined, hint: quote.hint ?? undefined, at: new Date().toISOString() },
      note: `[Cupom ${quote.code} continua válido: ${quoteSummary(quote, cartSubtotalCents(cart))}.${quote.hint ? ` ${quote.hint}` : ""}]`,
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
  const refreshed = await refreshCoupon(db, ctx, changed);
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

  // A sacola conferida com o catálogo ANTES de mexer: linha velha da mesma
  // variante (SKU renomeado) é a mesma linha, não uma segunda.
  const reconciled = await reconcileCartLines(db, ctx);
  const indice = cartIndexOf(reconciled.cart, { sku: variant.sku, variantId: variant.variantId });
  const existente = indice >= 0 ? reconciled.cart[indice] : null;
  // Quantidade é o TOTAL da linha (nunca soma): repetir a chamada no turno
  // do "SIM" não pode dobrar a peça. Já está igual → nada muda, e a cotação
  // de frete e o cupom ficam como estão.
  const quantidade = input.quantidade ?? existente?.quantidade ?? 1;
  if (existente && existente.quantidade === quantidade) {
    return {
      ok: true,
      text: [
        `[Já estava na sacola: ${existente.quantidade}× ${rotulo} — nada mudou. Não diga "adicionei": siga a conversa. Para outra quantidade, passe o TOTAL em quantidade; para tirar, remover_da_sacola.]`,
        ...formatCartLines(reconciled.cart),
        ...reconciled.notes,
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

  const added = cartAdd(reconciled.cart, {
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
      ...reconciled.notes,
      ...(couponNote ? [couponNote] : []),
      "[Se a sacola tiver tudo, siga para o CEP e cotar_frete. Sugira UMA peça que completa o look só depois do pedido fechado.]",
    ].join("\n"),
  };
}

type CartLineStatus = { item: BotCartItem; healed: BotCartItem | null; gone: boolean; note: string | null };

function itemLabel(item: BotCartItem): string {
  return item.variacao ? `${item.nome} (${item.variacao})` : item.nome;
}

/**
 * Confere cada linha da sacola com o catálogo. Linha COM variantId resolve
 * só pela variante (nunca cai no SKU: o código pode ter sido reaproveitado
 * por outra peça); linha SEM variantId (ponte do site, sacola de antes)
 * resolve pelo SKU, e só é curada se o NOME bater — SKU que hoje é de outra
 * peça vira "fora de venda". Cura regrava sku/variantId/nome/variação/preço
 * e junta linha velha + nova da mesma variante. Preço que mudou vira nota:
 * a cliente precisa ver o resumo de novo. Grava só se algo mudou (zerando a
 * cotação e refazendo o cupom quando o que muda é quantidade ou valor).
 */
export async function reconcileCartLines(
  db: DbOrTx,
  ctx: BotExecutorContext,
): Promise<{ cart: BotCartItem[]; notes: string[]; gone: BotCartItem[]; material: boolean }> {
  const state = await readBotState(db, ctx);
  const statuses: CartLineStatus[] = [];
  for (const item of state.cart ?? []) {
    const gone = (note: string | null = null): CartLineStatus => ({ item, healed: null, gone: true, note });
    if (item.sku.trim() === "" && !item.variantId) {
      statuses.push(gone());
      continue;
    }
    const variant = item.variantId
      ? await getSellableVariantById(db, item.variantId)
      : await getSellableVariantBySku(db, item.sku, { includeHidden: true });
    if (!variant) {
      statuses.push(gone());
      continue;
    }
    if (!item.variantId && !sameProductName(item.nome, variant.name)) {
      statuses.push(gone(`[O SKU ${item.sku} hoje é de outra peça ("${variant.name}"); a linha "${itemLabel(item)}" não está mais à venda: tire pelo nome e, se a cliente quiser a peça, confirme com detalhar_produto.]`));
      continue;
    }
    const variacao = variantLabel(variant.attributes, variant.attributesSchema);
    const fresh: BotCartItem = { ...item, sku: variant.sku, variantId: variant.variantId, nome: variant.name, variacao, precoCents: variant.priceCents };
    const notes: string[] = [];
    if (fresh.sku !== item.sku) notes.push(`o SKU mudou de ${item.sku} para ${fresh.sku}`);
    if (fresh.nome !== item.nome) notes.push(`o nome mudou de "${item.nome}" para "${fresh.nome}"`);
    if (fresh.precoCents !== item.precoCents) notes.push(`o PREÇO mudou de ${formatCentsBRL(item.precoCents)} para ${formatCentsBRL(fresh.precoCents)} — mostre o resumo de novo antes de fechar`);
    const changed = fresh.sku !== item.sku || fresh.variantId !== item.variantId || fresh.nome !== item.nome || fresh.variacao !== item.variacao || fresh.precoCents !== item.precoCents;
    statuses.push({ item, healed: changed ? fresh : null, gone: false, note: notes.length > 0 ? `[Linha "${itemLabel(item)}": ${notes.join("; ")}.]` : null });
  }
  const before = state.cart ?? [];
  const merged = mergeCartByVariant(statuses.map((line) => line.healed ?? line.item));
  const notes = statuses.map((line) => line.note).filter((note): note is string => note !== null);
  if (merged.length < before.length) notes.push("[Linhas da mesma peça foram juntadas numa só — mostre o resumo de novo antes de fechar.]");
  const changed = statuses.some((line) => line.healed) || merged.length !== before.length;
  // Material = o que a cliente vê muda (quantidade ou valor): a cotação de
  // frete e o cupom precisam ser refeitos; renomear SKU/nome não.
  const material =
    merged.length !== before.length || statuses.some((line) => line.healed && line.healed.precoCents !== line.item.precoCents);
  let cart = merged;
  if (changed && material) {
    const result = await changeCart(db, ctx, (current) => ({ ...current, cart: merged, lastQuotes: undefined, chosenRateId: undefined, chosenOptionKey: undefined }));
    cart = result.state.cart ?? merged;
    if (result.couponNote) notes.push(result.couponNote);
  } else if (changed) {
    cart = (await updateBotState(db, ctx, (current) => ({ ...current, cart: merged }))).cart ?? merged;
  }
  return { cart, notes, gone: statuses.filter((line) => line.gone).map((line) => line.item), material };
}

function goneLines(gone: readonly BotCartItem[]): string[] {
  return gone.map(
    (item) => `[A linha "${itemLabel(item)}" não está mais à venda (peça desativada ou fora do catálogo): tire da sacola com remover_da_sacola usando esse nome, e ofereça outra.]`,
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
    text: [`Tirei ${item.quantidade}× ${itemLabel(item)} da sacola.`, ...formatCartLines(state.cart), ...(couponNote ? [couponNote] : [])].join("\n"),
  };
}

/** Peso da sacola pela variante (o SKU da linha pode ter mudado); linha que não resolve entra com o peso padrão. */
export async function cartWeightGrams(db: DbOrTx, cart: readonly BotCartItem[]): Promise<number> {
  const lines: { weightGrams: number | null; quantity: number }[] = [];
  for (const item of cart) {
    const variant = item.variantId
      ? await getSellableVariantById(db, item.variantId)
      : item.sku.trim() === ""
        ? null
        : await getSellableVariantBySku(db, item.sku, { includeHidden: true });
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
  let quote: CouponQuote;
  try {
    quote = await quoteCartCoupon(db, ctx, state, codigo);
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
    coupon: { code: quote.code, discountCents: quote.discountCents, freeShipping: quote.freeShipping || undefined, hint: quote.hint ?? undefined, at: new Date().toISOString() },
  }));
  const notice = pendingNotice(quote.pending);
  return {
    ok: true,
    text: [
      `Cupom ${quote.code} válido: ${quoteSummary(quote, subtotalCents)}.`,
      ...(quote.hint ? [`[Este cupom muda com o tempo — ${quote.hint} Conte isso para ela em 1 frase, com leveza e sem pressionar: é uma surpresa boa, não uma ameaça.]`] : []),
      ...(notice ? [`[${notice}]`] : []),
      `Passe cupom: "${quote.code}" em criar_pedido — o desconto só é aplicado ao fechar o pedido, e o resumo oficial virá com o valor final.`,
    ].join("\n"),
  };
}
