// Prazo de entrega em texto ("1 dia útil", "3–5 dias úteis") ou a janela do
// motoboy ("hoje, 19h–21h · pague até 13h"); sacola e checkout usam a mesma cópia.
import type { DeliveryOption } from "@/core/shipping/delivery-windows";

type DaysLike = { deliveryDaysMin: number; deliveryDaysMax: number };

export function deliveryLabel(option: DeliveryOption | DaysLike): string {
  if ("kind" in option && option.kind === "motoboy") return option.label;
  const { deliveryDaysMin: min, deliveryDaysMax: max } = option as DaysLike;
  if (min === max) return min === 1 ? "1 dia útil" : `${min} dias úteis`;
  return `${min}–${max} dias úteis`;
}
