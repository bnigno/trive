// Quanto vale a peça que voltou. PURO.
//
// O desconto do cupom vive só no cabeçalho do pedido (`orders.discount_cents`);
// `order_items` não tem campo de desconto. Então devolver "os óculos de
// R$ 54,99" de um pedido com 10% de cupom devolveria R$ 5,50 a mais do que a
// cliente pagou. O rateio é o que conserta isso.
//
// Frete fica de fora de propósito: a política da loja só devolve frete no
// arrependimento INTEGRAL (art. 49). Quem devolve 1 peça entre 4 continua
// tendo usado a entrega.

export type ReturnableItem = {
  id: string;
  /** unitPrice × quantity, como o banco grava. */
  totalCents: number;
  quantity: number;
};

export type FairReturnInput = {
  items: ReturnableItem[];
  discountCents: number;
  /**
   * O cupom valia só para algumas peças (escopo por produto/categoria)? O
   * pedido não guarda quais itens eram elegíveis, então o rateio proporcional
   * pode errar para os dois lados — o número vira sugestão.
   */
  couponHadItemScope?: boolean;
};

export type FairReturnValue = {
  refundCents: number;
  /** true = confira antes de devolver dinheiro; o rateio pode não refletir o cupom. */
  needsReview: boolean;
};

/**
 * Quanto do desconto do pedido coube a cada item.
 *
 * Arredonda a parte do desconto para BAIXO em todos os itens, de propósito —
 * e por isso NÃO usa `splitProportional`, que fecha a conta jogando o resto no
 * último item. Aqui o dinheiro está voltando para a cliente: com o resto no
 * último, a peça que por acaso ficou no fim da lista valeria alguns centavos a
 * menos na devolução, o que é arbitrário e sempre contra ela. Com piso em
 * todos, o erro é de no máximo 1 centavo por item e sempre a favor dela.
 */
export function itemDiscountShares(items: ReturnableItem[], discountCents: number): number[] {
  if (items.length === 0) return [];
  if (discountCents === 0) return items.map(() => 0);
  const subtotal = items.reduce((sum, item) => sum + item.totalCents, 0);
  if (subtotal <= 0) return items.map(() => 0);
  return items.map((item) => Math.floor((discountCents * item.totalCents) / subtotal));
}

/**
 * O que a cliente pagou pelas unidades que estão voltando. Devolver a linha
 * inteira nunca passa do que a linha valeu (o `min` segura o arredondamento
 * por unidade).
 */
export function fairReturnValue(
  input: FairReturnInput,
  selection: { itemId: string; quantity: number },
): FairReturnValue {
  const index = input.items.findIndex((item) => item.id === selection.itemId);
  if (index === -1) {
    throw new Error(`fairReturnValue: item ${selection.itemId} não é deste pedido`);
  }
  const item = input.items[index]!;
  if (!Number.isInteger(selection.quantity) || selection.quantity < 1 || selection.quantity > item.quantity) {
    throw new RangeError(`fairReturnValue: quantidade ${selection.quantity} fora de 1..${item.quantity}`);
  }

  const lineShare = itemDiscountShares(input.items, input.discountCents)[index]!;
  const lineNet = item.totalCents - lineShare;
  // Mesma regra dentro da linha: piso por unidade, arredondando a favor dela.
  const perUnit = Math.ceil(lineNet / item.quantity);
  const refundCents = Math.min(lineNet, perUnit * selection.quantity);

  return { refundCents, needsReview: input.couponHadItemScope === true };
}
