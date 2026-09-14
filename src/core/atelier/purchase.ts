// Da proposta às linhas da compra — PURO. "três de cada" com custo por peça
// vira uma linha por variação (quantidade × custo); um total só cabe quando
// a peça tem UMA variação. Sem quantidade, não há compra: a ficha nasce sem
// estoque e a dona lança pelo painel.
import { formatCentsBRL } from "@/lib/money";

export type PurchaseVariant = { id: string; sku: string };

export type PurchaseLine = { variantId: string; sku: string; quantity: number; unitCostCents: number | null };

export type PurchasePlan =
  | { kind: "lines"; lines: PurchaseLine[]; totalQuantity: number; totalCents: number | null }
  | { kind: "none"; reason: "sem_quantidade" | "total_sem_grade" | "sem_variacoes" };

export function purchaseLinesFromVariants(
  variants: readonly PurchaseVariant[],
  proposal: { quantityPerVariant: number | null; totalQuantity: number | null; unitCostCents: number | null },
): PurchasePlan {
  if (variants.length === 0) return { kind: "none", reason: "sem_variacoes" };
  const unitCostCents = proposal.unitCostCents !== null && proposal.unitCostCents > 0 ? proposal.unitCostCents : null;

  let quantities: number[];
  if (proposal.quantityPerVariant !== null && proposal.quantityPerVariant > 0) {
    quantities = variants.map(() => proposal.quantityPerVariant as number);
  } else if (proposal.totalQuantity !== null && proposal.totalQuantity > 0) {
    // "vieram 20 peças" sem dizer de cada: só dá para lançar numa peça simples.
    if (variants.length !== 1) return { kind: "none", reason: "total_sem_grade" };
    quantities = [proposal.totalQuantity];
  } else {
    return { kind: "none", reason: "sem_quantidade" };
  }

  const lines = variants.map((variant, index) => ({
    variantId: variant.id,
    sku: variant.sku,
    quantity: quantities[index],
    unitCostCents,
  }));
  const totalQuantity = quantities.reduce((sum, quantity) => sum + quantity, 0);
  return {
    kind: "lines",
    lines,
    totalQuantity,
    totalCents: unitCostCents !== null ? unitCostCents * totalQuantity : null,
  };
}

/** "Compra: 24 peças de Longo Dunas — Aurora (Ateliê pelo WhatsApp)". */
export function purchaseDescription(input: { productName: string; totalQuantity: number; supplierName: string | null }): string {
  const pieces = input.totalQuantity === 1 ? "1 peça" : `${input.totalQuantity} peças`;
  return `Compra: ${pieces} de ${input.productName}${input.supplierName ? ` — ${input.supplierName}` : ""} (Ateliê pelo WhatsApp)`;
}

/** Linha do cartão além disto estoura a arte (Satori não quebra sozinho no rodapé). */
export const ATELIER_CARD_LINE_MAX_CHARS = 44;

function clampLine(line: string): string {
  return line.length > ATELIER_CARD_LINE_MAX_CHARS ? `${line.slice(0, ATELIER_CARD_LINE_MAX_CHARS - 1).trimEnd()}…` : line;
}

/** As linhas do cartão: "2 cores × 4 tamanhos", "24 peças · custo R$ 120,00", "Aurora · a pagar R$ 2.880,00". */
export function atelierCardLines(input: {
  colors: number;
  sizes: number;
  totalQuantity: number | null;
  unitCostCents: number | null;
  supplierName: string | null;
  payableCents: number | null;
}): string[] {
  const lines: string[] = [];
  const grid: string[] = [];
  if (input.colors > 0) grid.push(input.colors === 1 ? "1 cor" : `${input.colors} cores`);
  if (input.sizes > 0) grid.push(input.sizes === 1 ? "1 tamanho" : `${input.sizes} tamanhos`);
  if (grid.length > 0) lines.push(grid.join(" × "));
  const pieces: string[] = [];
  if (input.totalQuantity !== null) pieces.push(input.totalQuantity === 1 ? "1 peça" : `${input.totalQuantity} peças`);
  if (input.unitCostCents !== null) pieces.push(`custo ${formatCentsBRL(input.unitCostCents)}`);
  if (pieces.length > 0) lines.push(pieces.join(" · "));
  const money: string[] = [];
  if (input.supplierName) money.push(input.supplierName.length > 24 ? `${input.supplierName.slice(0, 23).trimEnd()}…` : input.supplierName);
  if (input.payableCents !== null) money.push(`a pagar ${formatCentsBRL(input.payableCents)}`);
  if (money.length > 0) lines.push(money.join(" · "));
  return lines.slice(0, 3).map(clampLine);
}
