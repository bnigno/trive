// Eixos de variação de um produto (products.attributes_schema, ex.:
// ["cor","tamanho"]) e os valores escolhidos por variante
// (product_variants.attributes, ex.: {"cor":"Verde","tamanho":"P"}).

/** Um eixo com os valores que o dono declarou para ele. */
export interface CatalogAxis {
  name: string;
  values: string[];
}

/** Siglas de tamanho vão inteiras em caixa alta; o resto é Capitalizado. */
const SIZE_TOKENS = new Set(["PP", "P", "M", "G", "GG", "XG"]);

export const VARIANT_LABEL_SEPARATOR = " · ";

/**
 * O UNIQUE (product_id, attributes) compara o jsonb LITERALMENTE: "Preto",
 * "preto" e "Preto " virariam três variantes distintas do mesmo produto. Toda
 * escrita passa por aqui para que a comparação literal do banco signifique o
 * que o dono quis dizer.
 */
export function normalizeAxisValue(value: string): string {
  return value
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .map(capitalizeWord)
    .join(" ");
}

function capitalizeWord(word: string): string {
  const upper = word.toUpperCase();
  if (SIZE_TOKENS.has(upper)) return upper;
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

/**
 * Monta o attributes da variante só com os eixos declarados no produto —
 * valor extra em `values` é ignorado, eixo sem valor não entra no objeto.
 */
export function buildAttributes(
  axes: readonly string[],
  values: Record<string, string>,
): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const axis of axes) {
    if (!axis.trim()) continue;
    const value = normalizeAxisValue(values[axis] ?? "");
    if (value) attributes[axis] = value;
  }
  return attributes;
}

/**
 * Rótulo da variante ("Verde · P") na ordem de attributes_schema. Nunca
 * Object.values(attributes): o jsonb do Postgres reordena as chaves ao gravar
 * (por tamanho, depois byte a byte), então a ordem de inserção não sobrevive.
 */
export function variantLabel(
  attributes: Record<string, string>,
  axesOrder: readonly string[],
): string {
  return axesOrder
    .map((axis) => attributes[axis])
    .filter((value): value is string => Boolean(value))
    .join(VARIANT_LABEL_SEPARATOR);
}

/**
 * Os valores que um eixo realmente tem nas variantes, sem repetir e na ordem em
 * que aparecem. É o que o dono pode escolher para etiquetar uma foto: cor que
 * nenhuma variante tem não vira opção.
 */
export function axisValues(
  axis: string,
  variantAttributes: readonly Record<string, string>[],
): string[] {
  const values: string[] = [];
  for (const attributes of variantAttributes) {
    const value = attributes[axis];
    if (value && !values.includes(value)) values.push(value);
  }
  return values;
}

/**
 * Todas as combinações dos eixos, na ordem natural de leitura: o primeiro eixo
 * é o mais externo e o último é o que mais varia. Eixo sem valores não
 * restringe a grade, e sem nenhum eixo sai uma única combinação vazia — o
 * produto simples tem exatamente uma variante, com attributes = {}.
 */
export function cartesian(
  axes: readonly CatalogAxis[],
): Record<string, string>[] {
  let combinations: Record<string, string>[] = [{}];
  for (const axis of axes) {
    if (!axis.name.trim()) continue;
    const values = normalizedAxisValues(axis.values);
    if (values.length === 0) continue;
    combinations = combinations.flatMap((combination) =>
      values.map((value) => ({ ...combination, [axis.name]: value })),
    );
  }
  return combinations;
}

/** Normaliza e tira repetidos: "Preto" e "preto" são o mesmo valor. */
function normalizedAxisValues(values: readonly string[]): string[] {
  const unique = new Set<string>();
  for (const value of values) {
    const normalized = normalizeAxisValue(value);
    if (normalized) unique.add(normalized);
  }
  return [...unique];
}
