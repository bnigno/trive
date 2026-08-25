export type RoundingMode = "none" | "to_90" | "to_99" | "to_50" | "integer";

export type RoundingDirection = "up" | "nearest";

export interface PricingInputs {
  costCents: number;
  otherFixedCents: number;
  otherRate: number;
  feePercentRate: number;
  feeFixedCents: number;
  shippingSubsidyCents: number;
  targetMarginRate: number;
  rounding: { mode: RoundingMode; direction: RoundingDirection };
}

export interface BreakdownStep {
  label: string;
  valueCents?: number;
  value?: number;
}

export interface PriceBreakdown {
  formula: string;
  inputs: PricingInputs;
  steps: BreakdownStep[];
  output: {
    priceCents: number;
    effectiveMarginCents: number;
    effectiveMarginRate: number;
    feeEstimatedCents: number;
    netReceivableCents: number;
  };
  engineVersion: string;
}

export interface PricingResult {
  priceCents: number;
  breakdown: PriceBreakdown;
  effectiveMarginRate: number;
}
