import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  calculatePrice,
  suggestMarginForPrice,
} from "../../../src/core/pricing/calculate";
import type {
  PricingInputs,
  RoundingMode,
} from "../../../src/core/pricing/types";

// Taxas em grade de 4 casas (mesma precisão do motor); somas máximas
// 0,30 + 0,10 + 0,55 = 0,95 garantem divisor >= 0,05 (sempre viável).
const rateArb = (maxRate: number) =>
  fc
    .integer({ min: 0, max: Math.round(maxRate * 10000) })
    .map((n) => n / 10000);

const baseInputsArb = fc.record({
  costCents: fc.integer({ min: 1, max: 1_000_000 }),
  otherFixedCents: fc.integer({ min: 0, max: 100_000 }),
  otherRate: rateArb(0.1),
  feePercentRate: rateArb(0.3),
  feeFixedCents: fc.integer({ min: 0, max: 10_000 }),
  shippingSubsidyCents: fc.integer({ min: 0, max: 50_000 }),
  targetMarginRate: rateArb(0.55),
});

const psychologicalModeArb = fc.constantFrom<Exclude<RoundingMode, "none">>(
  "to_90",
  "to_99",
  "to_50",
  "integer",
);

type BaseInputs = Omit<PricingInputs, "rounding">;

function baseCentsOf(inputs: BaseInputs): number {
  return (
    inputs.costCents +
    inputs.otherFixedCents +
    inputs.feeFixedCents +
    inputs.shippingSubsidyCents
  );
}

function marginCentsAt(inputs: BaseInputs, priceCents: number): number {
  return (
    priceCents -
    baseCentsOf(inputs) -
    Math.round(priceCents * (inputs.feePercentRate + inputs.otherRate))
  );
}

describe("propriedades do motor de precificação", () => {
  it("(a) direction 'up': o preço só sobe e a margem nunca fica abaixo do alvo", () => {
    fc.assert(
      fc.property(baseInputsArb, psychologicalModeArb, (base, mode) => {
        const result = calculatePrice({
          ...base,
          rounding: { mode, direction: "up" },
        });
        const rawStep = result.breakdown.steps.find(
          (s) => s.label === "Preço bruto calculado",
        );
        const rawPrice = rawStep?.valueCents;
        expect(rawPrice).toBeDefined();
        if (rawPrice === undefined) return;

        // Prova em duas partes: (1) 'up' nunca reduz o preço bruto;
        // (2) margem em centavos é monótona no preço (f < 1), logo
        // arredondar para cima nunca reduz a margem.
        expect(result.priceCents).toBeGreaterThanOrEqual(rawPrice);
        const marginCents = result.breakdown.output.effectiveMarginCents;
        expect(marginCents).toBeGreaterThanOrEqual(
          marginCentsAt(base, rawPrice),
        );

        // Cota provável exata: margem >= alvo*preço - 0,5 centavo
        // (o único desvio possível é o round() sub-centavo das taxas).
        expect(marginCents).toBeGreaterThanOrEqual(
          base.targetMarginRate * result.priceCents - 0.5 - 1e-9,
        );
        expect(result.effectiveMarginRate).toBeGreaterThanOrEqual(
          base.targetMarginRate - 0.5 / result.priceCents - 0.0001,
        );
      }),
      { numRuns: 300 },
    );
  });

  it("(b) suggestMarginForPrice ∘ calculatePrice é coerente (±0,0002)", () => {
    fc.assert(
      fc.property(baseInputsArb, (base) => {
        const rounding = { mode: "none", direction: "up" } as const;
        const result = calculatePrice({ ...base, rounding });
        const { targetMarginRate: _target, ...withoutMargin } = base;
        const suggested = suggestMarginForPrice(
          { ...withoutMargin, rounding },
          result.priceCents,
        );
        expect(
          Math.abs(suggested - result.effectiveMarginRate),
        ).toBeLessThanOrEqual(0.0002);
        // Com teto no preço bruto, a margem sugerida nunca fica
        // materialmente abaixo do alvo pedido.
        expect(suggested).toBeGreaterThanOrEqual(
          base.targetMarginRate - 0.5 / result.priceCents - 0.0001,
        );
      }),
      { numRuns: 300 },
    );
  });

  it("(c) priceCents >= base sempre que o preço não é reduzido (up ou none)", () => {
    fc.assert(
      fc.property(
        baseInputsArb,
        fc.constantFrom<RoundingMode>("none", "to_90", "to_99", "to_50", "integer"),
        (base, mode) => {
          const result = calculatePrice({
            ...base,
            rounding: { mode, direction: "up" },
          });
          expect(result.priceCents).toBeGreaterThanOrEqual(baseCentsOf(base));
        },
      ),
      { numRuns: 300 },
    );
  });

  it("(c') 'nearest' fica a menos de 1 real do bruto e nunca chega a zero", () => {
    fc.assert(
      fc.property(baseInputsArb, psychologicalModeArb, (base, mode) => {
        const result = calculatePrice({
          ...base,
          rounding: { mode, direction: "nearest" },
        });
        const rawPrice = result.breakdown.steps.find(
          (s) => s.label === "Preço bruto calculado",
        )?.valueCents;
        expect(rawPrice).toBeDefined();
        if (rawPrice === undefined) return;
        expect(Math.abs(result.priceCents - rawPrice)).toBeLessThan(100);
        expect(result.priceCents).toBeGreaterThan(0);
      }),
      { numRuns: 300 },
    );
  });

  it("todos os valores monetários são inteiros seguros e o breakdown fecha", () => {
    fc.assert(
      fc.property(
        baseInputsArb,
        fc.constantFrom<RoundingMode>("none", "to_90", "to_99", "to_50", "integer"),
        fc.constantFrom("up", "nearest") as fc.Arbitrary<"up" | "nearest">,
        (base, mode, direction) => {
          const result = calculatePrice({
            ...base,
            rounding: { mode, direction },
          });
          const { output } = result.breakdown;
          for (const value of [
            result.priceCents,
            output.priceCents,
            output.effectiveMarginCents,
            output.feeEstimatedCents,
            output.netReceivableCents,
          ]) {
            expect(Number.isSafeInteger(value)).toBe(true);
          }

          // Identidade exata: netReceivable − custos (sem tarifa fixa)
          // − outros percentuais = margem efetiva.
          const nonFeeBase =
            base.costCents + base.otherFixedCents + base.shippingSubsidyCents;
          const totalVariable = Math.round(
            result.priceCents * (base.feePercentRate + base.otherRate),
          );
          const feeVariable = output.feeEstimatedCents - base.feeFixedCents;
          expect(
            output.netReceivableCents -
              nonFeeBase -
              (totalVariable - feeVariable),
          ).toBe(output.effectiveMarginCents);
          expect(output.netReceivableCents).toBe(
            result.priceCents - output.feeEstimatedCents,
          );

          // Margem efetiva com 4 casas decimais.
          expect(output.effectiveMarginRate).toBe(
            Math.round(output.effectiveMarginRate * 10000) / 10000,
          );
        },
      ),
      { numRuns: 300 },
    );
  });
});
