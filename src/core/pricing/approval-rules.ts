export type ApprovalReason =
  | "price_drop"
  | "below_min_margin"
  | "change_above_threshold"
  | "below_cost"
  | "bulk_change"
  | "first_price";

export interface ApprovalContext {
  newPriceCents: number;
  previousActivePriceCents: number | null;
  effectiveMarginRate: number;
  minMarginRate: number;
  totalCostCents: number;
  changePctThreshold: number;
  isFirstPrice: boolean;
  firstPriceRequiresApproval: boolean;
  isBulk: boolean;
}

export interface ApprovalDecision {
  requiresApproval: boolean;
  reasons: ApprovalReason[];
}

/**
 * Toda mudança crítica exige aprovação; aumento dentro do limiar com margem
 * saudável é automático. A variação é relativa ao preço anterior e o limiar
 * é EXCLUSIVO: |variação| precisa exceder o threshold para exigir aprovação.
 */
export function evaluateApproval(ctx: ApprovalContext): ApprovalDecision {
  const reasons: ApprovalReason[] = [];
  const previous = ctx.previousActivePriceCents;

  if (previous !== null && ctx.newPriceCents < previous) {
    reasons.push("price_drop");
  }

  if (ctx.effectiveMarginRate < ctx.minMarginRate) {
    reasons.push("below_min_margin");
  }

  if (previous !== null) {
    const changeRatio =
      previous === 0
        ? ctx.newPriceCents === 0
          ? 0
          : Number.POSITIVE_INFINITY
        : Math.abs(ctx.newPriceCents - previous) / previous;
    if (changeRatio > ctx.changePctThreshold) {
      reasons.push("change_above_threshold");
    }
  }

  if (ctx.newPriceCents < ctx.totalCostCents) {
    reasons.push("below_cost");
  }

  if (ctx.isBulk) {
    reasons.push("bulk_change");
  }

  if (ctx.isFirstPrice && ctx.firstPriceRequiresApproval) {
    reasons.push("first_price");
  }

  return { requiresApproval: reasons.length > 0, reasons };
}
