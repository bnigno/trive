// "Começar pela foto": o rascunho da ficha que a visão do modelo devolve —
// PURO. Schema Zod (e o JSON Schema derivado, para saída estruturada),
// o prompt determinístico e a normalização do que veio (categoria por slug,
// cores/tamanhos no padrão da grade, avisos honestos). Nada aqui grava:
// o rascunho só vira peça quando a dona revisa e toca "Criar produto".

import { z } from "zod";

import { normalizeAxisValue } from "./attributes";
import { CARE_SYMBOL_KEYS, CARE_SYMBOLS, type CareSymbolKey } from "./care";
import { DESCRIPTION_MIN_CHARS } from "./readiness";

export const DRAFT_MAX_COLORS = 6;
export const DRAFT_MAX_SIZES = 8;
export const DRAFT_MAX_PHOTOS = 3;
/** Faixa honesta para peso de roupa/acessório (g). */
export const DRAFT_WEIGHT_MIN_GRAMS = 50;
export const DRAFT_WEIGHT_MAX_GRAMS = 3000;

/**
 * O que o modelo devolve. Mantido simples de propósito: saída estruturada
 * aceita um subconjunto do JSON Schema (sem minLength/pattern), então os
 * limites finos ficam em normalizeProductDraft.
 */
export const rawProductDraftSchema = z.object({
  name: z.string(),
  categorySlug: z.string().nullable(),
  colors: z.array(z.string()),
  sizes: z.array(z.string()),
  description: z.string(),
  composition: z.string(),
  careSymbols: z.array(z.string()),
  careFreeText: z.string(),
  fitNotes: z.string(),
  weightGramsEstimate: z.number().nullable(),
  warnings: z.array(z.string()),
});

export type RawProductDraft = z.infer<typeof rawProductDraftSchema>;

/** JSON Schema para `output_config.format` (json_schema): sem $ref, sem defs. */
export const PRODUCT_DRAFT_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    name: { type: "string", description: "Nome da peça no tom da maison, até 80 caracteres." },
    categorySlug: {
      type: ["string", "null"],
      description: "Slug de UMA sala da lista, ou null se nenhuma servir.",
    },
    colors: { type: "array", items: { type: "string" }, description: "Cores visíveis nas fotos (até 6)." },
    sizes: { type: "array", items: { type: "string" }, description: "Tamanhos lidos na etiqueta ou na tabela (até 8); vazio se não aparecer." },
    description: { type: "string", description: "Descrição da peça com pelo menos 300 caracteres." },
    composition: { type: "string", description: "Composição lida na etiqueta (ex.: 100% linho); vazio se a etiqueta não aparece." },
    careSymbols: {
      type: "array",
      items: { type: "string", enum: [...CARE_SYMBOL_KEYS] },
      description: "Pictogramas de cuidado lidos na etiqueta.",
    },
    careFreeText: { type: "string", description: "Cuidados que não cabem nos pictogramas; vazio se nenhum." },
    fitNotes: { type: "string", description: "Como veste: caimento, modelagem, comprimento." },
    weightGramsEstimate: { type: ["number", "null"], description: "Peso estimado em gramas (50–3000) ou null." },
    warnings: { type: "array", items: { type: "string" }, description: "O que não deu para ler ou ficou em dúvida, em pt-BR." },
  },
  required: [
    "name",
    "categorySlug",
    "colors",
    "sizes",
    "description",
    "composition",
    "careSymbols",
    "careFreeText",
    "fitNotes",
    "weightGramsEstimate",
    "warnings",
  ],
  additionalProperties: false,
};

export type ProductDraft = {
  name: string;
  categoryId: string | null;
  categoryName: string | null;
  colors: string[];
  sizes: string[];
  description: string;
  composition: string;
  careSymbols: CareSymbolKey[];
  careFreeText: string[];
  fitNotes: string;
  weightGrams: number | null;
  /** Avisos do modelo + os da normalização, em pt-BR, para a faixa amarela. */
  warnings: string[];
};

export type DraftCategory = { id: string; name: string; slug: string };

export type ProductDraftPromptInput = {
  storeName: string;
  manifesto: string;
  categories: readonly { name: string; slug: string }[];
  knownColors: readonly string[];
  knownSizes: readonly string[];
};

/** Prompt de sistema do rascunho — determinístico (sem data, sem aleatório). */
export function buildProductDraftPrompt(input: ProductDraftPromptInput): string {
  const salas =
    input.categories.length > 0
      ? input.categories.map((category) => `- ${category.name} (slug: ${category.slug})`).join("\n")
      : "- (nenhuma sala cadastrada: devolva categorySlug null)";
  const cores = input.knownColors.length > 0 ? input.knownColors.join(", ") : "(nenhuma ainda)";
  const tamanhos = input.knownSizes.length > 0 ? input.knownSizes.join(", ") : "(nenhum ainda)";
  const cuidados = CARE_SYMBOL_KEYS.map((key) => `${key} = ${CARE_SYMBOLS[key].label}`).join("; ");
  return [
    `Você prepara a ficha de uma peça de roupa ou acessório para a loja ${input.storeName}, a partir de fotos tiradas pela dona (a peça, a etiqueta de composição e, às vezes, a tabela de medidas do fornecedor). Devolva SOMENTE o JSON pedido.`,
    input.manifesto.trim() !== ""
      ? `TOM DA MAISON (use no nome e na descrição):\n${input.manifesto.trim()}`
      : "TOM DA MAISON: elegante, direto, caloroso; sem exageros nem jargão de e-commerce.",
    `SALAS (categorias) da loja — escolha UMA pelo slug, ou null se nenhuma servir:\n${salas}`,
    `CORES já usadas na loja (prefira estas grafias quando a cor for a mesma): ${cores}.\nTAMANHOS já usados: ${tamanhos}.`,
    `REGRAS:\n1. name: nome curto no tom da maison (ex.: "Longo Dunas", "Blusa Aurora"), até 80 caracteres, sem preço, sem cor no nome.\n2. description: pelo menos 300 caracteres em pt-BR, falando de tecido, caimento, ocasião e UMA frase sobre como a peça se comporta no calor e na umidade de Belém. Nunca invente tecnologia de tecido nem origem.\n3. composition: só o que está legível na etiqueta (ex.: "100% linho" ou "70% viscose 30% poliéster"). Se a etiqueta não aparece ou está ilegível, devolva "" e explique em warnings.\n4. careSymbols: só os pictogramas que a etiqueta mostra, usando as chaves: ${cuidados}. careFreeText: o que não cabe nos pictogramas.\n5. colors: as cores que aparecem NAS FOTOS, uma grafia por cor (Primeira letra maiúscula), até ${DRAFT_MAX_COLORS}. sizes: só os tamanhos lidos (etiqueta ou tabela), até ${DRAFT_MAX_SIZES}; sem informação, devolva [] — nunca chute uma grade.\n6. fitNotes: caimento, modelagem e comprimento observáveis (ex.: "Corte fluido, comprimento midi, cintura marcada"). Nada sobre corpo de quem veste.\n7. weightGramsEstimate: estimativa honesta em gramas (${DRAFT_WEIGHT_MIN_GRAMS}–${DRAFT_WEIGHT_MAX_GRAMS}) pelo tipo de peça e tecido, ou null.\n8. warnings: tudo que não deu para ler ou ficou em dúvida, em frases curtas em pt-BR (ex.: "Etiqueta de composição não aparece nas fotos").`,
  ].join("\n\n");
}

export const PRODUCT_DRAFT_USER_TEXT =
  "Fotos da peça em anexo. Monte a ficha conforme as regras e devolva o JSON.";

function uniqueNormalized(values: readonly string[], max: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizeAxisValue(value);
    if (normalized === "") continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
    if (out.length >= max) break;
  }
  return out;
}

function isCareSymbolKey(value: string): value is CareSymbolKey {
  return (CARE_SYMBOL_KEYS as readonly string[]).includes(value);
}

/**
 * Do JSON do modelo ao rascunho revisável: categoria resolvida pelo slug
 * (desconhecido = null + aviso), cores/tamanhos no padrão da grade e sem
 * repetição, descrição curta vira aviso (nunca inventamos texto), peso fora
 * da faixa vira null + aviso. Lança ZodError se o JSON não tem o formato.
 */
export function normalizeProductDraft(
  raw: unknown,
  opts: { categories: readonly DraftCategory[] },
): ProductDraft {
  const parsed = rawProductDraftSchema.parse(raw);
  const warnings = parsed.warnings.map((warning) => warning.trim()).filter((warning) => warning !== "");

  const name = parsed.name.trim().slice(0, 80);
  if (name === "") warnings.push("O modelo não sugeriu nome: escreva um.");

  let categoryId: string | null = null;
  let categoryName: string | null = null;
  if (parsed.categorySlug !== null && parsed.categorySlug.trim() !== "") {
    const slug = parsed.categorySlug.trim().toLowerCase();
    const category = opts.categories.find((candidate) => candidate.slug.toLowerCase() === slug);
    if (category) {
      categoryId = category.id;
      categoryName = category.name;
    } else {
      warnings.push(`A sala sugerida ("${parsed.categorySlug}") não existe: escolha uma da lista.`);
    }
  }

  const description = parsed.description.trim();
  if (description.length < DESCRIPTION_MIN_CHARS) {
    warnings.push(
      `Descrição curta (${description.length} caracteres; a peça fica pronta com ${DESCRIPTION_MIN_CHARS}).`,
    );
  }

  const careSymbols = parsed.careSymbols
    .map((symbol) => symbol.trim())
    .filter(isCareSymbolKey)
    .filter((symbol, index, all) => all.indexOf(symbol) === index);
  const unknownSymbols = parsed.careSymbols.filter((symbol) => !isCareSymbolKey(symbol.trim()));
  const careFreeText = [
    ...parsed.careFreeText.split("\n"),
    ...unknownSymbols,
  ]
    .map((line) => line.trim())
    .filter((line) => line !== "");

  let weightGrams: number | null = null;
  if (parsed.weightGramsEstimate !== null) {
    const rounded = Math.round(parsed.weightGramsEstimate);
    if (rounded >= DRAFT_WEIGHT_MIN_GRAMS && rounded <= DRAFT_WEIGHT_MAX_GRAMS) {
      weightGrams = rounded;
    } else {
      warnings.push(`Peso estimado fora da faixa (${rounded} g): confira na balança.`);
    }
  } else {
    warnings.push("Sem estimativa de peso: cadastre o peso para o frete não usar 300 g.");
  }

  return {
    name,
    categoryId,
    categoryName,
    colors: uniqueNormalized(parsed.colors, DRAFT_MAX_COLORS),
    sizes: uniqueNormalized(parsed.sizes, DRAFT_MAX_SIZES),
    description,
    composition: parsed.composition.trim(),
    careSymbols,
    careFreeText,
    fitNotes: parsed.fitNotes.trim(),
    weightGrams,
    warnings,
  };
}
