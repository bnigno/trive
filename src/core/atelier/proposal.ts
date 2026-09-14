// O recado da dona interpretado — PURO. "chegou o Longo Dunas da Aurora,
// areia e terra, do P ao GG, três de cada, custou 120" vira uma proposta:
// nome, sala, cores, tamanhos (faixa expandida na ordem certa), quantidade,
// custo (por peça ou total) e fornecedor. O modelo devolve o JSON no
// formato de ARRIVAL_JSON_SCHEMA; normalizeArrivalProposal confere, põe no
// padrão da grade e anota o que ficou em dúvida.
import { z } from "zod";

import { normalizeAxisValue } from "@/core/catalog/attributes";
import { CARE_SYMBOL_KEYS, CARE_SYMBOLS, parseCareNotes, type CareSymbolKey } from "@/core/catalog/care";
import { formatCentsBRL } from "@/lib/money";
import {
  DRAFT_MAX_COLORS,
  DRAFT_MAX_DESCRIPTION_CHARS,
  DRAFT_MAX_SIZES,
  DRAFT_WEIGHT_MAX_GRAMS,
  DRAFT_WEIGHT_MIN_GRAMS,
} from "@/core/catalog/product-draft";
import { DESCRIPTION_MIN_CHARS } from "@/core/catalog/readiness";

/** Ordem dos tamanhos de letra; numéricos (34–54, de 2 em 2) vêm depois, em ordem. */
export const SIZE_ORDER = ["PP", "P", "M", "G", "GG", "XG", "XGG", "EG", "EGG"] as const;
export const NUMERIC_SIZE_MIN = 34;
export const NUMERIC_SIZE_MAX = 54;
export const ARRIVAL_MAX_COST_CENTS = 100_000_00;
export const ARRIVAL_MAX_QUANTITY = 999;
/** Cuidados em texto livre: cada linha e o conjunto (a ficha aceita 1000 no total, com os pictogramas). */
export const ARRIVAL_CARE_LINE_MAX = 200;
export const ARRIVAL_CARE_TOTAL_MAX = 700;

export function sizeRank(value: string): number {
  const upper = value.trim().toUpperCase();
  const letter = (SIZE_ORDER as readonly string[]).indexOf(upper);
  if (letter >= 0) return letter;
  const numeric = Number(upper);
  if (Number.isInteger(numeric)) return SIZE_ORDER.length + numeric;
  return SIZE_ORDER.length + 1000;
}

/** "do P ao GG" → P, M, G, GG; "36 ao 44" → 36, 38, 40, 42, 44; faixa estranha → []. */
export function expandSizeRange(from: string, to: string): string[] {
  const a = from.trim().toUpperCase();
  const b = to.trim().toUpperCase();
  const letters = SIZE_ORDER as readonly string[];
  const ia = letters.indexOf(a);
  const ib = letters.indexOf(b);
  if (ia >= 0 && ib >= 0) return ia <= ib ? letters.slice(ia, ib + 1) : letters.slice(ib, ia + 1);
  const na = Number(a);
  const nb = Number(b);
  if (!Number.isInteger(na) || !Number.isInteger(nb)) return [];
  const [lo, hi] = na <= nb ? [na, nb] : [nb, na];
  if (lo < NUMERIC_SIZE_MIN || hi > NUMERIC_SIZE_MAX) return [];
  const out: string[] = [];
  for (let size = lo; size <= hi; size += 2) out.push(String(size));
  return out;
}

export const rawArrivalProposalSchema = z.object({
  name: z.string(),
  categorySlug: z.string().nullable(),
  description: z.string(),
  composition: z.string(),
  careSymbols: z.array(z.string()),
  careFreeText: z.string(),
  fitNotes: z.string(),
  colors: z.array(z.string()),
  sizes: z.array(z.string()),
  sizeRange: z.object({ from: z.string(), to: z.string() }).nullable(),
  quantityPerVariant: z.number().nullable(),
  totalQuantity: z.number().nullable(),
  costCents: z.number().nullable(),
  costBasis: z.enum(["per_piece", "total", "unknown"]),
  supplierName: z.string().nullable(),
  weightGramsEstimate: z.number().nullable(),
  warnings: z.array(z.string()),
});

export type RawArrivalProposal = z.infer<typeof rawArrivalProposalSchema>;

/** JSON Schema para a saída estruturada (sem $ref, sem defs). */
export const ARRIVAL_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    name: { type: "string", description: "Nome da peça como a dona chamou no recado (ou, se não disse, um nome curto no tom da maison), até 80 caracteres, sem cor nem preço." },
    categorySlug: { type: ["string", "null"], description: "Slug de UMA sala da lista, ou null." },
    description: { type: "string", description: "Descrição da peça com pelo menos 300 caracteres, em pt-BR." },
    composition: { type: "string", description: "Composição lida na etiqueta ou dita no recado; vazio se não houver." },
    careSymbols: { type: "array", items: { type: "string", enum: [...CARE_SYMBOL_KEYS] }, description: "Pictogramas de cuidado lidos na etiqueta." },
    careFreeText: { type: "string", description: "Cuidados que não cabem nos pictogramas; vazio se nenhum." },
    fitNotes: { type: "string", description: "Como veste: caimento, modelagem, comprimento." },
    colors: { type: "array", items: { type: "string" }, description: "Cores que a dona disse no recado (prioridade) ou que aparecem nas fotos; uma grafia por cor." },
    sizes: { type: "array", items: { type: "string" }, description: "Tamanhos ditos no recado, já expandidos ('do P ao GG' = P, M, G, GG); vazio se ela não disse." },
    sizeRange: {
      type: ["object", "null"],
      description: "A faixa como foi dita ('do P ao GG'), quando houver — além de sizes.",
      properties: { from: { type: "string" }, to: { type: "string" } },
      required: ["from", "to"],
      additionalProperties: false,
    },
    quantityPerVariant: { type: ["number", "null"], description: "Peças por combinação de cor e tamanho ('três de cada' = 3), ou null." },
    totalQuantity: { type: ["number", "null"], description: "Total de peças, se a dona disse o total em vez de 'de cada'; senão null." },
    costCents: { type: ["number", "null"], description: "Custo em CENTAVOS ('custou 120' = 12000), ou null." },
    costBasis: { type: "string", enum: ["per_piece", "total", "unknown"], description: "O custo é por peça, o total da compra, ou não dá para saber." },
    supplierName: { type: ["string", "null"], description: "Fornecedor citado ('da Aurora' = Aurora); prefira a grafia da lista de fornecedores; null se não citado." },
    weightGramsEstimate: { type: ["number", "null"], description: `Peso estimado em gramas (${DRAFT_WEIGHT_MIN_GRAMS}–${DRAFT_WEIGHT_MAX_GRAMS}) ou null.` },
    warnings: { type: "array", items: { type: "string" }, description: "O que ficou em dúvida no recado ou nas fotos, em pt-BR." },
  },
  required: [
    "name",
    "categorySlug",
    "description",
    "composition",
    "careSymbols",
    "careFreeText",
    "fitNotes",
    "colors",
    "sizes",
    "sizeRange",
    "quantityPerVariant",
    "totalQuantity",
    "costCents",
    "costBasis",
    "supplierName",
    "weightGramsEstimate",
    "warnings",
  ],
  additionalProperties: false,
};

export type ArrivalProposal = {
  name: string;
  categoryId: string | null;
  categoryName: string | null;
  description: string;
  composition: string;
  careSymbols: CareSymbolKey[];
  careFreeText: string[];
  fitNotes: string;
  colors: string[];
  sizes: string[];
  /** Combinações da grade (cor × tamanho; 1 quando não há eixo). */
  variantCount: number;
  quantityPerVariant: number | null;
  totalQuantity: number | null;
  /** Só quando se sabe a base: com costBasis 'unknown' o custo NÃO vai para a grade. */
  unitCostCents: number | null;
  totalCostCents: number | null;
  /** O valor dito quando não dá para saber se é por peça ou o lote (fica no painel e no aviso). */
  unconfirmedCostCents: number | null;
  costBasis: "per_piece" | "total" | "unknown";
  supplierName: string | null;
  weightGrams: number | null;
  warnings: string[];
};

export type ArrivalCategory = { id: string; name: string; slug: string };

function uniqueNormalized(values: readonly string[], max: number): { kept: string[]; dropped: number } {
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

function wholeOrNull(value: number | null, max: number): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  return rounded > 0 && rounded <= max ? rounded : null;
}

/** O valor veio, mas fora do que faz sentido: some da ficha e vira aviso. */
function outOfRange(value: number | null, max: number): boolean {
  if (value === null || !Number.isFinite(value)) return false;
  const rounded = Math.round(value);
  return rounded <= 0 || rounded > max;
}

/**
 * Do JSON do modelo à proposta: sala pelo slug (desconhecida = null + aviso),
 * cores/tamanhos no padrão da grade (faixa expandida quando a lista veio
 * vazia), quantidade e custo conferidos e o custo por peça/total derivado
 * quando dá; o que não fecha vira aviso. Lança ZodError fora do formato.
 */
export function normalizeArrivalProposal(raw: unknown, opts: { categories: readonly ArrivalCategory[] }): ArrivalProposal {
  const parsed = rawArrivalProposalSchema.parse(raw);
  const warnings = parsed.warnings.map((warning) => warning.trim()).filter((warning) => warning !== "");

  const name = parsed.name.trim().slice(0, 80);

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
  if (description.length > 0 && description.length < DESCRIPTION_MIN_CHARS) {
    warnings.push(`Descrição curta (${description.length} caracteres; a peça fica pronta com ${DESCRIPTION_MIN_CHARS}).`);
  }

  const colorsRead = uniqueNormalized(parsed.colors, DRAFT_MAX_COLORS);
  if (colorsRead.dropped > 0) warnings.push(`Só as ${DRAFT_MAX_COLORS} primeiras cores entraram.`);

  const sizesSource =
    parsed.sizes.length > 0 ? parsed.sizes : parsed.sizeRange ? expandSizeRange(parsed.sizeRange.from, parsed.sizeRange.to) : [];
  if (parsed.sizes.length === 0 && parsed.sizeRange && sizesSource.length === 0) {
    warnings.push(`Não entendi a faixa de tamanhos "${parsed.sizeRange.from} a ${parsed.sizeRange.to}": confira a grade.`);
  }
  const sizesRead = uniqueNormalized(sizesSource, DRAFT_MAX_SIZES);
  const sizes = [...sizesRead.kept].sort((a, b) => sizeRank(a) - sizeRank(b));
  if (sizesRead.dropped > 0) warnings.push(`Só os ${DRAFT_MAX_SIZES} primeiros tamanhos entraram.`);

  const variantCount = Math.max(1, colorsRead.kept.length) * Math.max(1, sizes.length);
  const quantityPerVariant = wholeOrNull(parsed.quantityPerVariant, ARRIVAL_MAX_QUANTITY);
  if (outOfRange(parsed.quantityPerVariant, ARRIVAL_MAX_QUANTITY)) {
    warnings.push(`Quantidade por combinação fora do esperado (${Math.round(parsed.quantityPerVariant as number)}): confira na ficha.`);
  }
  const saidTotal = wholeOrNull(parsed.totalQuantity, ARRIVAL_MAX_QUANTITY * 100);
  if (outOfRange(parsed.totalQuantity, ARRIVAL_MAX_QUANTITY * 100)) {
    warnings.push(`Total de peças fora do esperado (${Math.round(parsed.totalQuantity as number)}): confira na ficha.`);
  }
  let totalQuantity = saidTotal;
  if (quantityPerVariant !== null) {
    totalQuantity = quantityPerVariant * variantCount;
    if (saidTotal !== null && saidTotal !== totalQuantity) {
      warnings.push(
        `Você disse ${saidTotal} peças, mas ${quantityPerVariant} de cada em ${variantCount} ${variantCount === 1 ? "combinação" : "combinações"} dá ${totalQuantity}: confira cores e tamanhos.`,
      );
    }
  }

  const costCents = wholeOrNull(parsed.costCents, ARRIVAL_MAX_COST_CENTS);
  if (outOfRange(parsed.costCents, ARRIVAL_MAX_COST_CENTS)) {
    warnings.push(`Custo fora do esperado (${formatCentsBRL(Math.max(0, Math.round(parsed.costCents as number)))}): confira na ficha.`);
  }
  let unitCostCents: number | null = null;
  let totalCostCents: number | null = null;
  let unconfirmedCostCents: number | null = null;
  const costBasis = parsed.costBasis;
  if (costCents !== null) {
    if (costBasis === "unknown") {
      // Sem saber se é por peça ou o lote, o custo não entra na grade: fica
      // para a dona confirmar na ficha (e no passo da compra).
      unconfirmedCostCents = costCents;
      warnings.push(`Não deu para saber se ${formatCentsBRL(costCents)} é por peça ou o total da compra: confira o custo na ficha.`);
    } else if (costBasis === "per_piece") {
      unitCostCents = costCents;
      totalCostCents = totalQuantity !== null ? costCents * totalQuantity : null;
    } else {
      // O total é o que ela pagou: o custo por peça sai do total dito (se
      // houve), senão da grade.
      totalCostCents = costCents;
      const pieces = saidTotal ?? totalQuantity;
      unitCostCents = pieces !== null && pieces > 0 ? Math.round(costCents / pieces) : null;
      if (unitCostCents === null) warnings.push("Custo total sem a quantidade: não dá para saber o custo por peça.");
    }
  }

  const weightGrams =
    parsed.weightGramsEstimate !== null &&
    Number.isFinite(parsed.weightGramsEstimate) &&
    parsed.weightGramsEstimate >= DRAFT_WEIGHT_MIN_GRAMS &&
    parsed.weightGramsEstimate <= DRAFT_WEIGHT_MAX_GRAMS
      ? Math.round(parsed.weightGramsEstimate)
      : null;

  // Texto livre que repete um pictograma vira o pictograma (sem duplicar no
  // painel); linhas e conjunto limitados para a ficha aceitar.
  const careNotes = parseCareNotes(
    parsed.careFreeText
      .split(/\n|;/)
      .map((line) => line.trim().slice(0, ARRIVAL_CARE_LINE_MAX))
      .filter((line) => line !== "")
      .join("\n"),
  );
  const careSymbols = [...new Set([...parsed.careSymbols.filter(isCareSymbolKey), ...careNotes.symbols])];
  const careFreeText: string[] = [];
  let careChars = 0;
  for (const line of careNotes.freeText) {
    if (careChars + line.length > ARRIVAL_CARE_TOTAL_MAX) {
      warnings.push("Cuidados em texto longos demais: parte ficou de fora — complete na ficha.");
      break;
    }
    careFreeText.push(line);
    careChars += line.length + 1;
  }

  const supplierName = parsed.supplierName?.trim().slice(0, 120) || null;

  return {
    name,
    categoryId,
    categoryName,
    description,
    composition: parsed.composition.trim().slice(0, 200),
    careSymbols,
    careFreeText,
    fitNotes: parsed.fitNotes.trim().slice(0, 600),
    colors: colorsRead.kept,
    sizes,
    variantCount,
    quantityPerVariant,
    totalQuantity,
    unitCostCents,
    totalCostCents,
    unconfirmedCostCents,
    costBasis,
    supplierName,
    weightGrams,
    warnings,
  };
}

/** Rótulo legível dos cuidados (para o painel). */
export function careLabels(proposal: Pick<ArrivalProposal, "careSymbols" | "careFreeText">): string[] {
  return [...proposal.careSymbols.map((key) => CARE_SYMBOLS[key].label), ...proposal.careFreeText];
}

/** O que a chegada guarda em `parsed` (jsonb): a proposta e o custo da inteligência. */
export const atelierParsedSchema = z
  .object({
    proposal: z.custom<ArrivalProposal>((value) => typeof value === "object" && value !== null).nullable(),
    suggestedPriceCents: z.number().nullable(),
    model: z.string(),
    usage: z
      .object({
        inputTokens: z.number(),
        outputTokens: z.number(),
        cacheReadTokens: z.number().optional(),
        cacheWriteTokens: z.number().optional(),
      })
      .nullable(),
    estimatedCostUsdCents: z.number(),
    ms: z.number(),
    /** Por que a grade não saiu (a ficha nasceu simples, como no C-A). */
    failed: z.string().nullable(),
    /** O que a compra fez (C-C): peças lançadas, o motivo de não lançar, o que falhou. */
    purchase: z
      .object({
        movements: z.number(),
        totalQuantity: z.number().nullable(),
        skipped: z.string().nullable(),
        supplierError: z.string().nullable(),
        purchaseError: z.string().nullable(),
      })
      .optional(),
  })
  .loose();

export type AtelierParsed = z.infer<typeof atelierParsedSchema>;

export function parseAtelierParsed(raw: unknown): AtelierParsed | null {
  const result = atelierParsedSchema.safeParse(raw);
  return result.success ? result.data : null;
}
