import { describe, expect, it } from "vitest";

import {
  ENGINE_VERSION,
  PricingError,
  calculatePrice,
  roundPsychological,
  suggestMarginForPrice,
} from "../../../src/core/pricing/calculate";
import type { PricingInputs } from "../../../src/core/pricing/types";

// Cenário de referência: custo R$ 50,00 + embalagem R$ 2,00 + tarifa fixa
// R$ 0,40; taxa 4,98% + custos 2%; margem alvo 30% => divisor 0,6302.
function makeInputs(overrides: Partial<PricingInputs> = {}): PricingInputs {
  return {
    costCents: 5000,
    otherFixedCents: 200,
    otherRate: 0.02,
    feePercentRate: 0.0498,
    feeFixedCents: 40,
    shippingSubsidyCents: 0,
    targetMarginRate: 0.3,
    rounding: { mode: "none", direction: "up" },
    ...overrides,
  };
}

describe("calculatePrice", () => {
  it("custo zero: tudo zerado resulta em preço 0 sem NaN", () => {
    const result = calculatePrice(
      makeInputs({
        costCents: 0,
        otherFixedCents: 0,
        otherRate: 0,
        feePercentRate: 0,
        feeFixedCents: 0,
        targetMarginRate: 0,
      }),
    );
    expect(result.priceCents).toBe(0);
    expect(result.effectiveMarginRate).toBe(0);
    expect(result.breakdown.output.effectiveMarginCents).toBe(0);
    expect(result.breakdown.output.feeEstimatedCents).toBe(0);
    expect(result.breakdown.output.netReceivableCents).toBe(0);
  });

  it("custo zero: tarifa fixa ainda gera base e preço positivo", () => {
    const result = calculatePrice(makeInputs({ costCents: 0, otherFixedCents: 0 }));
    // base = 40; 40 / 0,6302 = 63,47 -> teto 64
    expect(result.priceCents).toBe(64);
    expect(result.priceCents).toBeGreaterThanOrEqual(40);
  });

  it("divisor inviável: margem + taxas >= 100% lança PricingError em pt-BR", () => {
    const invalido = makeInputs({
      feePercentRate: 0.5,
      otherRate: 0,
      targetMarginRate: 0.5,
    });
    expect(() => calculatePrice(invalido)).toThrow(PricingError);
    expect(() => calculatePrice(invalido)).toThrow(/inviável/);
    expect(() => calculatePrice(invalido)).toThrow(/margem/i);
  });

  it("divisor inviável: sobra menor que 1% também é rejeitada", () => {
    expect(() =>
      calculatePrice(
        makeInputs({ feePercentRate: 0.992, otherRate: 0, targetMarginRate: 0 }),
      ),
    ).toThrow(PricingError);
  });

  it("divisor apertado porém acima de 1% ainda calcula", () => {
    const result = calculatePrice(
      makeInputs({ feePercentRate: 0, otherRate: 0, targetMarginRate: 0.98 }),
    );
    // base = 5240; 5240 / 0,02 = 262000
    expect(result.priceCents).toBe(262000);
  });

  it("rejeita entradas inválidas (centavos fracionários, taxas fora de 0–1)", () => {
    expect(() => calculatePrice(makeInputs({ costCents: 10.5 }))).toThrow(
      RangeError,
    );
    expect(() => calculatePrice(makeInputs({ costCents: -100 }))).toThrow(
      PricingError,
    );
    expect(() => calculatePrice(makeInputs({ feePercentRate: 4.98 }))).toThrow(
      PricingError,
    );
    expect(() => calculatePrice(makeInputs({ targetMarginRate: -0.1 }))).toThrow(
      PricingError,
    );
  });

  it("taxa percentual + fixa: cenário completo com arredondamento ,90 para cima", () => {
    const result = calculatePrice(
      makeInputs({ rounding: { mode: "to_90", direction: "up" } }),
    );
    // base 5240; divisor 0,6302; bruto teto(8314,98) = 8315; ,90 up => 8490
    expect(result.priceCents).toBe(8490);
    expect(result.breakdown.output.feeEstimatedCents).toBe(463); // round(8490*4,98%) + 40
    expect(result.breakdown.output.netReceivableCents).toBe(8027);
    expect(result.breakdown.output.effectiveMarginCents).toBe(2657);
    expect(result.effectiveMarginRate).toBe(0.313);
    expect(result.effectiveMarginRate).toBe(
      result.breakdown.output.effectiveMarginRate,
    );
    expect(result.breakdown.engineVersion).toBe(ENGINE_VERSION);
    expect(ENGINE_VERSION).toBe("1.0.0");

    const labels = result.breakdown.steps.map((s) => s.label);
    expect(labels).toContain("Custo do produto");
    expect(labels).toContain("Custos fixos (embalagem)");
    expect(labels).toContain("Base de custos");
    expect(labels).toContain("Preço bruto calculado");
    expect(labels).toContain("Arredondamento ,90 (para cima)");

    const stepValue = (label: string) =>
      result.breakdown.steps.find((s) => s.label === label);
    expect(stepValue("Base de custos")?.valueCents).toBe(5240);
    expect(stepValue("Preço bruto calculado")?.valueCents).toBe(8315);
    expect(stepValue("Arredondamento ,90 (para cima)")?.valueCents).toBe(8490);
    expect(result.breakdown.inputs).toEqual(
      makeInputs({ rounding: { mode: "to_90", direction: "up" } }),
    );
  });

  it("rótulo do divisor em pt-BR omite termos zerados", () => {
    const result = calculatePrice(
      makeInputs({ otherFixedCents: 0, otherRate: 0, feeFixedCents: 0 }),
    );
    const divisorStep = result.breakdown.steps.find((s) =>
      s.label.startsWith("Divisor"),
    );
    expect(divisorStep?.label).toBe("Divisor (1 − taxa 4,98% − margem 30%)");
    expect(divisorStep?.value).toBeCloseTo(0.6502, 10);
    // base 5000; 5000/0,6502 = 7689,9 -> 7690; margem efetiva exatamente 30%
    expect(result.priceCents).toBe(7690);
    expect(result.effectiveMarginRate).toBe(0.3);
    expect(result.breakdown.output.netReceivableCents).toBe(7307);
  });

  it("modo none não gera passo de arredondamento e mantém o preço bruto", () => {
    const result = calculatePrice(makeInputs());
    expect(result.priceCents).toBe(8315);
    expect(
      result.breakdown.steps.some((s) => s.label.startsWith("Arredondamento")),
    ).toBe(false);
  });

  it("breakdown soma consistente: netReceivable − custos − outros = margem", () => {
    const inputs = makeInputs({ rounding: { mode: "to_99", direction: "up" } });
    const result = calculatePrice(inputs);
    const { output } = result.breakdown;
    const price = result.priceCents;
    const nonFeeBase =
      inputs.costCents + inputs.otherFixedCents + inputs.shippingSubsidyCents;
    // 'outros' percentuais: total variável menos a parte percentual da taxa
    // (a tarifa fixa já está descontada dentro do netReceivable).
    const totalVariable = Math.round(
      price * (inputs.feePercentRate + inputs.otherRate),
    );
    const feeVariable = output.feeEstimatedCents - inputs.feeFixedCents;
    expect(
      output.netReceivableCents - nonFeeBase - (totalVariable - feeVariable),
    ).toBe(output.effectiveMarginCents);
    expect(output.netReceivableCents).toBe(price - output.feeEstimatedCents);
  });
});

describe("roundPsychological — matriz de arredondamento", () => {
  it("none mantém o valor", () => {
    expect(roundPsychological(7383, "none", "up")).toBe(7383);
    expect(roundPsychological(7383, "none", "nearest")).toBe(7383);
  });

  describe("direction 'up' (nunca reduz: arredonda os reais para cima e aplica a terminação)", () => {
    it("to_90: exemplo do contrato 7383 → 7490", () => {
      expect(roundPsychological(7383, "to_90", "up")).toBe(7490);
    });
    it("to_90: fronteira — já termina em 90 permanece", () => {
      expect(roundPsychological(7390, "to_90", "up")).toBe(7390);
    });
    it("to_90: real cheio sobe apenas os centavos", () => {
      expect(roundPsychological(7300, "to_90", "up")).toBe(7390);
    });
    it("to_90: um centavo após o real cheio vai ao ,90 do real seguinte", () => {
      expect(roundPsychological(7401, "to_90", "up")).toBe(7590);
      expect(roundPsychological(7391, "to_90", "up")).toBe(7490);
    });
    it("to_99", () => {
      expect(roundPsychological(7383, "to_99", "up")).toBe(7499);
      expect(roundPsychological(7399, "to_99", "up")).toBe(7399);
      expect(roundPsychological(7400, "to_99", "up")).toBe(7499);
    });
    it("to_50", () => {
      expect(roundPsychological(7383, "to_50", "up")).toBe(7450);
      expect(roundPsychological(7350, "to_50", "up")).toBe(7350);
      expect(roundPsychological(7449, "to_50", "up")).toBe(7550);
    });
    it("integer", () => {
      expect(roundPsychological(7383, "integer", "up")).toBe(7400);
      expect(roundPsychological(7400, "integer", "up")).toBe(7400);
      expect(roundPsychological(7401, "integer", "up")).toBe(7500);
    });
  });

  describe("direction 'nearest' (terminação mais próxima; empate sobe)", () => {
    it("to_90", () => {
      expect(roundPsychological(7383, "to_90", "nearest")).toBe(7390);
      expect(roundPsychological(7335, "to_90", "nearest")).toBe(7290);
      expect(roundPsychological(7340, "to_90", "nearest")).toBe(7390); // empate
      expect(roundPsychological(7390, "to_90", "nearest")).toBe(7390); // fronteira
    });
    it("to_99", () => {
      expect(roundPsychological(7348, "to_99", "nearest")).toBe(7299);
      expect(roundPsychological(7350, "to_99", "nearest")).toBe(7399);
      expect(roundPsychological(7399, "to_99", "nearest")).toBe(7399);
    });
    it("to_50", () => {
      expect(roundPsychological(7383, "to_50", "nearest")).toBe(7350);
      expect(roundPsychological(7326, "to_50", "nearest")).toBe(7350);
      expect(roundPsychological(7275, "to_50", "nearest")).toBe(7250);
    });
    it("integer", () => {
      expect(roundPsychological(7449, "integer", "nearest")).toBe(7400);
      expect(roundPsychological(7450, "integer", "nearest")).toBe(7500); // empate
      expect(roundPsychological(7383, "integer", "nearest")).toBe(7400);
    });
    it("valores pequenos nunca caem para <= 0", () => {
      expect(roundPsychological(30, "to_90", "nearest")).toBe(90);
      expect(roundPsychological(30, "integer", "nearest")).toBe(100);
    });
  });
});

describe("efeito do arredondamento na margem real", () => {
  // custo 4000, taxa 5%, margem alvo 25% => divisor 0,70; bruto = 5715
  const inputs = makeInputs({
    costCents: 4000,
    otherFixedCents: 0,
    otherRate: 0,
    feePercentRate: 0.05,
    feeFixedCents: 0,
    targetMarginRate: 0.25,
  });

  it("nearest pode reduzir o preço e derrubar a margem abaixo do alvo", () => {
    const result = calculatePrice({
      ...inputs,
      rounding: { mode: "to_99", direction: "nearest" },
    });
    expect(result.priceCents).toBe(5699); // 5715 -> ,99 mais próximo abaixo
    expect(result.effectiveMarginRate).toBe(0.2481);
    expect(result.effectiveMarginRate).toBeLessThan(0.25);
  });

  it("up só aumenta o preço e preserva a margem alvo", () => {
    const result = calculatePrice({
      ...inputs,
      rounding: { mode: "to_99", direction: "up" },
    });
    expect(result.priceCents).toBe(5899);
    expect(result.effectiveMarginRate).toBe(0.2719);
    expect(result.effectiveMarginRate).toBeGreaterThanOrEqual(0.25);
  });
});

describe("suggestMarginForPrice", () => {
  const { targetMarginRate: _ignored, ...noMargin } = makeInputs();

  it("retorna a margem efetiva que o preço desejado produz", () => {
    // base 5240; preço R$ 99,90: variável = round(9990*6,98%) = 697
    // margem = (9990 - 5240 - 697) / 9990 = 0,4057
    expect(suggestMarginForPrice(noMargin, 9990)).toBe(0.4057);
  });

  it("coincide exatamente com a margem efetiva de calculatePrice", () => {
    const result = calculatePrice(makeInputs());
    expect(suggestMarginForPrice(noMargin, result.priceCents)).toBe(
      result.effectiveMarginRate,
    );
  });

  it("preço abaixo dos custos produz margem negativa (informativa)", () => {
    expect(suggestMarginForPrice(noMargin, 4000)).toBeLessThan(0);
  });

  it("rejeita preço desejado <= 0", () => {
    expect(() => suggestMarginForPrice(noMargin, 0)).toThrow(PricingError);
    expect(() => suggestMarginForPrice(noMargin, -100)).toThrow(PricingError);
  });
});
