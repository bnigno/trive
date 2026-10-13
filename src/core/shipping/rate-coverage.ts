// Faixa que deixa UMA peça sem frete: a sacola de uma peça não cabe no peso da
// faixa e nenhuma outra faixa ativa cobre os mesmos CEPs para ela. O site e a
// Lia caem no "frete pela equipe" — foi assim que Benevides ficou 11 dias sem
// motoboy (8 kg digitado no peso mínimo, out/2026).
import type { ShippingKind } from "./delivery-windows";

export interface CoverageRate {
  name: string;
  kind: ShippingKind;
  cepStart: string;
  cepEnd: string;
  weightMinGrams: number;
  weightMaxGrams: number;
  isActive: boolean;
}

function accepts(rate: CoverageRate, grams: number): boolean {
  return rate.weightMinGrams <= grams && grams <= rate.weightMaxGrams;
}

/** O intervalo de CEP [start, end] inteiro está na união das faixas? */
function cepRangeCovered(start: string, end: string, rates: readonly CoverageRate[]): boolean {
  let next = Number(start);
  const last = Number(end);
  for (const rate of [...rates].sort((a, b) => Number(a.cepStart) - Number(b.cepStart))) {
    if (Number(rate.cepEnd) < next) continue;
    if (Number(rate.cepStart) > next) return false;
    next = Number(rate.cepEnd) + 1;
    if (next > last) return true;
  }
  return next > last;
}

/**
 * As faixas ativas que não aceitam uma sacola de `oneItemGrams` e cujos CEPs
 * nenhuma outra faixa ativa cobre com esse peso. Peso mínimo acima de zero é
 * legítimo quando outra faixa cuida das sacolas leves — aí não aparece aqui.
 * Faixa de motoboy só é coberta por motoboy: uma de Correios por baixo faria
 * a peça de quem é do motoboy sair pelos Correios.
 */
export function oneItemCoverageGaps<T extends CoverageRate>(rates: readonly T[], oneItemGrams: number): T[] {
  const active = rates.filter((rate) => rate.isActive);
  const covering = active.filter((rate) => accepts(rate, oneItemGrams));
  const motoboyCovering = covering.filter((rate) => rate.kind === "motoboy");
  return active.filter(
    (rate) =>
      !accepts(rate, oneItemGrams) &&
      !cepRangeCovered(rate.cepStart, rate.cepEnd, rate.kind === "motoboy" ? motoboyCovering : covering),
  );
}
