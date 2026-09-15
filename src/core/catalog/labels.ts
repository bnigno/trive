// Etiquetas da peça para imprimir em folha A4: a tag de cabide (cartão com
// a marca na frente e nome, cor/tamanho, SKU e QR atrás) e a adesiva (SKU e
// preço). Aqui só a conta: quantas de cada variação, em que ordem e como se
// repartem em folhas. A folha em si (medidas, CSS) é da página.
import { estimateLines } from "@/core/edition/layout";

import { variantLabel } from "./attributes";

export type LabelModel = "cabide" | "adesiva";

/** Uma variação não pede mais do que isso de uma vez: acima é engano de digitação. */
export const LABELS_MAX_PER_VARIANT = 200;
/** 20 folhas. Mais do que isso trava o diálogo de impressão sem avisar. */
export const LABELS_MAX_SHEETS = 20;
/**
 * Capacidade da folha A4: 3 × 8 adesivas de 63,5 × 33,9 mm (Avery L7159 /
 * Pimaco A4356) ou 3 × 3 tags de cabide de 55 × 90 mm.
 */
export const LABELS_PER_SHEET: Record<LabelModel, number> = { adesiva: 24, cabide: 9 };

export function labelsMaxTotal(model: LabelModel): number {
  return LABELS_PER_SHEET[model] * LABELS_MAX_SHEETS;
}

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
  /** "100% linho · forro 100% viscose" — null quando não cadastrada. */
  composition: string | null;
  /** Página da peça no site: é para onde o QR da tag leva. */
  productUrl: string;
}

/** Um modelo por variação pedida: a gráfica imprime `quantity` de cada. */
export type LabelDesign = ProductLabel & { quantity: number };

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
  /** Um por variação com quantidade > 0 (chave = id da variação). */
  designs: LabelDesign[];
  /** O pedido passou de labelsMaxTotal(model) e foi cortado. */
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
  model: LabelModel;
  storeName: string;
  productName: string;
  composition: string | null;
  productUrl: string;
  axes: readonly string[];
  variants: readonly LabelVariant[];
  quantities: Record<string, number> | null;
}): LabelPlan {
  let remaining = labelsMaxTotal(input.model);
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

  const labelOf = (line: LabelLine, key: string): ProductLabel => ({
    key,
    storeName: input.storeName,
    productName: input.productName,
    variantLabel: line.variantLabel,
    sku: line.sku,
    priceCents: line.priceCents,
    composition: input.composition,
    productUrl: input.productUrl,
  });
  const labels: ProductLabel[] = [];
  for (const line of lines) {
    for (let i = 0; i < line.quantity; i++) {
      labels.push(labelOf(line, `${line.variantId}:${i}`));
    }
  }
  const designs: LabelDesign[] = lines
    .filter((line) => line.quantity > 0)
    .map((line) => ({ ...labelOf(line, line.variantId), quantity: line.quantity }));

  const perSheet = LABELS_PER_SHEET[input.model];
  const sheets: ProductLabel[][] = [];
  for (let start = 0; start < labels.length; start += perSheet) {
    sheets.push(labels.slice(start, start + perSheet));
  }

  return {
    lines,
    labels,
    sheets,
    designs,
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

/** Largura útil do verso da tag de cabide: 55 mm menos 5 mm de cada lado. */
const HANG_TAG_TEXT_WIDTH_MM = 45;
/** Corpos do nome da peça, do maior para o menor (pt). */
export const HANG_TAG_NAME_SIZES_PT = [13, 11.5, 10] as const;
const PT_TO_MM = 25.4 / 72;

/**
 * O maior corpo em que o nome cabe em 2 linhas de 45 mm — estimativa com a
 * métrica da serifa embutida; o clamp de 2 linhas da página é a rede.
 */
export function hangTagNameSizePt(name: string): number {
  return (
    HANG_TAG_NAME_SIZES_PT.find((pt) => estimateLines(name, "serif", pt * PT_TO_MM, HANG_TAG_TEXT_WIDTH_MM) <= 2) ??
    HANG_TAG_NAME_SIZES_PT[HANG_TAG_NAME_SIZES_PT.length - 1]
  );
}
