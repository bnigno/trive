// Prazo de entrega em texto ("1 dia útil", "3–5 dias úteis"); sacola e
// checkout usam a mesma cópia.
import type { ShippingQuote } from "@/services/store-catalog";

export function deliveryLabel(
  quote: Pick<ShippingQuote, "deliveryDaysMin" | "deliveryDaysMax">,
): string {
  const { deliveryDaysMin: min, deliveryDaysMax: max } = quote;
  if (min === max) return min === 1 ? "1 dia útil" : `${min} dias úteis`;
  return `${min}–${max} dias úteis`;
}
