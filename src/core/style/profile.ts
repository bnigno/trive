// A cartela de estilo da cliente ("espelho de estilo"): o que ela contou
// sobre tamanhos, cores, caimento, ocasiões e para quem compra. Puro: schema,
// merge sem perder o que já se sabia, nome poético determinístico, chave de
// tamanho por família de peça e a nota para o caderninho da vendedora.
import { z } from "zod";

import { lookFamilyOf } from "@/core/bot/look";

export const FITS = ["justo", "fluido", "tanto_faz"] as const;
export type Fit = (typeof FITS)[number];

export const SIZE_KEYS = ["vestido", "blusa", "calca"] as const;
export type SizeKey = (typeof SIZE_KEYS)[number];

export const OCCASIONS = [
  "trabalho",
  "dia_a_dia",
  "festa",
  "casamento",
  "viagem",
  "praia",
  "jantar",
] as const;
export type Occasion = (typeof OCCASIONS)[number];

export const OCCASION_LABELS: Record<Occasion, string> = {
  trabalho: "Trabalho",
  dia_a_dia: "Dia a dia",
  festa: "Festa",
  casamento: "Casamento",
  viagem: "Viagem",
  praia: "Praia",
  jantar: "Jantar",
};

export const BUYS_FOR = ["mim", "presente", "os_dois"] as const;
export type BuysFor = (typeof BUYS_FOR)[number];

const sizeValue = z.string().trim().min(1).max(8);
const colorList = z.array(z.string().trim().min(1).max(40)).max(8);

export const styleProfileSchema = z.object({
  sizes: z
    .object({
      vestido: sizeValue.optional(),
      blusa: sizeValue.optional(),
      calca: sizeValue.optional(),
    })
    .default({}),
  colorsLove: colorList.default([]),
  colorsAvoid: colorList.default([]),
  fit: z.enum(FITS).nullable().default(null),
  occasions: z.array(z.enum(OCCASIONS)).max(7).default([]),
  buysFor: z.enum(BUYS_FOR).nullable().default(null),
});

export type StyleProfile = z.infer<typeof styleProfileSchema>;
export type StyleProfileInput = z.input<typeof styleProfileSchema>;

/** Patch: só o que chegou; campo ausente = "não mexa" (sem defaults). */
export const styleProfilePatchSchema = z.object({
  sizes: z
    .object({
      vestido: sizeValue.optional(),
      blusa: sizeValue.optional(),
      calca: sizeValue.optional(),
    })
    .optional(),
  colorsLove: colorList.optional(),
  colorsAvoid: colorList.optional(),
  fit: z.enum(FITS).nullable().optional(),
  occasions: z.array(z.enum(OCCASIONS)).max(7).optional(),
  buysFor: z.enum(BUYS_FOR).nullable().optional(),
});

export type StyleProfilePatch = z.input<typeof styleProfilePatchSchema>;

export const EMPTY_PROFILE: StyleProfile = {
  sizes: {},
  colorsLove: [],
  colorsAvoid: [],
  fit: null,
  occasions: [],
  buysFor: null,
};

function foldColor(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();
}

function uniqueColors(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = foldColor(value);
    if (key === "" || seen.has(key)) continue;
    seen.add(key);
    out.push(value.trim());
  }
  return out.slice(0, 8);
}

/**
 * Junta o que já se sabia com o que chegou agora: tamanhos e listas novas
 * substituem campo a campo; cor que passou a ser amada sai das evitadas (e
 * vice-versa); campo ausente no patch não apaga o anterior.
 */
export function mergeStyleProfile(current: StyleProfile, patch: StyleProfilePatch): StyleProfile {
  const parsedPatch = styleProfilePatchSchema.parse(patch);
  const sizes = { ...current.sizes, ...(parsedPatch.sizes ?? {}) };

  // A declaração mais nova vence: cor que acabou de ser amada sai das
  // evitadas; cor que acabou de ser evitada sai das amadas.
  let love = parsedPatch.colorsLove !== undefined ? uniqueColors(parsedPatch.colorsLove) : current.colorsLove;
  let avoid = parsedPatch.colorsAvoid !== undefined ? uniqueColors(parsedPatch.colorsAvoid) : current.colorsAvoid;
  if (parsedPatch.colorsLove !== undefined) {
    const loveKeys = new Set(love.map(foldColor));
    avoid = avoid.filter((color) => !loveKeys.has(foldColor(color)));
  } else if (parsedPatch.colorsAvoid !== undefined) {
    const avoidKeys = new Set(avoid.map(foldColor));
    love = love.filter((color) => !avoidKeys.has(foldColor(color)));
  }

  return {
    sizes: Object.fromEntries(Object.entries(sizes).filter(([, v]) => typeof v === "string" && v !== "")) as StyleProfile["sizes"],
    colorsLove: love,
    colorsAvoid: avoid,
    fit: parsedPatch.fit !== undefined ? parsedPatch.fit : current.fit,
    occasions: parsedPatch.occasions !== undefined ? [...new Set(parsedPatch.occasions)] : current.occasions,
    buysFor: parsedPatch.buysFor !== undefined ? parsedPatch.buysFor : current.buysFor,
  };
}

export function isProfileEmpty(profile: StyleProfile): boolean {
  return (
    Object.keys(profile.sizes).length === 0 &&
    profile.colorsLove.length === 0 &&
    profile.colorsAvoid.length === 0 &&
    profile.fit === null &&
    profile.occasions.length === 0 &&
    profile.buysFor === null
  );
}

// ---------------------------------------------------------------------------
// Nome poético da cartela — determinístico pela cor amada e pelo caimento
// ---------------------------------------------------------------------------

const COLOR_FAMILY: [RegExp, string][] = [
  [/preto|noir|black|grafite|chumbo/i, "Noite"],
  [/branco|off|cru|nude|areia|bege|champagne/i, "Areia"],
  [/caramelo|camel|mel|terracota|tijolo|ferrugem|marrom|chocolate|caf[eé]|tabaco|espresso/i, "Terra"],
  [/vinho|bord[oô]|marsala|vermelho|cereja/i, "Vinho"],
  [/rosa|blush|ros[eé]|lil[áa]s|lavanda/i, "Pétala"],
  [/verde|oliva|esmeralda|menta|s[aá]lvia|militar|caqui/i, "Bosque"],
  [/azul|marinho|navy|celeste|petr[óo]leo/i, "Maré"],
  [/amarelo|mostarda|ouro|dourado|laranja|tangerina/i, "Sol"],
  [/cinza|prata|silver|metal/i, "Névoa"],
];

const FIT_WORD: Record<Fit, string> = { justo: "precisa", fluido: "fluida", tanto_faz: "livre" };

/** "Terra fluida", "Noite precisa", "Areia livre"… ou "Cartela em aberto". */
export function paletteName(profile: StyleProfile): string {
  const firstColor = profile.colorsLove[0];
  const family = firstColor ? COLOR_FAMILY.find(([pattern]) => pattern.test(firstColor))?.[1] : undefined;
  const base = family ?? (firstColor ? "Cor própria" : null);
  if (!base) return profile.fit ? `Silhueta ${FIT_WORD[profile.fit]}` : "Cartela em aberto";
  return `${base} ${FIT_WORD[profile.fit ?? "tanto_faz"]}`;
}

/** Qual tamanho da cartela vale para esta peça (pela família do nome/categoria). */
export function sizeKeyForCategory(categoryName: string | null, productName: string): SizeKey | null {
  const family = lookFamilyOf(categoryName, productName);
  if (family === "vestido") return "vestido";
  if (family === "top" || family === "sobreposicao") return "blusa";
  if (family === "parte-de-baixo") return "calca";
  return null;
}

const SIZE_LABEL: Record<SizeKey, string> = { vestido: "vestidos", blusa: "blusas", calca: "calças/saias" };
const FIT_LABEL: Record<Fit, string> = { justo: "mais justo", fluido: "mais fluido", tanto_faz: "tanto faz" };
const BUYS_FOR_LABEL: Record<BuysFor, string> = { mim: "para ela mesma", presente: "para presentear", os_dois: "para ela e para presentear" };

/** Linhas para o caderninho da vendedora; [] quando não há nada. */
export function renderProfileNote(profile: StyleProfile, palette?: string | null, opts: { hasBody?: boolean } = {}): string[] {
  const lines: string[] = [];
  const sizes = SIZE_KEYS.filter((key) => profile.sizes[key]).map((key) => `${SIZE_LABEL[key]} ${profile.sizes[key]}`);
  const parts: string[] = [];
  if (sizes.length > 0) parts.push(`veste ${sizes.join(", ")}`);
  if (profile.colorsLove.length > 0) parts.push(`ama ${profile.colorsLove.join(", ")}`);
  if (profile.colorsAvoid.length > 0) parts.push(`evita ${profile.colorsAvoid.join(", ")}`);
  if (profile.fit) parts.push(`caimento ${FIT_LABEL[profile.fit]}`);
  if (profile.occasions.length > 0) parts.push(`ocasiões: ${profile.occasions.map((o) => OCCASION_LABELS[o].toLowerCase()).join(", ")}`);
  if (profile.buysFor) parts.push(`compra ${BUYS_FOR_LABEL[profile.buysFor]}`);
  // As medidas nunca entram aqui (dado do corpo fica fora do histórico); só o fato de existirem.
  if (opts.hasBody) parts.push("medidas do corpo guardadas");
  if (parts.length === 0) return lines;
  lines.push(`Cartela de estilo${palette ? ` "${palette}"` : ""}: ${parts.join("; ")} — use o tamanho como filtro sem perguntar de novo.`);
  return lines;
}
