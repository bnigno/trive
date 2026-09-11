// Ferramentas da sacola da vendedora.
import { inArray } from "drizzle-orm";
import { cartAdd, cartRemove, cartSubtotalCents, formatCartLines, type BotCartItem } from "@/core/bot/memory";
import type { BotToolInputs } from "@/core/bot/tools";
import { variantLabel } from "@/core/catalog/attributes";
import { productVariants } from "@/db/schema";
import { formatCentsBRL } from "@/lib/money";
import type { DbOrTx } from "@/queue/enqueue";
import { quoteCoupon, ServiceError as CouponServiceError } from "@/services/coupons";
import { computeTotalWeightGrams } from "@/services/store-catalog";

import { availableQtyOf, resolveVariantBySku } from "./catalog";
import { loadBotState, updateBotState } from "./shared";
import type { BotExecutorContext, ToolResult } from "./shared";

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
  const available = await availableQtyOf(db, variant.variantId);
  const axes = (variant.attributesSchema ?? []) as string[];
  const variacao = variantLabel(
    (variant.attributes ?? {}) as Record<string, string>,
    axes,
  );
  const rotulo = variacao ? `${variant.name} (${variacao})` : variant.name;
  if (available < input.quantidade) {
    return {
      ok: false,
      text:
        available === 0
          ? `${rotulo} está esgotada agora. Ofereça outra cor ou tamanho disponível (detalhar_produto) ou avisar_quando_voltar com este SKU.`
          : `${rotulo} tem só ${available} ${available === 1 ? "unidade" : "unidades"} disponível — pedi ${input.quantidade}. Ajuste a quantidade com a cliente.`,
    };
  }

  const item: BotCartItem = {
    sku: variant.sku,
    quantidade: input.quantidade,
    nome: variant.name,
    variacao,
    precoCents: variant.priceCents,
  };
  const state = await updateBotState(db, ctx, (current) => ({
    ...current,
    cart: cartAdd(current.cart, item),
    // Sacola mudou: a cotação anterior valia para outro peso.
    lastQuotes: undefined,
    chosenRateId: undefined,
  }));
  return {
    ok: true,
    text: [
      `Adicionei ${input.quantidade}× ${rotulo} à sacola.`,
      ...formatCartLines(state.cart),
      "[Se a sacola tiver tudo, siga para o CEP e cotar_frete. Sugira UMA peça que completa o look só depois do pedido fechado.]",
    ].join("\n"),
  };
}

export async function execVerSacola(
  db: DbOrTx,
  ctx: BotExecutorContext,
): Promise<ToolResult> {
  const state = await loadBotState(db, ctx.conversationId);
  return { ok: true, text: formatCartLines(state.cart).join("\n") };
}

export async function execRemoverDaSacola(
  db: DbOrTx,
  ctx: BotExecutorContext,
  input: BotToolInputs["remover_da_sacola"],
): Promise<ToolResult> {
  const before = await loadBotState(db, ctx.conversationId);
  const existed = (before.cart ?? []).some(
    (item) => item.sku.toLowerCase() === input.sku.trim().toLowerCase(),
  );
  if (!existed) {
    return {
      ok: false,
      text: `O SKU "${input.sku}" não está na sacola.\n${formatCartLines(before.cart).join("\n")}`,
    };
  }
  const state = await updateBotState(db, ctx, (current) => ({
    ...current,
    cart: cartRemove(current.cart, input.sku),
    lastQuotes: undefined,
    chosenRateId: undefined,
  }));
  return {
    ok: true,
    text: ["Tirei da sacola.", ...formatCartLines(state.cart)].join("\n"),
  };
}

export async function cartWeightGrams(db: DbOrTx, cart: readonly BotCartItem[]): Promise<number> {
  const skus = cart.map((item) => item.sku);
  const variants = await db
    .select({ sku: productVariants.sku, weightGrams: productVariants.weightGrams })
    .from(productVariants)
    .where(inArray(productVariants.sku, skus));
  const weightBySku = new Map(variants.map((v) => [v.sku, v.weightGrams]));
  return computeTotalWeightGrams(
    cart.map((item) => ({
      weightGrams: weightBySku.get(item.sku) ?? null,
      quantity: item.quantidade,
    })),
  );
}

/**
 * validar_cupom: o desconto REAL sobre a sacola desta conversa, sem consumir
 * o cupom (quem consome é criar_pedido, na transação do pedido). Válido vai
 * para o caderninho; criar_pedido aplica quando o campo cupom vier ausente.
 * Só lê, então vale também no ensaio (dryRun) — o caderninho não é gravado.
 */
export async function execValidarCupom(
  db: DbOrTx,
  ctx: BotExecutorContext,
  input: BotToolInputs["validar_cupom"],
): Promise<ToolResult> {
  const state = await loadBotState(db, ctx.conversationId);
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
        text: `O cupom ${codigo} não vale para esta sacola: ${error.message} Explique com gentileza e siga sem desconto — nunca invente outro.`,
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
