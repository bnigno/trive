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
    /** Tipos de peça dentro da categoria (vestido, corset…) e quantas ainda estão sem tipo. */
    types?: { type: string; label: string; productCount: number; priceFromCents: number; priceToCents: number }[];
    untyped?: number;
  }[];
  colors: string[];
  sizes: string[];
  /** Edições de Belém ativas (no ar ou por vir), com a contagem de peças vendáveis. */
  editions?: { name: string; slug: string; productCount: number; current: boolean; daysUntil: number | null; kind?: "always" | "period" | "hours" | "period_hours" }[];
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

  const pecas = (n: number) => `${n} ${n === 1 ? "peça" : "peças"}`;
  const linhas = [`${input.totalProducts} ${input.totalProducts === 1 ? "peça ativa" : "peças ativas"} no catálogo.`];
  let comTipos = false;
  for (const categoria of input.categories) {
    linhas.push(
      `• ${categoria.name}${categoria.slug ? ` (categoria: ${categoria.slug})` : ""} — ${pecas(categoria.productCount)}, ${priceRange(categoria.priceFromCents, categoria.priceToCents)}`,
    );
    for (const tipo of categoria.types ?? []) {
      comTipos = true;
      linhas.push(`  – ${tipo.label} (tipo: ${tipo.type}) — ${pecas(tipo.productCount)}, ${priceRange(tipo.priceFromCents, tipo.priceToCents)}`);
    }
    if ((categoria.untyped ?? 0) > 0 && categoria.types !== undefined) {
      comTipos = true;
      linhas.push(`  – sem tipo marcado — ${pecas(categoria.untyped ?? 0)} (o filtro por tipo não as vê; busque pelo nome)`);
    }
  }
  if (comTipos) {
    linhas.push('Em listar_produtos.categoria vale a categoria OU o tipo (ex.: "corset").');
  }
  if (input.colors.length > 0) {
    linhas.push(`Cores com estoque: ${limited(input.colors)}.`);
  }
  if (input.sizes.length > 0) {
    linhas.push(`Tamanhos com estoque: ${limited(input.sizes)}.`);
  }
  const editions = input.editions ?? [];
  if (editions.length > 0) {
    linhas.push("Edições de Belém (curadoria por ocasião; filtre com edicao em listar_produtos):");
    for (const edition of editions) {
      const byHour = edition.kind === "hours" || edition.kind === "period_hours";
      const when = edition.current
        ? "NO AR"
        : edition.daysUntil === null || (byHour && edition.daysUntil === 0)
          ? "fora do horário agora"
          : edition.daysUntil === 0
            ? "começa hoje"
            : `começa em ${edition.daysUntil} ${edition.daysUntil === 1 ? "dia" : "dias"}`;
      linhas.push(`• ${edition.name} (edicao: ${edition.slug}) — ${edition.productCount} ${edition.productCount === 1 ? "peça" : "peças"}, ${when}`);
    }
  }
  return linhas.join("\n");
}
