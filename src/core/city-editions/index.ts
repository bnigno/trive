// Edições de Belém (PURO): quando uma edição está "vigente" e qual manda
// quando duas coincidem. Regra combinada com a dona: hora do dia vence
// período, que vence "sempre" — a "Chuva das 14h" aparece por cima da
// "Edição Círio" das 14h às 16h, e a Círio por cima da edição permanente.
// Tudo no dia/relógio de São Paulo com `now` injetado. NÃO confundir com
// `core/edition` (singular): aquele é o cartão da caixa.
import { spDayKey, spMinutesOfDay } from "@/lib/sp-day";

export interface EditionRule {
  /** 'YYYY-MM-DD' inclusivo; null = sem começo. */
  startsOn: string | null;
  /** 'YYYY-MM-DD' inclusivo; null = sem fim. */
  endsOn: string | null;
  /** Hora de SP em que passa a valer (0–23); null = o dia inteiro. */
  hourStart: number | null;
  /** Hora em que deixa de valer (1–24, exclusiva); null = o dia inteiro. */
  hourEnd: number | null;
}

export type EditionKind = "always" | "period" | "hours" | "period_hours";

export function editionKind(rule: EditionRule): EditionKind {
  const hasPeriod = rule.startsOn !== null || rule.endsOn !== null;
  const hasHours = rule.hourStart !== null && rule.hourEnd !== null;
  if (hasPeriod && hasHours) return "period_hours";
  if (hasHours) return "hours";
  if (hasPeriod) return "period";
  return "always";
}

/** Peso na disputa entre edições vigentes: hora > período > sempre. */
const KIND_PRIORITY: Record<EditionKind, number> = { period_hours: 3, hours: 2, period: 1, always: 0 };

export function isEditionCurrent(rule: EditionRule, now: Date): boolean {
  const day = spDayKey(now);
  if (rule.startsOn !== null && day < rule.startsOn) return false;
  if (rule.endsOn !== null && day > rule.endsOn) return false;
  if (rule.hourStart !== null && rule.hourEnd !== null) {
    const hour = Math.floor(spMinutesOfDay(now) / 60);
    if (hour < rule.hourStart || hour >= rule.hourEnd) return false;
  }
  return true;
}

/** Ainda vai começar (período no futuro)? */
export function isEditionUpcoming(rule: EditionRule, now: Date): boolean {
  return rule.startsOn !== null && spDayKey(now) < rule.startsOn;
}

/** Já passou (período encerrado)? */
export function isEditionPast(rule: EditionRule, now: Date): boolean {
  return rule.endsOn !== null && spDayKey(now) > rule.endsOn;
}

/**
 * A edição que manda agora entre as ativas: a vigente de maior prioridade
 * (hora > período > sempre); empate → menor sortOrder, depois ordem da lista.
 */
export function pickCurrentEdition<T extends EditionRule & { sortOrder: number }>(editions: readonly T[], now: Date): T | null {
  let best: T | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const edition of editions) {
    if (!isEditionCurrent(edition, now)) continue;
    const score = KIND_PRIORITY[editionKind(edition)] * 1_000_000 - edition.sortOrder;
    if (best === null || score > bestScore) {
      best = edition;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Dias (no calendário de SP) até a edição começar: 0 = começa hoje ou já
 * está no ar; null = sem data de começo ou já terminou.
 */
export function daysUntilEdition(rule: EditionRule, now: Date): number | null {
  if (rule.startsOn === null || isEditionPast(rule, now)) return null;
  const today = spDayKey(now);
  if (today >= rule.startsOn) return 0;
  return Math.round((Date.parse(`${rule.startsOn}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86_400_000);
}

const MONTHS_PT = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"] as const;

function shortDate(key: string): string {
  const [, m, d] = key.split("-").map(Number);
  return `${d} ${MONTHS_PT[m - 1]}`;
}

/** "1 a 12 out" / "a partir de 1 out" / "até 12 out" / "das 14h às 16h" / "1 a 12 out · das 14h às 16h" / "sempre". */
export function editionPeriodLabel(rule: EditionRule): string {
  const parts: string[] = [];
  if (rule.startsOn !== null && rule.endsOn !== null) {
    parts.push(rule.startsOn === rule.endsOn ? `dia ${shortDate(rule.startsOn)}` : `${shortDate(rule.startsOn)} a ${shortDate(rule.endsOn)}`);
  } else if (rule.startsOn !== null) parts.push(`a partir de ${shortDate(rule.startsOn)}`);
  else if (rule.endsOn !== null) parts.push(`até ${shortDate(rule.endsOn)}`);
  if (rule.hourStart !== null && rule.hourEnd !== null) parts.push(`das ${rule.hourStart}h às ${rule.hourEnd}h`);
  return parts.length ? parts.join(" · ") : "sempre";
}
