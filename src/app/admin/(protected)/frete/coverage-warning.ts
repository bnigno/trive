import { oneItemCoverageGaps, type CoverageRate } from "@/core/shipping/rate-coverage";
import { formatCep } from "@/lib/cep";
import { formatKg } from "@/lib/weight";
import { DEFAULT_ITEM_WEIGHT_GRAMS } from "@/services/store-catalog";

/** As faixas que deixam uma peça sozinha sem frete, cada uma com o aviso em pt-BR para a dona. */
export function oneItemGapWarnings<T extends CoverageRate & { id: string }>(rates: readonly T[]): { id: string; text: string }[] {
  const oneItem = DEFAULT_ITEM_WEIGHT_GRAMS;
  return oneItemCoverageGaps(rates, oneItem).map((rate) => ({
    id: rate.id,
    text:
      `${rate.name} só aceita sacolas de ${formatKg(rate.weightMinGrams)} a ${formatKg(rate.weightMaxGrams)}, e nenhuma outra faixa ativa cobre ` +
      `os CEPs ${formatCep(rate.cepStart)} a ${formatCep(rate.cepEnd)} para uma peça (cerca de ${formatKg(oneItem)}): lá o site e a Lia dizem ` +
      `"frete pela equipe" e a cliente não fecha sozinha. Se não foi de propósito, ` +
      (rate.weightMinGrams > oneItem ? "ponha 0 em Peso mínimo (kg)." : "aumente o Peso máximo (kg)."),
  }));
}
