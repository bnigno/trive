// Proteção de preço — PURO. Se uma peça que a cliente acabou de comprar
// baixa de preço, quem comprou antes não fica para trás: a diferença vira um
// cupom pessoal. A "queda" é medida contra o que ELA pagou (preço de lista
// do pedido com o desconto rateado), nunca contra o preço ativo anterior —
// que pode estar velho (versão aprovada depois de outras ativações).

/**
 * O que ela pagou de verdade por unidade: o preço de lista com o desconto do
 * pedido rateado (cupom de 10% → cada peça 10% mais barata). Sem desconto,
 * o próprio preço de lista.
 */
export function effectiveUnitPriceCents(input: { unitPriceCents: number; subtotalCents: number; discountCents: number }): number {
  if (input.subtotalCents <= 0 || input.discountCents <= 0) return input.unitPriceCents;
  return Math.floor((input.unitPriceCents * (input.subtotalCents - input.discountCents)) / input.subtotalCents);
}

/** Desde quando um pedido pago conta (agora − N dias). */
export function protectionWindowStart(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 86_400_000);
}

/** A diferença × quantidade, nunca negativa (o teto natural é o que ela pagou). */
export function priceProtectionRefundCents(input: { unitPriceCents: number; quantity: number; newPriceCents: number }): number {
  return Math.max(0, input.unitPriceCents - input.newPriceCents) * input.quantity;
}

/** Nota interna do cupom. */
export function priceProtectionNote(input: { productName: string; unitPriceCents: number; newPriceCents: number; orderNumber: number }): string {
  const fmt = (cents: number) => `R$ ${(cents / 100).toFixed(2).replace(".", ",")}`;
  return `${input.productName} baixou de ${fmt(input.unitPriceCents)} para ${fmt(input.newPriceCents)} (pedido #${input.orderNumber})`;
}
