// A grade de variações do cadastro de produto: o cruzamento cor × tamanho,
// que rótulo e que SKU cada combinação recebe, e quais delas o dono realmente
// quis criar. Tudo puro — a tela desenha, o servidor reconfere com as mesmas
// funções.

import { buildAttributes, cartesian, normalizeAxisValue, variantLabel } from "./attributes";
import { buildSku, dedupeSkus, skuBaseFromName } from "./sku";

/**
 * Os dois eixos da grade têm nome fixo, em minúsculas. "cor" em especial não é
 * escolha estética: é por esse nome que findColorAxis (core/catalog/
 * product-images) acha a cor de uma variação para amarrar a foto a ela —
 * mesma função usada pela validação do upload, pelo painel e pela vitrine.
 */
export const COLOR_AXIS = "cor";
export const SIZE_AXIS = "tamanho";

/**
 * Teto de linhas da grade. Não é limite do banco: é o ponto em que a tela deixa
 * de ser preenchível à mão — melhor avisar o dono do que travar o navegador.
 */
export const MAX_GRID_ROWS = 60;

/** Teto de fichas por eixo, pelo mesmo motivo — e para um "colar" acidental
 * não virar mil cores. */
export const MAX_AXIS_VALUES = 40;

export interface GridCombination {
  /** Identidade da combinação, estável entre renderizações. */
  key: string;
  attributes: Record<string, string>;
  /** "Verde · P" */
  label: string;
  /** Sugestão de SKU; o dono pode trocar. */
  sku: string;
}

export interface VariantGrid {
  /** Só os eixos que têm valor, na ordem cor → tamanho. */
  axes: string[];
  combinations: GridCombination[];
}

/**
 * Eixos que a grade de fato tem. Sem nenhuma cor, "cor" não entra no produto:
 * um eixo declarado e vazio deixaria attributes_schema mentindo sobre a
 * variação (e o rótulo dela sairia torto).
 */
export function gridAxes(
  colors: readonly string[],
  sizes: readonly string[],
): string[] {
  const axes: string[] = [];
  if (colors.some((value) => normalizeAxisValue(value))) axes.push(COLOR_AXIS);
  if (sizes.some((value) => normalizeAxisValue(value))) axes.push(SIZE_AXIS);
  return axes;
}

/** Chave da combinação; inclui o eixo para "Verde" de cor não colidir com outro eixo. */
export function combinationKey(
  attributes: Record<string, string>,
  axes: readonly string[],
): string {
  return JSON.stringify(axes.map((axis) => [axis, attributes[axis] ?? ""]));
}

/**
 * Monta a grade inteira a partir das fichas de cor e tamanho. Sem cor e sem
 * tamanho sai uma única linha sem atributos — o produto simples.
 */
export function buildVariantGrid(input: {
  name: string;
  colors: readonly string[];
  sizes: readonly string[];
}): VariantGrid {
  const axes = gridAxes(input.colors, input.sizes);
  const combinations = cartesian([
    { name: COLOR_AXIS, values: [...input.colors] },
    { name: SIZE_AXIS, values: [...input.sizes] },
  ]);

  const base = skuBaseFromName(input.name);
  const skus = dedupeSkus(
    combinations.map((attributes) =>
      buildSku(base, axisValuesOf(attributes, axes)),
    ),
    new Set(),
  );

  return {
    axes,
    combinations: combinations.map((attributes, index) => ({
      key: combinationKey(attributes, axes),
      attributes,
      label: variantLabel(attributes, axes),
      sku: skus[index],
    })),
  };
}

/** Uma linha da grade como o dono a deixou. */
export interface GridSelectionRow {
  attributes: Record<string, string>;
  /** SKU vindo da tela: sugestão. Em branco, geramos de novo aqui. */
  sku: string;
  /** null = quantidade em branco, ou seja, essa combinação não existe. */
  quantity: number | null;
  costCents?: number;
}

/** Uma variação pronta para o serviço de catálogo criar. */
export interface SelectedVariant {
  sku: string;
  attributes: Record<string, string>;
  initialQuantity: number;
  costCents?: number;
  priceCents?: number;
}

/**
 * Das linhas da grade, quais viram variação de verdade.
 *
 * A regra que o dono enxerga na tela: quantidade em branco = essa combinação
 * não existe (o verde só veio em P e G). Quantidade 0 é diferente de branco —
 * a variação existe, só está sem estoque hoje.
 */
export function selectGridVariants(input: {
  name: string;
  axes: readonly string[];
  rows: readonly GridSelectionRow[];
  priceCents?: number;
}): SelectedVariant[] {
  const base = skuBaseFromName(input.name);
  const chosen = input.rows
    .filter((row) => row.quantity !== null)
    .map((row) => {
      const attributes = buildAttributes(input.axes, row.attributes);
      const typed = row.sku.trim().toUpperCase();
      return {
        row,
        attributes,
        sku: typed || buildSku(base, axisValuesOf(attributes, input.axes)),
      };
    });

  // Dois valores diferentes podem abreviar para o mesmo código ("Azul" e
  // "Azulão" viram AZUL): o sufixo -2 resolve antes de o banco recusar a leva.
  const skus = dedupeSkus(
    chosen.map((entry) => entry.sku),
    new Set(),
  );

  return chosen.map((entry, index) => ({
    sku: skus[index],
    attributes: entry.attributes,
    initialQuantity: entry.row.quantity ?? 0,
    costCents: entry.row.costCents,
    priceCents: input.priceCents,
  }));
}

/** Valores dos eixos na ordem declarada, pulando eixo sem valor. */
function axisValuesOf(
  attributes: Record<string, string>,
  axes: readonly string[],
): string[] {
  return axes
    .map((axis) => attributes[axis] ?? "")
    .filter((value) => value.length > 0);
}
