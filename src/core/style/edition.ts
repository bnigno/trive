// "A edição para você": escolhe as peças do catálogo que conversam com a
// cartela — tamanho dela com estoque, cor amada, nunca só cores evitadas,
// categorias variadas — e explica cada escolha numa frase curta. Puro.
import { lookFamilyOf } from "@/core/bot/look";

import { sizeKeyForCategory, type StyleProfile } from "./profile";

export interface EditionCandidate {
  id: string;
  slug: string;
  name: string;
  categoryName: string | null;
  priceFromCents: number;
  imagePath: string | null;
  /** Tamanhos com estoque (valores do eixo "tamanho"). */
  sizesAvailable: string[];
  /** Cores com estoque (valores do eixo "cor"). */
  colorsAvailable: string[];
}

export interface EditionPick {
  candidate: EditionCandidate;
  score: number;
  /** "no seu M", "em Verde", "para casamento"… */
  reasons: string[];
}

function fold(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();
}

const OCCASION_HINTS: Record<string, RegExp> = {
  trabalho: /alfaiataria|blazer|camisa|social|pantalona|escrit/i,
  festa: /festa|brilho|paet|cetim|seda|longo|noite/i,
  casamento: /longo|midi|cetim|seda|festa|convidad/i,
  viagem: /linho|malha|leve|conforto|viagem|kimono/i,
  praia: /praia|sa[ií]da|linho|verão|verao|crochê|croche/i,
  jantar: /midi|seda|cetim|jantar|noite/i,
  dia_a_dia: /camiseta|t-shirt|jeans|malha|algod|b[aá]sic|dia a dia/i,
};

/**
 * Pontuação: +3 tamanho da cartela com estoque, +2 alguma cor amada com
 * estoque, +1 ocasião sugerida pelo nome, −4 quando TODAS as cores da peça
 * são evitadas. Sem foto não entra. Empate: mais barato primeiro.
 */
export function scoreCandidate(profile: StyleProfile, candidate: EditionCandidate): EditionPick {
  const reasons: string[] = [];
  let score = 0;
  const sizeKey = sizeKeyForCategory(candidate.categoryName, candidate.name);
  const wanted = sizeKey ? profile.sizes[sizeKey] : undefined;
  if (wanted && candidate.sizesAvailable.some((size) => fold(size) === fold(wanted))) {
    score += 3;
    reasons.push(`no seu ${wanted}`);
  }
  const loved = profile.colorsLove.map(fold);
  const lovedMatch = candidate.colorsAvailable.find((color) => loved.some((love) => fold(color).includes(love) || love.includes(fold(color))));
  if (lovedMatch) {
    score += 2;
    reasons.push(`em ${lovedMatch}`);
  }
  const avoided = profile.colorsAvoid.map(fold);
  if (
    candidate.colorsAvailable.length > 0 &&
    avoided.length > 0 &&
    candidate.colorsAvailable.every((color) => avoided.some((avoid) => fold(color).includes(avoid) || avoid.includes(fold(color))))
  ) {
    score -= 4;
  }
  for (const occasion of profile.occasions) {
    const hint = OCCASION_HINTS[occasion];
    if (hint && hint.test(candidate.name)) {
      score += 1;
      reasons.push(`para ${occasion === "dia_a_dia" ? "o dia a dia" : occasion}`);
      break;
    }
  }
  return { candidate, score, reasons };
}

/**
 * Até `limit` peças, diversificadas por família (vestido/top/parte de baixo…):
 * a segunda peça da mesma família só entra quando não há outra família com
 * pontuação positiva. Devolve [] quando nada pontua acima de zero.
 */
export function buildEditionForProfile(
  profile: StyleProfile,
  candidates: readonly EditionCandidate[],
  opts: { limit?: number } = {},
): EditionPick[] {
  const limit = opts.limit ?? 3;
  const scored = candidates
    .filter((candidate) => candidate.imagePath)
    .map((candidate) => scoreCandidate(profile, candidate))
    .filter((pick) => pick.score > 0)
    .sort((a, b) => b.score - a.score || a.candidate.priceFromCents - b.candidate.priceFromCents);

  const picks: EditionPick[] = [];
  const families = new Set<string>();
  for (const pick of scored) {
    if (picks.length >= limit) break;
    const family = lookFamilyOf(pick.candidate.categoryName, pick.candidate.name) ?? `outra:${pick.candidate.categoryName ?? ""}`;
    if (families.has(family)) continue;
    families.add(family);
    picks.push(pick);
  }
  if (picks.length < limit) {
    for (const pick of scored) {
      if (picks.length >= limit) break;
      if (!picks.includes(pick)) picks.push(pick);
    }
  }
  return picks;
}
