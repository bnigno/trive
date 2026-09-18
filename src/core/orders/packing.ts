// Embalar antes de sair (decisão da dona, 2026-09-18): "Saiu" com o motoboy
// e "Marcar como enviado" (Correios) só com a foto do pacote registrada
// (orders.package_photo_path, gravada na Mesa de embalagem). O status
// `preparing` NÃO prova embalagem — o próprio "Saiu" passava por ele.
// Pedido que já saiu antes da regra (dispatchedAt, shipped, delivered)
// continua fechando normalmente. PURO.
import type { OrderStatus } from "./state-machine";

export interface PackingCheckInput {
  status: OrderStatus | string;
  packagePhotoPath: string | null | undefined;
  /** `deliveryWindow.dispatchedAt` do pedido de motoboy; null/undefined quando ainda não saiu. */
  dispatchedAt?: string | null;
}

/** Precisa da foto do pacote antes de sair/enviar? */
export function needsPackingBeforeDispatch(order: PackingCheckInput): boolean {
  if (order.packagePhotoPath) return false;
  if (order.dispatchedAt) return false;
  return order.status !== "shipped" && order.status !== "delivered";
}

export const NOT_PACKED_CODE = "NOT_PACKED";

export function notPackedMessage(orderNumber: number, action: "sair" | "enviar"): string {
  const verbo = action === "sair" ? "marcar que saiu" : "marcar como enviado";
  return `O pedido #${orderNumber} ainda não foi embalado: registre a foto do pacote (Mesa de embalagem ou card Embalagem da ficha) antes de ${verbo}.`;
}
