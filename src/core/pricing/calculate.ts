import { assertCents } from "@/lib/money";

import type {
  BreakdownStep,
  PricingInputs,
  PricingResult,
  RoundingDirection,
  RoundingMode,
} from "./types";

export const ENGINE_VERSION = "1.0.0";

export class PricingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PricingError";
  }
}

const FORMULA =
  "preço = arredondamento(teto((custo + custos_fixos + tarifa_fixa + subsídio_frete) ÷ (1 − taxa_percentual − custos_percentuais − margem_alvo)))";

// Divisor mínimo: abaixo disso o preço explode (taxas+margem consomem ~tudo).
const MIN_DIVISOR = 0.01;

const ROUNDING_ENDING_CENTS: Record<Exclude<RoundingMode, "none">, number> = {
  to_90: 90,
  to_99: 99,
  to_50: 50,
  integer: 0,
};

const ROUNDING_MODE_LABEL: Record<Exclude<RoundingMode, "none">, string> = {
  to_90: ",90",
  to_99: ",99",
  to_50: ",50",
  integer: "real inteiro",
};

const ROUNDING_DIRECTION_LABEL: Record<RoundingDirection, string> = {
  up: "para cima",
  nearest: "mais próximo",
};

function assertNonNegativeCents(value: number, label: string): void {
  assertCents(value);
  if (value < 0) {
    throw new PricingError(
      `${label} não pode ser negativo (recebido: ${value} centavos).`,
    );
  }
}

function assertRate(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    throw new PricingError(
      `${label} deve ser uma fração entre 0 e 1 (ex.: 4,98% = 0.0498); recebido: ${value}.`,
    );
  }
}

function assertCostInputs(
  inputs: Omit<PricingInputs, "targetMarginRate" | "rounding">,
): void {
  assertNonNegativeCents(inputs.costCents, "Custo do produto");
  assertNonNegativeCents(inputs.otherFixedCents, "Custos fixos");
  assertNonNegativeCents(inputs.feeFixedCents, "Tarifa fixa");
  assertNonNegativeCents(inputs.shippingSubsidyCents, "Subsídio de frete");
  assertRate(inputs.feePercentRate, "Taxa percentual do meio de pagamento");
  assertRate(inputs.otherRate, "Custos percentuais");
}

// Ex.: 0.0498 -> '4,98%'; 0.3 -> '30%'.
function formatRateBR(rate: number): string {
  const percent = Math.round(rate * 10000) / 100;
  return `${percent.toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%`;
}

function divisorLabel(inputs: PricingInputs): string {
  const terms = ["1"];
  if (inputs.feePercentRate > 0) {
    terms.push(`taxa ${formatRateBR(inputs.feePercentRate)}`);
  }
  if (inputs.otherRate > 0) {
    terms.push(`custos ${formatRateBR(inputs.otherRate)}`);
  }
  if (inputs.targetMarginRate > 0) {
    terms.push(`margem ${formatRateBR(inputs.targetMarginRate)}`);
  }
  return `Divisor (${terms.join(" − ")})`;
}

/**
 * Arredondamento psicológico.
 * - 'up' NUNCA reduz o preço: arredonda os reais para cima e aplica a
 *   terminação (contrato: 7383 → 7490 em to_90). Preço já na terminação
 *   exata é mantido (fronteira: 7390 → 7390).
 * - 'nearest' escolhe a terminação mais próxima (empate sobe); pode reduzir
 *   o preço bruto. Nunca produz valor <= 0.
 */
export function roundPsychological(
  priceCents: number,
  mode: RoundingMode,
  direction: RoundingDirection,
): number {
  if (mode === "none") return priceCents;
  const ending = ROUNDING_ENDING_CENTS[mode];
  const remainder = priceCents % 100;
  if (remainder === ending) return priceCents;

  if (direction === "up") {
    const wholeUpCents = Math.ceil(priceCents / 100) * 100;
    return ending === 0 ? wholeUpCents : wholeUpCents + ending;
  }

  // Maior candidato terminado em `ending` que é <= preço, e o seguinte.
  const lower = Math.floor((priceCents - ending) / 100) * 100 + ending;
  const upper = lower + 100;
  if (lower <= 0) return upper;
  return priceCents - lower < upper - priceCents ? lower : upper;
}

export function calculatePrice(inputs: PricingInputs): PricingResult {
  assertCostInputs(inputs);
  assertRate(inputs.targetMarginRate, "Margem alvo");

  const baseCents =
    inputs.costCents +
    inputs.otherFixedCents +
    inputs.feeFixedCents +
    inputs.shippingSubsidyCents;

  const divisor =
    1 - inputs.feePercentRate - inputs.otherRate - inputs.targetMarginRate;

  if (divisor <= MIN_DIVISOR) {
    throw new PricingError(
      `Precificação inviável: taxa ${formatRateBR(inputs.feePercentRate)} + ` +
        `custos ${formatRateBR(inputs.otherRate)} + ` +
        `margem alvo ${formatRateBR(inputs.targetMarginRate)} consomem ` +
        `praticamente todo o preço (sobra ${formatRateBR(Math.max(divisor, 0))} ` +
        `para cobrir os custos). Reduza a margem alvo ou renegocie as taxas.`,
    );
  }

  const rawPriceCents = Math.ceil(baseCents / divisor);
  const priceCents = roundPsychological(
    rawPriceCents,
    inputs.rounding.mode,
    inputs.rounding.direction,
  );

  const variableCostCents = Math.round(
    priceCents * (inputs.feePercentRate + inputs.otherRate),
  );
  const effectiveMarginCents = priceCents - baseCents - variableCostCents;
  const feeEstimatedCents =
    Math.round(priceCents * inputs.feePercentRate) + inputs.feeFixedCents;
  const netReceivableCents = priceCents - feeEstimatedCents;
  const effectiveMarginRate =
    priceCents === 0
      ? 0
      : Math.round((effectiveMarginCents / priceCents) * 10000) / 10000;

  const steps: BreakdownStep[] = [
    { label: "Custo do produto", valueCents: inputs.costCents },
    { label: "Custos fixos (embalagem)", valueCents: inputs.otherFixedCents },
    {
      label: "Tarifa fixa (meio de pagamento)",
      valueCents: inputs.feeFixedCents,
    },
    { label: "Subsídio de frete", valueCents: inputs.shippingSubsidyCents },
    { label: "Base de custos", valueCents: baseCents },
    { label: divisorLabel(inputs), value: divisor },
    { label: "Preço bruto calculado", valueCents: rawPriceCents },
  ];
  if (inputs.rounding.mode !== "none") {
    steps.push({
      label: `Arredondamento ${ROUNDING_MODE_LABEL[inputs.rounding.mode]} (${ROUNDING_DIRECTION_LABEL[inputs.rounding.direction]})`,
      valueCents: priceCents,
    });
  }

  return {
    priceCents,
    effectiveMarginRate,
    breakdown: {
      formula: FORMULA,
      inputs: { ...inputs, rounding: { ...inputs.rounding } },
      steps,
      output: {
        priceCents,
        effectiveMarginCents,
        effectiveMarginRate,
        feeEstimatedCents,
        netReceivableCents,
      },
      engineVersion: ENGINE_VERSION,
    },
  };
}

/**
 * Inverso da calculadora: qual margem efetiva resulta deste preço.
 * Mesma aritmética de centavos do calculatePrice (4 casas decimais);
 * pode ser negativa quando o preço não cobre os custos.
 */
export function suggestMarginForPrice(
  inputs: Omit<PricingInputs, "targetMarginRate">,
  desiredPriceCents: number,
): number {
  assertCostInputs(inputs);
  assertCents(desiredPriceCents);
  if (desiredPriceCents <= 0) {
    throw new PricingError(
      `O preço desejado deve ser maior que zero (recebido: ${desiredPriceCents} centavos).`,
    );
  }

  const baseCents =
    inputs.costCents +
    inputs.otherFixedCents +
    inputs.feeFixedCents +
    inputs.shippingSubsidyCents;
  const variableCostCents = Math.round(
    desiredPriceCents * (inputs.feePercentRate + inputs.otherRate),
  );
  const marginCents = desiredPriceCents - baseCents - variableCostCents;
  return Math.round((marginCents / desiredPriceCents) * 10000) / 10000;
}
