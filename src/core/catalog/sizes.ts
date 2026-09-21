// Ordem e eixo de tamanho, sem dependência: a página do produto (cliente)
// importa daqui para não carregar o zod da fita métrica.

const SIZE_ORDER = ["PP", "P", "M", "G", "GG", "XG", "XGG"];

/** PP < P < M < G < GG < XG < XGG, depois numérico crescente, depois alfabético. */
export function compareSizeLabels(a: string, b: string): number {
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

/** O eixo de tamanho do produto, sem diferenciar caixa ("Tamanho" também vale). */
export function findSizeAxis(axes: readonly string[]): string | null {
  return axes.find((axis) => axis.trim().toLowerCase() === "tamanho") ?? null;
}
