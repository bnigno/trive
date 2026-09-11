// "Começar pela foto": o rascunho da ficha que a visão do modelo devolve —
// PURO. Schema Zod (e o JSON Schema derivado, para saída estruturada),
// o prompt determinístico e a normalização do que veio (categoria por slug,
// cores/tamanhos no padrão da grade, avisos honestos). Nada aqui grava:
// o rascunho só vira peça quando a dona revisa e toca "Criar produto".

import { z } from "zod";

import { normalizeAxisValue } from "./attributes";
import { CARE_SYMBOL_KEYS, CARE_SYMBOLS, type CareSymbolKey } from "./care";
import {
  isMeasurementsEmpty,
  MEASUREMENT_KEYS,
  MEASUREMENT_LABELS,
  measurementsSchema,
  type Measurements,
} from "./measurements";
import { DESCRIPTION_MIN_CHARS } from "./readiness";

export const DRAFT_MAX_COLORS = 6;
export const DRAFT_MAX_SIZES = 8;
export const DRAFT_MAX_PHOTOS = 3;
/** Faixa honesta para peso de roupa/acessório (g). */
export const DRAFT_WEIGHT_MIN_GRAMS = 50;
export const DRAFT_WEIGHT_MAX_GRAMS = 3000;
/** Tetos do texto vindo da foto (a etiqueta é texto de terceiro). */
export const DRAFT_MAX_DESCRIPTION_CHARS = 1200;
export const DRAFT_MAX_SHORT_TEXT_CHARS = 200;

/**
 * A etiqueta fotografada pode trazer recado de terceiro (telefone, chave Pix,
 * link, "instrução" para o sistema). O texto entra assim mesmo — é a dona que
 * revisa — mas ela é avisada na faixa amarela.
 */
const THIRD_PARTY_HINTS: { pattern: RegExp; label: string }[] = [
  { pattern: /https?:\/\/|www\.[a-z]/i, label: "link" },
  { pattern: /\(?\d{2}\)?\s?9?\d{4}[-\s]?\d{4}/, label: "telefone" },
  { pattern: /\bpix\b|\bchave pix\b/i, label: "menção a Pix" },
  { pattern: /\b(instru(ç|c)(ã|a)o|sistema|ignore|desconto de \d+%)\b/i, label: "instrução" },
  { pattern: /@[a-z0-9._]{3,}/i, label: "perfil/@" },
];

function thirdPartyWarning(fields: Record<string, string>): string | null {
  const found = new Set<string>();
  for (const [field, value] of Object.entries(fields)) {
    for (const hint of THIRD_PARTY_HINTS) {
      if (hint.pattern.test(value)) found.add(`${hint.label} em "${field}"`);
    }
  }
  if (found.size === 0) return null;
  return `Achei ${[...found].join(", ")} no texto lido da foto — pode ser recado do fornecedor. Apague antes de publicar: esse texto vai para a loja e para a vendedora.`;
}

/**
 * O que o modelo devolve. Mantido simples de propósito: saída estruturada
 * aceita um subconjunto do JSON Schema (sem minLength/pattern), então os
 * limites finos ficam em normalizeProductDraft.
 */
/** Uma linha da tabela do fornecedor: o tamanho e as medidas em cm (ou null). */
const cmOrNull = z.number().nullable().optional();
const measurementRowSchema = z.object({
  size: z.string(),
  bust: cmOrNull,
  waist: cmOrNull,
  hip: cmOrNull,
  length: cmOrNull,
  sleeve: cmOrNull,
  shoulder: cmOrNull,
});

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
  /**
   * Tabela do fornecedor transcrita: uma linha por tamanho. LISTA, não mapa —
   * saída estruturada não aceita objeto de chaves livres.
   */
  measurementsBySize: z.array(measurementRowSchema).nullable().optional(),
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
    measurementsBySize: {
      type: ["array", "null"],
      description:
        "Tabela de medidas do fornecedor, SE ela aparecer numa das fotos: uma entrada por tamanho, com as medidas da peça deitada em centímetros. null quando não há tabela nas fotos.",
      items: {
        type: "object",
        properties: {
          size: { type: "string", description: "Tamanho como está na tabela (P, M, 38…)." },
          ...Object.fromEntries(
            MEASUREMENT_KEYS.map((key) => [
              key,
              { type: ["number", "null"], description: `${MEASUREMENT_LABELS[key]} em cm, ou null.` },
            ]),
          ),
        },
        required: ["size", ...MEASUREMENT_KEYS],
        additionalProperties: false,
      },
    },
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
    "measurementsBySize",
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
  /** Tamanho (como nas fichas da grade) → medidas em cm, revisáveis. */
  measurementsBySize: Record<string, Measurements>;
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
    `REGRAS:\n1. name: nome curto no tom da maison (ex.: "Longo Dunas", "Blusa Aurora"), até 80 caracteres, sem preço, sem cor no nome.\n2. description: pelo menos 300 caracteres em pt-BR, falando de tecido, caimento, ocasião e UMA frase sobre como a peça se comporta no calor e na umidade de Belém. Nunca invente tecnologia de tecido nem origem.\n3. composition: só o que está legível na etiqueta (ex.: "100% linho" ou "70% viscose 30% poliéster"). Se a etiqueta não aparece ou está ilegível, devolva "" e explique em warnings.\n4. careSymbols: só os pictogramas que a etiqueta mostra, usando as chaves: ${cuidados}. careFreeText: o que não cabe nos pictogramas.\n5. colors: as cores que aparecem NAS FOTOS, uma grafia por cor (Primeira letra maiúscula), até ${DRAFT_MAX_COLORS}. sizes: só os tamanhos lidos (etiqueta ou tabela), até ${DRAFT_MAX_SIZES}; sem informação, devolva [] — nunca chute uma grade.\n6. fitNotes: caimento, modelagem e comprimento observáveis (ex.: "Corte fluido, comprimento midi, cintura marcada"). Nada sobre corpo de quem veste.\n7. weightGramsEstimate: estimativa honesta em gramas (${DRAFT_WEIGHT_MIN_GRAMS}–${DRAFT_WEIGHT_MAX_GRAMS}) pelo tipo de peça e tecido, ou null.\n8. measurementsBySize: se UMA das fotos for a tabela de medidas do fornecedor, transcreva o que estiver legível — uma entrada por tamanho na lista, com "size" (o tamanho como está na tabela) e as medidas da PEÇA DEITADA em centímetros (${MEASUREMENT_KEYS.join(", ")}; use null no que não aparecer). Se a tabela estiver em polegadas, converta para centímetros (1 in = 2,54 cm) e diga isso em warnings. Sem tabela nas fotos, devolva null — nunca estime medidas.\n9. warnings: tudo que não deu para ler ou ficou em dúvida, em frases curtas em pt-BR (ex.: "Etiqueta de composição não aparece nas fotos").`,
  ].join("\n\n");
}

export const PRODUCT_DRAFT_USER_TEXT =
  "Fotos da peça em anexo. Monte a ficha conforme as regras e devolva o JSON.";

function uniqueNormalized(
  values: readonly string[],
  max: number,
): { kept: string[]; dropped: number } {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizeAxisValue(value);
    if (normalized === "") continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return { kept: out.slice(0, max), dropped: Math.max(0, out.length - max) };
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

  const description = parsed.description.trim().slice(0, DRAFT_MAX_DESCRIPTION_CHARS);
  if (description.length < DESCRIPTION_MIN_CHARS) {
    warnings.push(
      `Descrição curta (${description.length} caracteres; a peça fica pronta com ${DESCRIPTION_MIN_CHARS}).`,
    );
  }

  const colorsRead = uniqueNormalized(parsed.colors, DRAFT_MAX_COLORS);
  const sizesRead = uniqueNormalized(parsed.sizes, DRAFT_MAX_SIZES);
  if (colorsRead.dropped > 0) {
    warnings.push(
      `O modelo leu ${colorsRead.kept.length + colorsRead.dropped} cores; mantive as ${DRAFT_MAX_COLORS} primeiras — confira as fichas de cor.`,
    );
  }
  if (sizesRead.dropped > 0) {
    warnings.push(
      `O modelo leu ${sizesRead.kept.length + sizesRead.dropped} tamanhos; mantive os ${DRAFT_MAX_SIZES} primeiros — confira as fichas de tamanho.`,
    );
  }

  const measurementsBySize: Record<string, Measurements> = {};
  const sizesOutOfGrid: string[] = [];
  const droppedMeasurements: string[] = [];
  for (const row of parsed.measurementsBySize ?? []) {
    const size = normalizeAxisValue(row.size);
    if (size === "") continue;
    // A tabela costuma citar tamanhos que a dona não comprou: fica de fora,
    // mas ela fica sabendo (nada de medida órfã na peça).
    const known = sizesRead.kept.find((candidate) => candidate.toLowerCase() === size.toLowerCase());
    if (!known) {
      sizesOutOfGrid.push(size);
      continue;
    }
    // Medida a medida: uma leitura torta ("70,3" ou 1000) não pode levar
    // junto as outras cinco do mesmo tamanho.
    const kept: Measurements = {};
    for (const key of MEASUREMENT_KEYS) {
      const value = row[key];
      if (typeof value !== "number") continue;
      // A fita mede em meio centímetro. Tabela em polegadas convertida cai em
      // 88,9: arredondar é o que a dona faria — jogar fora seria perder a
      // tabela inteira por causa da conversão que o prompt manda fazer.
      const rounded = Math.round(value * 2) / 2;
      const checked = measurementsSchema.safeParse({ [key]: rounded });
      if (checked.success) kept[key] = rounded;
      else droppedMeasurements.push(`${MEASUREMENT_LABELS[key]} do ${known} (${value})`);
    }
    if (!isMeasurementsEmpty(kept)) measurementsBySize[known] = kept;
  }
  if (sizesOutOfGrid.length > 0) {
    warnings.push(
      `A tabela de medidas cita ${sizesOutOfGrid.join(", ")}, que não está nas fichas de tamanho: acrescente a ficha ou deixe essas medidas de fora.`,
    );
  }
  if (droppedMeasurements.length > 0) {
    warnings.push(
      `Não entendi estas medidas e deixei em branco: ${droppedMeasurements.join("; ")}. Confira na tabela (centímetros inteiros ou meio centímetro).`,
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

  const composition = parsed.composition.trim().slice(0, DRAFT_MAX_SHORT_TEXT_CHARS);
  const fitNotes = parsed.fitNotes.trim().slice(0, DRAFT_MAX_SHORT_TEXT_CHARS);
  const thirdParty = thirdPartyWarning({
    descrição: description,
    composição: composition,
    "como veste": fitNotes,
    cuidados: careFreeText.join(" "),
  });
  if (thirdParty) warnings.push(thirdParty);

  return {
    name,
    categoryId,
    categoryName,
    colors: colorsRead.kept,
    sizes: sizesRead.kept,
    measurementsBySize,
    description,
    composition,
    careSymbols,
    careFreeText: careFreeText.map((line) => line.slice(0, DRAFT_MAX_SHORT_TEXT_CHARS)),
    fitNotes,
    weightGrams,
    warnings,
  };
}
