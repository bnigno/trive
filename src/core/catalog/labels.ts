// Etiquetas da peça para imprimir em folha A4: a tag de cabide (cartão com
// a marca na frente e nome, cor/tamanho, SKU e QR atrás) e a adesiva (SKU e
// preço). Aqui só a conta: quantas de cada variação, em que ordem e como se
// repartem em folhas. A folha em si (medidas, CSS) é da página.
import { variantLabel } from "./attributes";

export type LabelModel = "cabide" | "adesiva";

/** Uma variação não pede mais do que isso de uma vez: acima é engano de digitação. */
export const LABELS_MAX_PER_VARIANT = 200;
/** 20 folhas. Mais do que isso trava o diálogo de impressão sem avisar. */
export const LABELS_MAX_SHEETS = 20;
/**
 * Capacidade da folha A4: 3 × 9 adesivas de 63,5 × 31 mm (Pimaco A4355) ou
 * 3 × 3 tags de cabide de 55 × 90 mm.
 */
export const LABELS_PER_SHEET: Record<LabelModel, number> = { adesiva: 27, cabide: 9 };

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
  /** false no arquivo de gráfica: lá não há folhas, a gráfica imprime a quantidade. */
  capTotal?: boolean;
}): LabelPlan {
  let remaining = input.capTotal === false ? Number.POSITIVE_INFINITY : labelsMaxTotal(input.model);
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
export const HANG_TAG_NAME_SIZES_PT = [13, 11.5, 10, 9] as const;
const PT_TO_MM = 25.4 / 72;

/**
 * Avanço de cada caractere da Cormorant Garamond SemiBold em "em", medido no
 * Chrome (canvas measureText a 100 px com a fonte de brand-source). Letras
 * acentuadas usam a base (mesmo avanço); o resto, 0,5 em.
 */
const SERIF_600_EM: Record<string, number> = {
  " ": 0.23,
  "%": 0.57,
  "&": 0.71,
  "'": 0.15,
  "(": 0.31,
  ")": 0.31,
  ",": 0.22,
  "-": 0.32,
  ".": 0.2,
  "/": 0.35,
  "0": 0.48,
  "1": 0.33,
  "2": 0.4,
  "3": 0.39,
  "4": 0.45,
  "5": 0.41,
  "6": 0.47,
  "7": 0.43,
  "8": 0.49,
  "9": 0.47,
  "A": 0.71,
  "B": 0.58,
  "C": 0.68,
  "D": 0.7,
  "E": 0.55,
  "F": 0.52,
  "G": 0.73,
  "H": 0.76,
  "I": 0.34,
  "J": 0.33,
  "K": 0.65,
  "L": 0.54,
  "M": 0.85,
  "N": 0.73,
  "O": 0.77,
  "P": 0.55,
  "Q": 0.77,
  "R": 0.69,
  "S": 0.51,
  "T": 0.64,
  "U": 0.7,
  "V": 0.66,
  "W": 0.92,
  "X": 0.65,
  "Y": 0.62,
  "Z": 0.6,
  "a": 0.42,
  "b": 0.51,
  "c": 0.42,
  "d": 0.51,
  "e": 0.41,
  "f": 0.31,
  "g": 0.45,
  "h": 0.51,
  "i": 0.27,
  "j": 0.26,
  "k": 0.49,
  "l": 0.27,
  "m": 0.77,
  "n": 0.52,
  "o": 0.49,
  "p": 0.51,
  "q": 0.5,
  "r": 0.37,
  "s": 0.34,
  "t": 0.34,
  "u": 0.5,
  "v": 0.44,
  "w": 0.68,
  "x": 0.44,
  "y": 0.43,
  "z": 0.41,
  "·": 0.2,
  "–": 0.52,
  "—": 0.83,
  "’": 0.19,
};
const SERIF_600_FALLBACK_EM = 0.5;

function serifWidthEm(text: string): number {
  let em = 0;
  for (const char of text) {
    const base = char.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    em += SERIF_600_EM[char] ?? SERIF_600_EM[base] ?? SERIF_600_FALLBACK_EM;
  }
  return em;
}

/** Linhas que um texto ocupa numa largura, quebrando por palavra (como o navegador). */
export function serifLinesFor(text: string, fontSizePt: number, widthMm: number): number {
  const maxEm = widthMm / (fontSizePt * PT_TO_MM);
  const space = serifWidthEm(" ");
  let lines = 1;
  let lineEm = 0;
  for (const word of text.trim().split(/\s+/).filter(Boolean)) {
    const wordEm = serifWidthEm(word);
    if (lineEm === 0) {
      lineEm = wordEm;
    } else if (lineEm + space + wordEm <= maxEm) {
      lineEm += space + wordEm;
    } else {
      lines += 1;
      lineEm = wordEm;
    }
    // Palavra maior que a linha: o navegador a quebra no meio.
    while (lineEm > maxEm) {
      lines += 1;
      lineEm -= maxEm;
    }
  }
  return lines;
}

/**
 * O maior corpo em que o nome cabe em 2 linhas de 45 mm, com a métrica real
 * da fonte; o clamp de 2 linhas da página é a rede para o que não cabe nem
 * no menor corpo.
 */
export function hangTagNameSizePt(name: string): number {
  return (
    HANG_TAG_NAME_SIZES_PT.find((pt) => serifLinesFor(name, pt, HANG_TAG_TEXT_WIDTH_MM) <= 2) ??
    HANG_TAG_NAME_SIZES_PT[HANG_TAG_NAME_SIZES_PT.length - 1]
  );
}
