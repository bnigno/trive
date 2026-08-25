export const MOVEMENT_TYPES = [
  "purchase_in",
  "sale_out",
  "reservation",
  "reservation_release",
  "adjustment",
  "return_in",
  "loss",
] as const;

export type MovementType = (typeof MOVEMENT_TYPES)[number];

export interface StockLevel {
  onHand: number;
  reserved: number;
}

export interface StockMovement {
  type: MovementType;
  quantityDelta: number;
}

export class SignError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignError";
  }
}

export class InsufficientStockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InsufficientStockError";
  }
}

const SIGN_RULES: Record<
  MovementType,
  { affects: "onHand" | "reserved"; sign: "positive" | "negative" | "any" }
> = {
  purchase_in: { affects: "onHand", sign: "positive" },
  return_in: { affects: "onHand", sign: "positive" },
  sale_out: { affects: "onHand", sign: "negative" },
  loss: { affects: "onHand", sign: "negative" },
  adjustment: { affects: "onHand", sign: "any" },
  reservation: { affects: "reserved", sign: "positive" },
  reservation_release: { affects: "reserved", sign: "negative" },
};

export function applyMovement(
  level: StockLevel,
  m: StockMovement,
): StockLevel {
  if (!Number.isInteger(m.quantityDelta) || m.quantityDelta === 0) {
    throw new SignError(
      `Movimento de estoque "${m.type}" exige quantidade inteira diferente de zero.`,
    );
  }

  const rule = SIGN_RULES[m.type];
  if (rule.sign === "positive" && m.quantityDelta < 0) {
    throw new SignError(
      `Movimento de estoque "${m.type}" exige quantidade positiva.`,
    );
  }
  if (rule.sign === "negative" && m.quantityDelta > 0) {
    throw new SignError(
      `Movimento de estoque "${m.type}" exige quantidade negativa.`,
    );
  }

  const next: StockLevel =
    rule.affects === "reserved"
      ? { onHand: level.onHand, reserved: level.reserved + m.quantityDelta }
      : { onHand: level.onHand + m.quantityDelta, reserved: level.reserved };

  if (next.onHand < 0) {
    throw new InsufficientStockError(
      "Estoque insuficiente: quantidade em mãos ficaria negativa.",
    );
  }
  if (next.reserved < 0) {
    throw new InsufficientStockError(
      "Estoque insuficiente: reserva ficaria negativa.",
    );
  }
  if (next.onHand - next.reserved < 0) {
    throw new InsufficientStockError(
      "Estoque insuficiente: reserva excederia a quantidade disponível.",
    );
  }

  return next;
}

export function movementsForTransition(
  effect: "reserve" | "consume" | "release" | "return",
  quantity: number,
): StockMovement[] {
  switch (effect) {
    case "reserve":
      return [{ type: "reservation", quantityDelta: quantity }];
    case "consume":
      return [
        { type: "reservation_release", quantityDelta: -quantity },
        { type: "sale_out", quantityDelta: -quantity },
      ];
    case "release":
      return [{ type: "reservation_release", quantityDelta: -quantity }];
    case "return":
      return [{ type: "return_in", quantityDelta: quantity }];
  }
}

export function isLowStock(level: StockLevel, threshold: number): boolean {
  return level.onHand - level.reserved <= threshold;
}
