// "Planta da loja": o resumo do catálogo que entra no prompt de sistema para a
// vendedora saber o que existe ANTES de buscar. PURO — os dados vêm de
// src/services/store-catalog.ts (getStoreMap). O texto só muda quando o
// catálogo muda, então o prefixo cacheado do prompt continua estável.

import { formatCentsBRL } from "@/lib/money";

export type StoreMapInput = {
  totalProducts: number;
  categories: {
    name: string;
    slug: string;
    productCount: number;
    priceFromCents: number;
    priceToCents: number;
  }[];
  colors: string[];
  sizes: string[];
};

const MAX_VALUES = 24;

function priceRange(fromCents: number, toCents: number): string {
  return fromCents === toCents
    ? formatCentsBRL(fromCents)
    : `${formatCentsBRL(fromCents)} a ${formatCentsBRL(toCents)}`;
}

function limited(values: readonly string[]): string {
  if (values.length <= MAX_VALUES) return values.join(", ");
  return `${values.slice(0, MAX_VALUES).join(", ")} e mais ${values.length - MAX_VALUES}`;
}

/** null quando o catálogo está vazio (sem planta, o prompt segue sem o bloco). */
export function renderStoreMap(input: StoreMapInput): string | null {
  if (input.totalProducts === 0 || input.categories.length === 0) return null;

  const linhas = [
    `${input.totalProducts} ${input.totalProducts === 1 ? "peça ativa" : "peças ativas"} no catálogo.`,
    ...input.categories.map(
      (categoria) =>
        `• ${categoria.name}${categoria.slug ? ` (categoria: ${categoria.slug})` : ""} — ${categoria.productCount} ${categoria.productCount === 1 ? "peça" : "peças"}, ${priceRange(categoria.priceFromCents, categoria.priceToCents)}`,
    ),
  ];
  if (input.colors.length > 0) {
    linhas.push(`Cores com estoque: ${limited(input.colors)}.`);
  }
  if (input.sizes.length > 0) {
    linhas.push(`Tamanhos com estoque: ${limited(input.sizes)}.`);
  }
  return linhas.join("\n");
}
