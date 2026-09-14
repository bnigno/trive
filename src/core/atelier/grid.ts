// Da proposta interpretada à grade de variações que o catálogo cria — PURO.
// Reusa a mesma grade do cadastro (cor × tamanho, rótulos e SKUs), com o
// custo por peça em cada variação. O estoque NÃO entra aqui: a chegada vira
// compra (movimentos + conta a pagar) no passo seguinte do Ateliê.
import { buildVariantGrid, gridAxes, type SelectedVariant } from "@/core/catalog/variant-grid";

import type { ArrivalProposal } from "./proposal";

export function expandArrivalGrid(
  name: string,
  proposal: Pick<ArrivalProposal, "colors" | "sizes" | "unitCostCents" | "weightGrams">,
): { axes: string[]; variants: SelectedVariant[] } {
  const grid = buildVariantGrid({ name, colors: proposal.colors, sizes: proposal.sizes });
  const axes = gridAxes(proposal.colors, proposal.sizes);
  const variants = grid.combinations.map((combination) => ({
    sku: combination.sku,
    attributes: combination.attributes,
    initialQuantity: 0,
    ...(proposal.unitCostCents !== null ? { costCents: proposal.unitCostCents } : {}),
    ...(proposal.weightGrams !== null ? { weightGrams: proposal.weightGrams } : {}),
  }));
  return { axes, variants };
}
