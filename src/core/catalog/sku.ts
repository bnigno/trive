// Geração de SKU a partir do nome do produto e dos valores dos eixos.
// O SKU é UNIQUE GLOBAL (product_variants_sku_unique), não único por produto:
// a colisão a resolver é contra a tabela inteira.

const SKU_BASE_MAX_LENGTH = 24;
const SKU_AXIS_MAX_LENGTH = 4;
const SKU_FALLBACK_BASE = "ITEM";

/** Sem acento, caixa alta, tudo que não é A-Z0-9 vira separador de palavra. */
function asciiWords(value: string): string[] {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((word) => word.length > 0);
}

/** "Vestido Áurea Midi" → "VESTIDO-AUREA-MIDI". */
export function skuBaseFromName(name: string): string {
  const words = asciiWords(name);
  if (words.length === 0) return SKU_FALLBACK_BASE;

  const base = words.join("-");
  if (base.length <= SKU_BASE_MAX_LENGTH) return base;

  // Corta na última palavra inteira que couber; se nem a primeira palavra
  // couber, trunca no meio dela.
  const cut = base.slice(0, SKU_BASE_MAX_LENGTH);
  const lastHyphen = cut.lastIndexOf("-");
  return lastHyphen > 0 ? cut.slice(0, lastHyphen) : cut;
}

/** "Azul Marinho" → "AZMA"; "Verde" → "VERD"; "GG" → "GG". */
export function abbreviateAxisValue(value: string): string {
  const words = asciiWords(value);
  if (words.length === 0) return "";
  if (words.length === 1) return words[0].slice(0, SKU_AXIS_MAX_LENGTH);

  // Divide o orçamento de letras entre as palavras para caber no mesmo teto.
  const perWord = Math.max(1, Math.floor(SKU_AXIS_MAX_LENGTH / words.length));
  return words
    .map((word) => word.slice(0, perWord))
    .join("")
    .slice(0, SKU_AXIS_MAX_LENGTH);
}

/** "VESTIDO-AUREA" + ["Verde", "P"] → "VESTIDO-AUREA-VERD-P". */
export function buildSku(base: string, axisValues: readonly string[]): string {
  const root = base.trim() || SKU_FALLBACK_BASE;
  return [root, ...axisValues.map(abbreviateAxisValue)]
    .filter((part) => part.length > 0)
    .join("-");
}

/**
 * Resolve colisão com sufixo -2, -3… contra os SKUs já existentes E contra os
 * candidatos anteriores da mesma leva (duas variantes podem abreviar para o
 * mesmo código). `taken` tem de vir da tabela inteira, não só do produto.
 */
export function dedupeSkus(
  candidates: readonly string[],
  taken: ReadonlySet<string>,
): string[] {
  const used = new Set(taken);
  const result: string[] = [];
  for (const candidate of candidates) {
    let sku = candidate;
    let suffix = 2;
    while (used.has(sku)) {
      sku = `${candidate}-${suffix}`;
      suffix += 1;
    }
    used.add(sku);
    result.push(sku);
  }
  return result;
}
