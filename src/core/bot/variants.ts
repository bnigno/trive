// Apresentação das variações (cor, tamanho…) de um produto no WhatsApp:
// listagem agrupada, menu tocável e escolha da foto da cor. Tudo PURO — quem
// lê o banco e envia é src/services/wa-bot.ts.
//
// Um produto 3 cores × 3 tamanhos tem 9 combinações; despejar 9 linhas com
// preço e SKU estoura o limite de 1200 caracteres do WhatsApp e o cliente não
// enxerga nada. Agrupamos pelo PRIMEIRO eixo (o mesmo que product_images.color
// pareia), que é como a pessoa escolhe: primeiro a cor, depois o tamanho.

import {
  normalizeAxisValue,
  variantLabel,
  VARIANT_LABEL_SEPARATOR,
} from "@/core/catalog/attributes";
import { formatCentsBRL } from "@/lib/money";
import {
  OPTION_ID_MAX_CHARS,
  OPTION_LIST_MAX_OPTIONS,
  truncateOptionTitle,
} from "@/core/bot/option-list";

/** Variante vendável como o bot precisa dela para falar com o cliente. */
export type BotVariant = {
  sku: string;
  attributes: Record<string, string>;
  priceCents: number;
  /** Disponível para venda agora: max(0, on_hand - reserved). */
  availableQty: number;
};

export type BotProductImage = {
  path: string;
  /** Cor da foto; null = foto do produto inteiro. */
  color: string | null;
};

/** Prefixo do id de cada linha do menu de variação; espelha 'produto:<slug>'. */
export const VARIANT_OPTION_ID_PREFIX = "variante:";

export const VARIANT_MENU_BUTTON_LABEL = "Escolher opção";

/**
 * Eixos que as variantes REALMENTE preenchem, na ordem declarada em
 * attributes_schema. Um produto pode declarar "cor" e ainda não ter nenhuma
 * variante com cor — esse eixo não pode virar rótulo vazio na mensagem.
 */
function usedAxes(
  variants: readonly BotVariant[],
  axesOrder: readonly string[],
): string[] {
  return axesOrder.filter((axis) =>
    variants.some((variant) => Boolean(variant.attributes[axis])),
  );
}

function availabilityText(availableQty: number): string {
  return availableQty > 0 ? String(availableQty) : "esgotado";
}

function longAvailabilityText(availableQty: number): string {
  if (availableQty <= 0) return "esgotado";
  return `${availableQty} ${availableQty === 1 ? "disponível" : "disponíveis"}`;
}

/** "cor", "cor e tamanho", "cor, tamanho e material". */
function joinAxisNames(axes: readonly string[]): string {
  if (axes.length <= 1) return axes[0] ?? "";
  return `${axes.slice(0, -1).join(", ")} e ${axes[axes.length - 1]}`;
}

/**
 * Linhas de variação prontas para o modelo retransmitir, agrupadas pelo
 * primeiro eixo:
 *
 *     Opções disponíveis (quantidade entre parênteses):
 *     • Verde: P (3), G (2)
 *     • Amarelo: M (1), G (esgotado)
 *     Preço: R$ 89,90
 *     [SKU de cada combinação…]
 *
 * O preço aparece UMA vez quando é igual em todas as combinações; quando
 * difere, cada combinação leva o seu. A última linha é a tabela de SKUs, que
 * o modelo precisa para chamar criar_pedido e o cliente não precisa ver.
 */
export function formatVariantLines(
  variants: readonly BotVariant[],
  axesOrder: readonly string[],
): string[] {
  if (variants.length === 0) return [];

  const axes = usedAxes(variants, axesOrder);
  const firstPriceCents = variants[0].priceCents;
  const uniformPriceCents = variants.every(
    (variant) => variant.priceCents === firstPriceCents,
  )
    ? firstPriceCents
    : null;

  // Produto sem variação: uma linha só, com o SKU à vista (não há o que
  // agrupar nem escolher, e a linha inteira cabe folgada no WhatsApp).
  if (axes.length === 0) {
    return variants.map(
      (variant) =>
        `• ${formatCentsBRL(variant.priceCents)} (${longAvailabilityText(variant.availableQty)}) — SKU: ${variant.sku}`,
    );
  }

  const groupAxis = axes.length > 1 ? axes[0] : null;
  const detailAxes = groupAxis ? axes.slice(1) : axes;

  const groups = new Map<string, string[]>();
  for (const variant of variants) {
    const groupValue = groupAxis ? (variant.attributes[groupAxis] ?? "") : "";
    const entry = [
      variantLabel(variant.attributes, detailAxes),
      `(${availabilityText(variant.availableQty)})`,
      ...(uniformPriceCents === null
        ? [`— ${formatCentsBRL(variant.priceCents)}`]
        : []),
    ]
      .filter((part) => part !== "")
      .join(" ");
    const entries = groups.get(groupValue);
    if (entries) entries.push(entry);
    else groups.set(groupValue, [entry]);
  }

  const lines = ["Opções disponíveis (quantidade entre parênteses):"];
  for (const [groupValue, entries] of groups) {
    lines.push(
      groupValue
        ? `• ${groupValue}: ${entries.join(", ")}`
        : `• ${entries.join(", ")}`,
    );
  }
  if (uniformPriceCents !== null) {
    lines.push(`Preço: ${formatCentsBRL(uniformPriceCents)}`);
  }
  lines.push(
    `[SKU de cada combinação, para criar_pedido — NÃO mostre ao cliente: ${variants
      .map((variant) => `${variantLabel(variant.attributes, axes)}=${variant.sku}`)
      .join("; ")}]`,
  );
  return lines;
}

export type VariantMenu = {
  message: string;
  title: string;
  buttonLabel: string;
  options: { id: string; title: string; description: string }[];
};

/**
 * Menu tocável com uma linha por combinação DISPONÍVEL, ou null quando não
 * cabe um menu honesto: produto sem variação, nada em estoque, mais de 10
 * combinações (a lista cortaria opções e o cliente pensaria que o resto não
 * existe) ou algum id/rótulo fora dos limites da Z-API.
 */
export function buildVariantMenu(
  productName: string,
  variants: readonly BotVariant[],
  axesOrder: readonly string[],
): VariantMenu | null {
  const axes = usedAxes(variants, axesOrder);
  if (axes.length === 0) return null;

  const available = variants.filter((variant) => variant.availableQty > 0);
  if (available.length === 0 || available.length > OPTION_LIST_MAX_OPTIONS) {
    return null;
  }

  const options = available.map((variant) => ({
    id: `${VARIANT_OPTION_ID_PREFIX}${variant.sku}`,
    title: truncateOptionTitle(variantLabel(variant.attributes, axes)),
    description: `${formatCentsBRL(variant.priceCents)}${VARIANT_LABEL_SEPARATOR}${longAvailabilityText(variant.availableQty)}`,
  }));
  if (
    options.some(
      (option) =>
        option.title === "" || option.id.length > OPTION_ID_MAX_CHARS,
    )
  ) {
    return null;
  }

  return {
    message: `Toque abaixo para escolher ${joinAxisNames(axes)} 👇`,
    title: truncateOptionTitle(productName),
    buttonLabel: VARIANT_MENU_BUTTON_LABEL,
    options,
  };
}

/**
 * Foto certa para a cor escolhida: a da cor, senão a do produto inteiro
 * (color null), senão a primeira de todas. Sem cor definida na conversa, é a
 * primeira — que é como a vitrine mostra a capa.
 */
export function pickImagePath(
  images: readonly BotProductImage[],
  color: string | null,
): string | null {
  const first = images[0];
  if (!first) return null;
  if (color !== null && color.trim() !== "") {
    const target = normalizeAxisValue(color);
    const ofColor = images.find(
      (image) => image.color !== null && normalizeAxisValue(image.color) === target,
    );
    if (ofColor) return ofColor.path;
    const generic = images.find((image) => image.color === null);
    if (generic) return generic.path;
  }
  return first.path;
}

/**
 * Valor do primeiro eixo (a "cor" com que product_images.color pareia) numa
 * variante — null quando o produto não varia por cor.
 */
export function colorOfVariant(
  attributes: Record<string, string>,
  axesOrder: readonly string[],
): string | null {
  const colorAxis = axesOrder[0];
  if (colorAxis === undefined) return null;
  return attributes[colorAxis] ?? null;
}
