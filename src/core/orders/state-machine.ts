export const ORDER_STATUSES = [
  "draft",
  "pending_payment",
  "paid",
  "preparing",
  "shipped",
  "delivered",
  "canceled",
  "refunded",
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const VALID_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  draft: ["pending_payment", "canceled"],
  pending_payment: ["paid", "canceled"],
  // paid→delivered: entrega direta sem separação/envio (ex.: dinheiro na
  // entrega baixado pelo dono). O consume de estoque já ocorreu em paid.
  paid: ["preparing", "canceled", "refunded", "delivered"],
  preparing: ["shipped", "canceled", "refunded"],
  shipped: ["delivered", "refunded"],
  delivered: ["refunded"],
  canceled: [],
  refunded: [],
};

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  draft: "Rascunho",
  pending_payment: "Aguardando pagamento",
  paid: "Pago",
  preparing: "Em separação",
  shipped: "Enviado",
  delivered: "Entregue",
  canceled: "Cancelado",
  refunded: "Reembolsado",
};

export class InvalidTransitionError extends Error {
  constructor(from: OrderStatus, to: OrderStatus) {
    super(
      `Transição de pedido inválida: "${ORDER_STATUS_LABELS[from]}" não pode mudar para "${ORDER_STATUS_LABELS[to]}".`,
    );
    this.name = "InvalidTransitionError";
  }
}

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canTransition(from, to)) {
    throw new InvalidTransitionError(from, to);
  }
}

export type StockEffect = "reserve" | "consume" | "release" | "return";

/**
 * Efeito de estoque intrínseco à transição:
 * - draft→pending_payment: 'reserve' (reserva estoque);
 * - pending_payment→paid: 'consume' (libera reserva + baixa definitiva);
 * - pending_payment→canceled: 'release' (devolve reserva; draft nunca reservou → null).
 * Devolução física ('return' via return_in) em cancelamento pós-pagamento ou
 * reembolso é decisão do serviço chamador (a mercadoria pode não voltar):
 * aqui essas transições retornam null.
 */
export function requiredStockEffect(
  from: OrderStatus,
  to: OrderStatus,
): StockEffect | null {
  if (from === "draft" && to === "pending_payment") return "reserve";
  if (from === "pending_payment" && to === "paid") return "consume";
  if (from === "pending_payment" && to === "canceled") return "release";
  return null;
}

export type OrderTimestampField =
  | "paid_at"
  | "shipped_at"
  | "delivered_at"
  | "canceled_at";

export function timestampFieldFor(to: OrderStatus): OrderTimestampField | null {
  switch (to) {
    case "paid":
      return "paid_at";
    case "shipped":
      return "shipped_at";
    case "delivered":
      return "delivered_at";
    case "canceled":
      return "canceled_at";
    default:
      return null;
  }
}
