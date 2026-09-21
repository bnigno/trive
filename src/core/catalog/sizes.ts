// Tamanho de peça: ordem, eixo e etiqueta dupla. Sem dependência — a página
// do produto (cliente) importa daqui para não carregar o zod da fita métrica.
//
// Etiqueta dupla ("38/40", "P/M") é UMA peça que veste os dois tamanhos: a
// TRIVÉ compra peças únicas e várias vêm assim. A barra é a forma canônica
// (normalizeAxisValue transforma "38, 40" nela); a leitura tolera hífen.

const SIZE_ORDER = ["PP", "P", "M", "G", "GG", "XG", "XGG"];

/** "38/40" → ["38","40"]; "P/M" → ["P","M"]; "38" → ["38"]. */
export function sizeTokens(label: string): string[] {
  return label
    .split(/[/-]/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function foldSize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase();
}

/** A peça serve quem pede este tamanho: "38/40" casa 38, 40 e o próprio "38/40". */
export function sizeMatches(label: string, wanted: string): boolean {
  const target = foldSize(wanted);
  if (!target) return false;
  if (foldSize(label) === target) return true;
  return sizeTokens(label).some((token) => foldSize(token) === target);
}

function compareSizeTokens(a: string, b: string): number {
  const ia = SIZE_ORDER.indexOf(a.toUpperCase());
  const ib = SIZE_ORDER.indexOf(b.toUpperCase());
  if (ia !== -1 && ib !== -1) return ia - ib;
  if (ia !== -1) return -1;
  if (ib !== -1) return 1;
  const na = Number(a);
  const nb = Number(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  return a.localeCompare(b, "pt-BR");
}

/**
 * PP < P < M < G < GG < XG < XGG, depois numérico crescente, depois alfabético.
 * Etiqueta dupla fica logo depois do seu primeiro tamanho: 36 · 36/38 · 38 · 38/40 · 40.
 */
export function compareSizeLabels(a: string, b: string): number {
  const ta = sizeTokens(a);
  const tb = sizeTokens(b);
  if (ta.length === 0 || tb.length === 0) return compareSizeTokens(a, b);
  const first = compareSizeTokens(ta[0]!, tb[0]!);
  if (first !== 0) return first;
  if (ta.length !== tb.length) return ta.length - tb.length;
  return ta.length > 1 ? compareSizeTokens(ta[1]!, tb[1]!) : 0;
}

/** O eixo de tamanho do produto, sem diferenciar caixa ("Tamanho" também vale). */
export function findSizeAxis(axes: readonly string[]): string | null {
  return axes.find((axis) => axis.trim().toLowerCase() === "tamanho") ?? null;
}
