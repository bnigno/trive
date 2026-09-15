// Etiquetas da peça (tag com nome, cor/tamanho, SKU e preço) para imprimir em
// folha A4. Aqui só a conta: quantas de cada variação, em que ordem e como
// se repartem em folhas. A folha em si (medidas, CSS) é da página.
import { variantLabel } from "./attributes";

/** Uma variação não pede mais do que isso de uma vez: acima é engano de digitação. */
export const LABELS_MAX_PER_VARIANT = 200;
/** 20 folhas. Mais do que isso trava o diálogo de impressão sem avisar. */
export const LABELS_MAX_TOTAL = 480;
/** 3 colunas × 8 linhas de 63,5 × 33,9 mm (Avery L7159 / Pimaco A4356). */
export const LABELS_PER_SHEET = 24;

export interface LabelVariant {
  id: string;
  sku: string;
  attributes: Record<string, string>;
  isActive: boolean;
  priceCents: number | null;
}

export interface ProductLabel {
  /** Estável entre renderizações: `${variantId}:${índice}`. */
  key: string;
  storeName: string;
  productName: string;
  /** "Verde · P" — vazio quando o produto não tem eixos. */
  variantLabel: string;
  sku: string;
  priceCents: number | null;
}

export interface LabelLine {
  variantId: string;
  sku: string;
  variantLabel: string;
  isActive: boolean;
  priceCents: number | null;
  quantity: number;
}

export interface LabelPlan {
  /** Uma por variação, na ordem recebida, com a quantidade que valeu. */
  lines: LabelLine[];
  labels: ProductLabel[];
  sheets: ProductLabel[][];
  /** O pedido passou de LABELS_MAX_TOTAL e foi cortado. */
  truncated: boolean;
  /** SKUs pedidos sem preço ativo: a etiqueta sai sem preço. */
  withoutPrice: string[];
}

/**
 * `quantities` null é o padrão (uma etiqueta por variação ativa). Com
 * quantidades explícitas só entra o que veio — inclusive variação inativa,
 * que o dono pode ter em mãos mesmo fora da loja. Id que não é do produto é
 * ignorado; quantidade fora de [0, LABELS_MAX_PER_VARIANT] é aparada; o total
 * é cortado em LABELS_MAX_TOTAL a partir das últimas variações.
 */
export function planProductLabels(input: {
  storeName: string;
  productName: string;
  axes: readonly string[];
  variants: readonly LabelVariant[];
  quantities: Record<string, number> | null;
}): LabelPlan {
  let remaining = LABELS_MAX_TOTAL;
  let truncated = false;
  const lines: LabelLine[] = input.variants.map((variant) => {
    const wanted =
      input.quantities === null
        ? variant.isActive
          ? 1
          : 0
        : clampQuantity(input.quantities[variant.id] ?? 0);
    const quantity = Math.min(wanted, remaining);
    if (quantity < wanted) truncated = true;
    remaining -= quantity;
    return {
      variantId: variant.id,
      sku: variant.sku,
      variantLabel: variantLabel(variant.attributes, input.axes),
      isActive: variant.isActive,
      priceCents: variant.priceCents,
      quantity,
    };
  });

  const labels: ProductLabel[] = [];
  for (const line of lines) {
    for (let i = 0; i < line.quantity; i++) {
      labels.push({
        key: `${line.variantId}:${i}`,
        storeName: input.storeName,
        productName: input.productName,
        variantLabel: line.variantLabel,
        sku: line.sku,
        priceCents: line.priceCents,
      });
    }
  }

  const sheets: ProductLabel[][] = [];
  for (let start = 0; start < labels.length; start += LABELS_PER_SHEET) {
    sheets.push(labels.slice(start, start + LABELS_PER_SHEET));
  }

  return {
    lines,
    labels,
    sheets,
    truncated,
    withoutPrice: lines
      .filter((line) => line.quantity > 0 && line.priceCents === null)
      .map((line) => line.sku),
  };
}

function clampQuantity(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(LABELS_MAX_PER_VARIANT, Math.max(0, Math.trunc(value)));
}
