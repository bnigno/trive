import type { Cents } from "@/lib/money";

export class OrderTotalsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrderTotalsError";
  }
}

export interface OrderTotalsItem {
  unitPriceCents: Cents;
  quantity: number;
}

export interface OrderTotals {
  subtotalCents: Cents;
  totalCents: Cents;
}

export function computeOrderTotals(
  items: OrderTotalsItem[],
  discountCents: Cents,
  shippingCents: Cents,
): OrderTotals {
  for (const item of items) {
    if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
      throw new OrderTotalsError(
        "Quantidade do item deve ser um inteiro maior que zero.",
      );
    }
    if (!Number.isInteger(item.unitPriceCents) || item.unitPriceCents < 0) {
      throw new OrderTotalsError(
        "Preço unitário do item não pode ser negativo.",
      );
    }
  }
  if (!Number.isInteger(discountCents) || discountCents < 0) {
    throw new OrderTotalsError("Desconto não pode ser negativo.");
  }
  if (!Number.isInteger(shippingCents) || shippingCents < 0) {
    throw new OrderTotalsError("Frete não pode ser negativo.");
  }

  const subtotalCents = items.reduce(
    (sum, item) => sum + item.unitPriceCents * item.quantity,
    0,
  );

  if (discountCents > subtotalCents) {
    throw new OrderTotalsError(
      "Desconto não pode ser maior que o subtotal do pedido.",
    );
  }

  return {
    subtotalCents,
    totalCents: subtotalCents - discountCents + shippingCents,
  };
}
