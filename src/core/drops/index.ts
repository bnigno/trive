// Lançamentos com janela VIP: as peças ficam escondidas até a data de
// publicação e, algumas horas antes, as clientes cuja cartela conversa com
// elas recebem o convite. Puro: fases, regras para agendar, pontuação de
// afinidade e o ranking do público.
import { sizeMatches } from "@/core/catalog/sizes";
import type { StyleProfile } from "@/core/style/profile";
import { sizeKeyForCategory } from "@/core/style/profile";

export const DROP_STATUSES = ["draft", "scheduled", "vip_sent", "published", "canceled"] as const;
export type DropStatus = (typeof DROP_STATUSES)[number];

export type DropPhase = "draft" | "scheduled" | "vip" | "published" | "canceled";

export const DROP_ELIGIBLE_MIN_SCORE = 2;
export const DROP_MAX_PRODUCTS = 12;

export function vipStartsAt(publishAt: Date, vipWindowHours: number): Date {
  return new Date(publishAt.getTime() - vipWindowHours * 3_600_000);
}

/**
 * O que /estreia mostra: 'hidden' (nada agendado, rascunho ou cancelado),
 * 'teaser' (agendado: contagem + silhuetas), 'open' (a cortina abriu). Segue
 * o relógio, não o cron: na hora marcada a página abre mesmo antes do publish.
 */
export type TeaserState = "hidden" | "teaser" | "open";

export function teaserState(
  drop: { status: string; publishAt: Date; vipWindowHours: number } | null | undefined,
  now: Date,
): TeaserState {
  if (!drop) return "hidden";
  const phase = dropPhase(drop, now);
  if (phase === "draft" || phase === "canceled") return "hidden";
  return phase === "published" ? "open" : "teaser";
}

/** Depois de aberta, a estreia fica em cartaz por um dia em /estreia. */
export const TEASER_OPEN_GRACE_MS = 24 * 60 * 60 * 1000;

const SP_TIME_ZONE = "America/Sao_Paulo";
const weekdayFormatter = new Intl.DateTimeFormat("pt-BR", { weekday: "long", timeZone: SP_TIME_ZONE });
const dayMonthFormatter = new Intl.DateTimeFormat("pt-BR", { day: "numeric", month: "long", timeZone: SP_TIME_ZONE });
const hourFormatter = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: SP_TIME_ZONE });

/**
 * "sábado, 20h" (até 6 dias à frente), "20 de setembro, 20h" (mais longe),
 * "hoje, 20h" / "amanhã, 20h30"; sempre no relógio de São Paulo.
 */
export function publicDropLabel(publishAt: Date, now: Date): string {
  const [hh, mm] = hourFormatter.format(publishAt).split(":");
  const hora = mm === "00" ? `${Number(hh)}h` : `${Number(hh)}h${mm}`;
  const dayKey = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: SP_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const today = dayKey(now);
  const target = dayKey(publishAt);
  if (target === today) return `hoje, ${hora}`;
  if (target === dayKey(new Date(now.getTime() + 24 * 60 * 60 * 1000))) return `amanhã, ${hora}`;
  const diffMs = publishAt.getTime() - now.getTime();
  if (diffMs > 0 && diffMs < 6 * 24 * 60 * 60 * 1000) {
    return `${weekdayFormatter.format(publishAt)}, ${hora}`;
  }
  return `${dayMonthFormatter.format(publishAt)}, ${hora}`;
}

export type CountdownParts = { days: number; hours: number; minutes: number; seconds: number; total: number };

/** Partes da contagem regressiva (nunca negativas; total em ms). */
export function countdownParts(publishAt: Date, now: Date): CountdownParts {
  const total = Math.max(0, publishAt.getTime() - now.getTime());
  const seconds = Math.floor(total / 1000);
  return {
    days: Math.floor(seconds / 86_400),
    hours: Math.floor((seconds % 86_400) / 3_600),
    minutes: Math.floor((seconds % 3_600) / 60),
    seconds: seconds % 60,
    total,
  };
}

export function dropPhase(
  drop: { status: string; publishAt: Date; vipWindowHours: number },
  now: Date,
): DropPhase {
  if (drop.status === "canceled") return "canceled";
  if (drop.status === "draft") return "draft";
  if (drop.status === "published" || now.getTime() >= drop.publishAt.getTime()) return "published";
  if (now.getTime() >= vipStartsAt(drop.publishAt, drop.vipWindowHours).getTime()) return "vip";
  return "scheduled";
}

export interface DropProductFacts {
  id: string;
  name: string;
  status: string;
  hasActivePrice: boolean;
  hasStock: boolean;
  hasPhoto: boolean;
}

/** O que impede de agendar — lista vazia = pode. */
export function canSchedule(
  drop: { publishAt: Date; vipWindowHours: number; products: DropProductFacts[] },
  now: Date,
): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  if (drop.publishAt.getTime() <= now.getTime()) problems.push("A data de publicação já passou.");
  if (vipStartsAt(drop.publishAt, drop.vipWindowHours).getTime() <= now.getTime()) {
    problems.push("A janela VIP já teria começado — escolha uma data mais à frente ou uma janela menor.");
  }
  if (drop.products.length === 0) problems.push("Escolha ao menos uma peça.");
  if (drop.products.length > DROP_MAX_PRODUCTS) problems.push(`No máximo ${DROP_MAX_PRODUCTS} peças por lançamento.`);
  for (const product of drop.products) {
    if (product.status === "archived") problems.push(`${product.name}: peça arquivada.`);
    if (!product.hasActivePrice) problems.push(`${product.name}: sem preço ativo.`);
    if (!product.hasStock) problems.push(`${product.name}: sem estoque.`);
    if (!product.hasPhoto) problems.push(`${product.name}: sem foto.`);
  }
  return { ok: problems.length === 0, problems };
}

// ---------------------------------------------------------------------------
// Afinidade
// ---------------------------------------------------------------------------

export interface DropAffinityProduct {
  id: string;
  name: string;
  categoryId: string | null;
  categoryName: string | null;
  sizesAvailable: string[];
  colorsAvailable: string[];
}

export interface AudienceCandidate {
  customerId: string;
  phoneE164: string;
  fullName: string;
  profile: StyleProfile | null;
  /** Categorias que ela já comprou (ids). */
  purchasedCategoryIds: string[];
}

export interface AffinityResult {
  score: number;
  reasons: string[];
}

function fold(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();
}

/**
 * Pontuação de UMA cliente para UMA peça: +3 tamanho da cartela com estoque,
 * +2 cor amada com estoque, +2 já comprou a categoria, −4 quando todas as
 * cores da peça são evitadas. O lançamento usa a melhor peça.
 */
export function scoreProductAffinity(candidate: AudienceCandidate, product: DropAffinityProduct): AffinityResult {
  const reasons: string[] = [];
  let score = 0;
  const profile = candidate.profile;
  if (profile) {
    const sizeKey = sizeKeyForCategory(product.categoryName, product.name);
    const wanted = sizeKey ? profile.sizes[sizeKey] : undefined;
    if (wanted && product.sizesAvailable.some((size) => sizeMatches(size, wanted))) {
      score += 3;
      reasons.push(`tem o ${wanted} dela`);
    }
    const loved = profile.colorsLove.map(fold);
    const lovedMatch = product.colorsAvailable.find((color) => loved.some((love) => fold(color).includes(love) || love.includes(fold(color))));
    if (lovedMatch) {
      score += 2;
      reasons.push(`em ${lovedMatch}, cor que ela ama`);
    }
    const avoided = profile.colorsAvoid.map(fold);
    if (
      product.colorsAvailable.length > 0 &&
      avoided.length > 0 &&
      product.colorsAvailable.every((color) => avoided.some((avoid) => fold(color).includes(avoid) || avoid.includes(fold(color))))
    ) {
      score -= 4;
    }
  }
  if (product.categoryId && candidate.purchasedCategoryIds.includes(product.categoryId)) {
    score += 2;
    reasons.push(`já comprou ${product.categoryName ?? "nesta categoria"}`);
  }
  return { score, reasons };
}

export function scoreDropAffinity(candidate: AudienceCandidate, products: readonly DropAffinityProduct[]): AffinityResult {
  let best: AffinityResult = { score: 0, reasons: [] };
  for (const product of products) {
    const result = scoreProductAffinity(candidate, product);
    if (result.score > best.score) best = result;
  }
  return best;
}

export interface RankedInvite {
  customerId: string;
  phoneE164: string;
  fullName: string;
  score: number;
  reasons: string[];
}

/** Elegíveis (≥ 2 pontos), da maior afinidade para a menor, até o limite. */
export function rankAudience(
  candidates: readonly AudienceCandidate[],
  products: readonly DropAffinityProduct[],
  limit: number,
): RankedInvite[] {
  return candidates
    .map((candidate) => ({ candidate, ...scoreDropAffinity(candidate, products) }))
    .filter((entry) => entry.score >= DROP_ELIGIBLE_MIN_SCORE)
    .sort((a, b) => b.score - a.score || a.candidate.fullName.localeCompare(b.candidate.fullName, "pt-BR"))
    .slice(0, Math.max(0, limit))
    .map(({ candidate, score, reasons }) => ({
      customerId: candidate.customerId,
      phoneE164: candidate.phoneE164,
      fullName: candidate.fullName,
      score,
      reasons,
    }));
}
