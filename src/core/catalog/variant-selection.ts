// Escolha de variação na página do produto — regra pura, sem I/O. Usada pelo
// seletor de variação e pela barra fixa de compra do celular, que precisam
// concordar sobre "qual variante está escolhida". Tipo estrutural local para o
// core não importar de services.

export interface SelectableVariant {
  attributes: Record<string, string>;
  availableQty: number;
}

/**
 * Escolha inicial de cada eixo: a primeira variação com estoque, ou a primeira
 * de todas se o produto inteiro estiver esgotado. Eixo sem valor na variante
 * fica de fora (o seletor mostra "Combinação indisponível").
 */
export function initialAxisSelection<T extends SelectableVariant>(
  axes: readonly string[],
  variants: readonly T[],
): Record<string, string> {
  const initial =
    variants.find((variant) => variant.availableQty > 0) ?? variants[0];
  const selection: Record<string, string> = {};
  if (initial) {
    for (const axis of axes) {
      const value = initial.attributes[axis];
      if (value) selection[axis] = value;
    }
  }
  return selection;
}

/**
 * A variante que casa com TODOS os eixos escolhidos. Produto sem eixos devolve
 * a primeira variante; combinação inexistente devolve undefined.
 */
export function findMatchedVariant<T extends SelectableVariant>(
  axes: readonly string[],
  variants: readonly T[],
  selected: Readonly<Record<string, string>>,
): T | undefined {
  if (axes.length === 0) return variants[0];
  return variants.find((variant) =>
    axes.every((axis) => variant.attributes[axis] === selected[axis]),
  );
}
