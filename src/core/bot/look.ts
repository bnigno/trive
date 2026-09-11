// "Montar o look": dada uma peça (hero) e o catálogo disponível, escolhe 1–2
// complementos honestos — categoria diferente e complementar, preço na
// vizinhança, com foto e estoque — sem inventar combinação. Com a cartela
// de estilo, peça disponível SÓ em cores que a cliente evita fica de fora e
// cor que ela ama ganha um empurrão. Puro.

export interface LookCandidate {
  id: string;
  slug: string;
  name: string;
  categoryName: string | null;
  priceCents: number;
  available: boolean;
  imagePath: string | null;
  /** Cores com estoque (eixo "cor"); ausente/vazio = peça sem cor cadastrada. */
  colors?: readonly string[];
}

export interface LookHero {
  id: string;
  name: string;
  categoryName: string | null;
  priceCents: number;
}

export interface LookPick {
  item: LookCandidate;
  reason: string;
}

type Family = {
  key: string;
  match: RegExp;
  /** Famílias que completam esta, da mais natural para a menos. */
  complements: string[];
};

const FAMILIES: Family[] = [
  { key: "vestido", match: /vestid|longo|midi|macac/i, complements: ["bolsa", "acessorio", "sapato", "sobreposicao"] },
  { key: "top", match: /blusa|camis|t-shirt|top|cropped|regata|body|tric[oô]|malha|moletom|su[eé]ter|baby\s*look/i, complements: ["parte-de-baixo", "sobreposicao", "bolsa", "acessorio"] },
  { key: "parte-de-baixo", match: /cal[cç]a|jeans|pantalona|short|bermuda|saia|legging/i, complements: ["top", "sobreposicao", "bolsa", "sapato", "acessorio"] },
  { key: "sobreposicao", match: /casaco|blazer|jaqueta|cardig|kimono|colete|parka|trench|sobretudo/i, complements: ["vestido", "top", "parte-de-baixo"] },
  { key: "bolsa", match: /bolsa|tote|clutch|mochila|carteira|necessaire/i, complements: ["vestido", "top", "parte-de-baixo"] },
  { key: "sapato", match: /sapat|sand[aá]l|t[eê]nis|bota|rasteir|mule|scarpin|chinel/i, complements: ["vestido", "parte-de-baixo", "top"] },
  { key: "acessorio", match: /acess|colar|brinco|cinto|len[cç]o|[oó]culos|chap[eé]u|bon[eé]|pulseira|anel|meia|echarpe|cachecol|gorro/i, complements: ["vestido", "top", "parte-de-baixo"] },
];

/** O que nunca entra num look de moda (utilidades da categoria "Casa" etc.). */
const NEVER_IN_LOOK = /caneca|garrafa|adesivo|copo|decora|casa\b|caderno|kit de adesivos|t[eé]rmic/i;

export function lookFamilyOf(categoryName: string | null, name: string): string | null {
  const text = `${categoryName ?? ""} ${name}`;
  if (NEVER_IN_LOOK.test(text)) return null;
  // O nome da peça decide antes da categoria genérica ("Vestuário").
  for (const family of FAMILIES) if (family.match.test(name)) return family.key;
  for (const family of FAMILIES) if (family.match.test(categoryName ?? "")) return family.key;
  return null;
}

const PRICE_WINDOW = { min: 0.3, max: 1.2 };

/** "Vermelho" ~ "vermelho-escuro" ~ "VERMELHA": sem acento, sem caixa, um contém o outro. */
function foldColor(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
}

export function colorMatches(color: string, wanted: string): boolean {
  const a = foldColor(color);
  const b = foldColor(wanted);
  if (a === "" || b === "") return false;
  return a.includes(b) || b.includes(a);
}

/** Peça só em cores evitadas não entra no look; sem cor cadastrada, entra. */
export function isOnlyInAvoidedColors(colors: readonly string[] | undefined, avoid: readonly string[]): boolean {
  if (!colors || colors.length === 0 || avoid.length === 0) return false;
  return colors.every((color) => avoid.some((wanted) => colorMatches(color, wanted)));
}

export function lovedColorOf(colors: readonly string[] | undefined, love: readonly string[]): string | null {
  if (!colors || love.length === 0) return null;
  return colors.find((color) => love.some((wanted) => colorMatches(color, wanted))) ?? null;
}

function reasonFor(
  pick: LookCandidate,
  heroFamily: string | null,
  pickFamily: string | null,
  lovedColor: string | null,
): string {
  const base = (() => {
    if (heroFamily && pickFamily) {
      const family = FAMILIES.find((entry) => entry.key === heroFamily);
      if (family?.complements.includes(pickFamily)) {
        return `completa a peça (${pick.categoryName ?? pickFamily})`;
      }
    }
    return `outra categoria (${pick.categoryName ?? "peça"})`;
  })();
  return lovedColor ? `${base}; tem em ${lovedColor}, cor que ela ama` : base;
}

/**
 * Escolhe até `max` complementos: nunca a própria peça, nunca a mesma família,
 * só com foto e estoque; prefere família complementar (na ordem), preço entre
 * 30% e 120% da peça e categorias distintas entre si. Com `budgetCents`, a soma
 * (peça + complementos) respeita o teto. Com a cartela (`avoidColors`,
 * `loveColors`): peça só em cores evitadas fica de fora; cor amada soma 0,5.
 * Sem opção honesta devolve [].
 */
export function pickLookComplements(
  hero: LookHero,
  candidates: readonly LookCandidate[],
  opts: {
    max?: number;
    budgetCents?: number;
    avoidColors?: readonly string[];
    loveColors?: readonly string[];
  } = {},
): LookPick[] {
  const max = opts.max ?? 2;
  const avoid = opts.avoidColors ?? [];
  const love = opts.loveColors ?? [];
  const heroFamily = lookFamilyOf(hero.categoryName, hero.name);
  const preferred = heroFamily
    ? (FAMILIES.find((family) => family.key === heroFamily)?.complements ?? [])
    : [];

  const scored = candidates
    .filter((candidate) => candidate.id !== hero.id && candidate.available && candidate.imagePath)
    .map((candidate) => {
      const family = lookFamilyOf(candidate.categoryName, candidate.name);
      if (family === null) return null;
      if (heroFamily !== null && family === heroFamily) return null;
      if (isOnlyInAvoidedColors(candidate.colors, avoid)) return null;
      const rank = preferred.indexOf(family);
      let score = rank >= 0 ? 3 - rank * 0.25 : 0.5;
      const ratio = hero.priceCents > 0 ? candidate.priceCents / hero.priceCents : 1;
      if (ratio >= PRICE_WINDOW.min && ratio <= PRICE_WINDOW.max) score += 1;
      const lovedColor = lovedColorOf(candidate.colors, love);
      if (lovedColor) score += 0.5;
      return { candidate, family, score, lovedColor };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    .sort((a, b) => b.score - a.score || a.candidate.priceCents - b.candidate.priceCents);

  const picks: LookPick[] = [];
  const familiesUsed = new Set<string>();
  let spent = hero.priceCents;
  for (const entry of scored) {
    if (picks.length >= max) break;
    if (familiesUsed.has(entry.family)) continue;
    if (opts.budgetCents !== undefined && spent + entry.candidate.priceCents > opts.budgetCents) continue;
    familiesUsed.add(entry.family);
    spent += entry.candidate.priceCents;
    picks.push({
      item: entry.candidate,
      reason: reasonFor(entry.candidate, heroFamily, entry.family, entry.lovedColor),
    });
  }
  return picks;
}
