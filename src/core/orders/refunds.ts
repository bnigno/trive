// Quem devolve o dinheiro: o sistema ou o dono. PURO.
//
// Só o que passou pelo Mercado Pago pode ser estornado por software — Pix
// manual cai na chave da loja e dinheiro na entrega é espécie na mão; nos
// dois casos quem devolve é o dono, pelo banco. A distinção vive aqui porque
// ela decide três coisas ao mesmo tempo: se a fila chama o vendor, o texto de
// confirmação que o painel mostra, e o instante em que a cliente é avisada.
import { MP_PAYMENT_METHODS } from "./payment-methods";

/** O que o sistema sabe sobre o dinheiro — não confundir com o status do pedido. */
export const REFUND_STATES = ["nao_aplicavel", "pendente", "devolvido", "falhou"] as const;
export type RefundState = (typeof REFUND_STATES)[number];

export const REFUND_STATE_LABELS: Record<RefundState, string> = {
  nao_aplicavel: "Devolução por fora",
  pendente: "Devolvendo…",
  devolvido: "Dinheiro devolvido",
  falhou: "A devolução falhou",
};

export type RefundRouteInput = {
  /** Vem como texto do banco (a coluna aceita qualquer string); valor fora da lista = manual. */
  paymentMethod: string | null;
  /** Sem id do pagamento no vendor não há o que estornar, mesmo em método do MP. */
  mpPaymentId: string | null;
};

/**
 * `true` = a fila pede o estorno ao Mercado Pago. `false` = o dono devolve
 * por fora e o sistema só registra.
 */
export function isAutomaticRefund(input: RefundRouteInput): boolean {
  if (input.mpPaymentId === null || input.mpPaymentId.trim() === "") return false;
  return (MP_PAYMENT_METHODS as readonly string[]).includes(input.paymentMethod ?? "");
}

/** O estado com que o pedido nasce ao ser reembolsado. */
export function initialRefundState(input: RefundRouteInput): RefundState {
  return isAutomaticRefund(input) ? "pendente" : "nao_aplicavel";
}

/**
 * A cliente só pode ouvir "seu reembolso foi confirmado" quando o dinheiro
 * saiu. Em 'pendente' o aviso espera o vendor responder; em 'falhou' não sai
 * de jeito nenhum — foi exatamente a promessa vazia que motivou esta regra.
 */
export function mayAnnounceRefund(state: RefundState): boolean {
  return state === "nao_aplicavel" || state === "devolvido";
}
