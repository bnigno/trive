// Que mensagem cada marco do pedido manda — à cliente e à dona — e com que
// chave de dedupe. PURO: o handler da fila só carrega o pedido e envia.

export const ORDER_WA_MILESTONES = {
  store_created: {
    clientTemplate: "order_confirmed",
    clientDedupePrefix: "wa.order_confirmed:",
    ownerTemplate: "owner_new_order",
    ownerDedupePrefix: "wa.owner_new:",
  },
  paid: {
    clientTemplate: "payment_approved",
    clientDedupePrefix: "wa.payment_approved:",
    ownerTemplate: "owner_payment_approved",
    ownerDedupePrefix: "wa.owner_paid:",
  },
  shipped: {
    clientTemplate: "order_shipped",
    clientDedupePrefix: "wa.order_shipped:",
    ownerTemplate: null,
    ownerDedupePrefix: null,
  },
  // Dinheiro na entrega saiu com o motoboy (sem transição de status).
  out_for_delivery: {
    clientTemplate: "order_out_for_delivery",
    clientDedupePrefix: "wa.order_out_for_delivery:",
    ownerTemplate: null,
    ownerDedupePrefix: null,
  },
} as const;

export type OrderWaMilestone = keyof typeof ORDER_WA_MILESTONES;

export interface OrderWaPlan {
  client: { template: string; dedupePrefix: string } | null;
  owner: { template: string; dedupePrefix: string } | null;
}

export function orderWaPlan(input: {
  milestone: OrderWaMilestone;
  paymentMethod: string | null;
  hasDeliveryWindow: boolean;
  /** O pedido nasceu de um "refazer pedido" (substitui um antigo). */
  replacesOrder: boolean;
}): OrderWaPlan {
  const spec = ORDER_WA_MILESTONES[input.milestone];
  const cash = input.paymentMethod === "cash";
  // Pedido refeito: no lugar da confirmação, a cliente recebe "seu pedido #A
  // foi atualizado e agora é o #B" e a dona, o que mudou e quem refez.
  if (input.milestone === "store_created" && input.replacesOrder) {
    return {
      client: { template: cash ? "order_updated_cash" : "order_updated", dedupePrefix: "wa.order_updated:" },
      owner: { template: "owner_order_updated", dedupePrefix: "wa.owner_updated:" },
    };
  }
  // Motoboy: "enviado" não tem rastreio — é "saiu, chega hoje entre 19h e
  // 21h". A chave de dedupe é a mesma do despacho em dinheiro: um pedido só
  // recebe "saiu" uma vez, por qualquer caminho.
  const motoboyOut = input.hasDeliveryWindow && (input.milestone === "shipped" || input.milestone === "out_for_delivery");
  // Dinheiro na entrega: confirmação SEM link de pagamento nem prazo de
  // reserva (o template order_confirmed quebraria com {{prazo}} vazio).
  const template =
    input.milestone === "store_created" && cash
      ? "order_confirmed_cash"
      : motoboyOut
        ? ORDER_WA_MILESTONES.out_for_delivery.clientTemplate
        : spec.clientTemplate;
  const dedupePrefix = motoboyOut ? ORDER_WA_MILESTONES.out_for_delivery.clientDedupePrefix : spec.clientDedupePrefix;
  // Dinheiro na entrega: "pagamento aprovado, já estamos preparando" não
  // faz sentido — o pagamento é a própria entrega. Só a dona é avisada.
  const skipClient = input.milestone === "paid" && cash;
  return {
    client: skipClient ? null : { template, dedupePrefix },
    owner: spec.ownerTemplate && spec.ownerDedupePrefix ? { template: spec.ownerTemplate, dedupePrefix: spec.ownerDedupePrefix } : null,
  };
}
