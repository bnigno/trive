// A faixa que deixa uma peça sozinha sem frete (Benevides, out/2026: 8 kg
// digitado no peso mínimo — 11 dias de "Correios" para quem é do motoboy).
import { describe, expect, it } from "vitest";

import { oneItemCoverageGaps, type CoverageRate } from "@/core/shipping/rate-coverage";

const ONE_ITEM = 300;

function rate(over: Partial<CoverageRate> & { name: string }): CoverageRate {
  return { kind: "motoboy", cepStart: "68795000", cepEnd: "68797999", weightMinGrams: 0, weightMaxGrams: 20000, isActive: true, ...over };
}

describe("oneItemCoverageGaps", () => {
  it("peso mínimo de 8 kg sem outra faixa para os mesmos CEPs: aponta a faixa", () => {
    const benevides = rate({ name: "Motoboy Benevides", weightMinGrams: 8000 });
    const belem = rate({ name: "Motoboy Belém", cepStart: "66000000", cepEnd: "66999999" });
    expect(oneItemCoverageGaps([belem, benevides], ONE_ITEM)).toEqual([benevides]);
  });

  it("peso máximo abaixo de uma peça também deixa a peça sem frete", () => {
    const tiny = rate({ name: "Motoboy Benevides", weightMaxGrams: 200 });
    expect(oneItemCoverageGaps([tiny], ONE_ITEM)).toEqual([tiny]);
  });

  it("faixa pesada é legítima quando outra faixa ativa cobre as sacolas leves nos mesmos CEPs", () => {
    const leve = rate({ name: "Motoboy Benevides", weightMaxGrams: 7999 });
    const pesada = rate({ name: "Motoboy Benevides (pesado)", weightMinGrams: 8000 });
    expect(oneItemCoverageGaps([leve, pesada], ONE_ITEM)).toEqual([]);
  });

  it("a cobertura pode vir de várias faixas emendadas, de qualquer tipo; um buraco no meio ainda aponta", () => {
    const pesada = rate({ name: "Pesado região", cepStart: "66000000", cepEnd: "68999999", weightMinGrams: 8000 });
    const a = rate({ name: "A", cepStart: "66000000", cepEnd: "67999999" });
    const b = rate({ name: "B", kind: "correios", cepStart: "68000000", cepEnd: "68999999" });
    expect(oneItemCoverageGaps([pesada, a, b], ONE_ITEM)).toEqual([]);
    const comBuraco = rate({ name: "B", kind: "correios", cepStart: "68000001", cepEnd: "68999999" });
    expect(oneItemCoverageGaps([pesada, a, comBuraco], ONE_ITEM)).toEqual([pesada]);
  });

  it("faixa inativa não é apontada nem cobre ninguém", () => {
    const pesadaInativa = rate({ name: "Pesada inativa", weightMinGrams: 8000, isActive: false });
    expect(oneItemCoverageGaps([pesadaInativa], ONE_ITEM)).toEqual([]);
    const pesada = rate({ name: "Pesada", weightMinGrams: 8000 });
    const leveInativa = rate({ name: "Leve inativa", weightMaxGrams: 7999, isActive: false });
    expect(oneItemCoverageGaps([pesada, leveInativa], ONE_ITEM)).toEqual([pesada]);
  });

  it("uma peça exatamente no limite cabe (fronteiras inclusivas, como na cotação)", () => {
    expect(oneItemCoverageGaps([rate({ name: "x", weightMinGrams: 300 })], ONE_ITEM)).toEqual([]);
    expect(oneItemCoverageGaps([rate({ name: "x", weightMaxGrams: 300 })], ONE_ITEM)).toEqual([]);
  });
});
