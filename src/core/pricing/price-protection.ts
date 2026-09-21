// Proteção de preço — PURO. Se uma peça que a cliente acabou de comprar
// baixa de preço, quem comprou antes não fica para trás: a diferença vira um
// cupom pessoal. A "queda" é medida contra o que ELA pagou (unit_price do
// pedido), não só contra o preço ativo anterior.

/** Preço ativo anterior maior que o novo = queda. Preço inicial (sem anterior) nunca é queda. */
export function isPriceDrop(input: { priceCents: number; previousPriceCents: number | null }): boolean {
  return input.previousPriceCents !== null && input.priceCents < input.previousPriceCents;
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
