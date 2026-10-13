import { oneItemCoverageGaps, type CoverageRate } from "@/core/shipping/rate-coverage";
import { formatCep } from "@/lib/cep";
import { formatKg } from "@/lib/weight";
import { isCorreiosQuotesConfigured } from "@/adapters/superfrete";
import type { CorreiosAutoSettings } from "@/services/correios-quotes";
import { DEFAULT_ITEM_WEIGHT_GRAMS } from "@/services/store-catalog";

/**
 * As faixas que deixam uma peça sozinha sem frete, cada uma com o aviso em
 * pt-BR para a dona. Com o Correios automático ligado, a faixa de Correios
 * não é acusada: sem ela, a SuperFrete cota PAC/SEDEX na hora.
 */
export function oneItemGapWarnings<T extends CoverageRate & { id: string }>(
  rates: readonly T[],
  options: { correiosAuto: boolean },
): { id: string; text: string }[] {
  const oneItem = DEFAULT_ITEM_WEIGHT_GRAMS;
  return oneItemCoverageGaps(rates, oneItem)
    .filter((rate) => rate.kind === "motoboy" || !options.correiosAuto)
    .map((rate) => ({
      id: rate.id,
      text:
        `${rate.name} só aceita sacolas de ${formatKg(rate.weightMinGrams)} a ${formatKg(rate.weightMaxGrams)}, e nenhuma outra faixa ` +
        `${rate.kind === "motoboy" ? "de motoboy " : ""}ativa cobre os CEPs ${formatCep(rate.cepStart)} a ${formatCep(rate.cepEnd)} ` +
        `para uma peça (cerca de ${formatKg(oneItem)}): ` +
        (rate.kind === "motoboy"
          ? "lá a cliente não vê o motoboy e não fecha sozinha. "
          : `lá o site e a Lia dizem "frete pela equipe" e a cliente não fecha sozinha. `) +
        "Se não foi de propósito, " +
        (rate.weightMinGrams > oneItem ? "ponha 0 em Peso mínimo (kg)." : "aumente o Peso máximo (kg)."),
    }));
}

/** O Correios automático cota de verdade? Interruptor, CEP de origem e token. */
export function correiosAutoActive(settings: CorreiosAutoSettings): boolean {
  return settings.enabled && settings.storeCep !== null && isCorreiosQuotesConfigured();
}
