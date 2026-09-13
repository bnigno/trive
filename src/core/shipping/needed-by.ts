// Data marcada (PURO): a cliente diz "preciso até o dia 16" e a maison
// responde por opção de entrega se chega a tempo, guarda até quando a peça
// precisa SAIR (ship_by) e a dona vê um semáforo. Tudo em dias do
// calendário de São Paulo; prazo dos Correios em dias úteis (feriados
// nacionais fixos); motoboy chega no dia da janela.
import { z } from "zod";

import { isNationalHoliday } from "@/core/shipping/holidays";
import { addBusinessDaysSP, isSpDayKey, isWeekendSP, spDayKey, subtractBusinessDaysSP } from "@/lib/sp-day";

export const OCCASION_MAX = 60;

/** O que o checkout manda: dia (hoje ou depois) e, se quiser, a ocasião. */
export const neededBySchema = z.object({
  neededBy: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data inválida."),
  occasion: z.string().trim().max(OCCASION_MAX, `A ocasião cabe em ${OCCASION_MAX} caracteres.`).optional(),
});
export type NeededByInput = z.infer<typeof neededBySchema>;

/** 'YYYY-MM-DD' que existe (31/02 não) e não está no passado. */
export function isValidNeededBy(neededBy: string, todayKey: string): boolean {
  if (!isSpDayKey(neededBy)) return false;
  const [y, m, d] = neededBy.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return false;
  return neededBy >= todayKey;
}

/** A opção de entrega, como a vitrine e a Lia a conhecem. */
export type DeliveryOptionForNeededBy =
  | { kind: "correios"; deliveryDaysMax: number }
  | { kind: "motoboy"; dayKey: string };

export type NeededByVerdict =
  | { fits: true; arrivesBy: string; daysToSpare: number; label: string }
  | { fits: false; arrivesBy: string; daysLate: number; label: string };

const WEEKDAYS_PT = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"] as const;

function dayLabel(dayKey: string): string {
  const [y, m, d] = dayKey.split("-").map(Number);
  return `${WEEKDAYS_PT[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")}`;
}

function calendarDaysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);
}

/** Os Correios não postam sábado, domingo nem feriado: o dia de postagem é o próximo dia útil (hoje, se útil). */
export function postingDayFor(todayKey: string): string {
  return isWeekendSP(todayKey) || isNationalHoliday(todayKey) ? addBusinessDaysSP(todayKey, 1, isNationalHoliday) : todayKey;
}

/** Dia em que a opção chega, no pior caso, postando no primeiro dia útil a partir de `todayKey`. */
export function arrivalDayFor(option: DeliveryOptionForNeededBy, todayKey: string): string {
  if (option.kind === "motoboy") return option.dayKey;
  return addBusinessDaysSP(postingDayFor(todayKey), option.deliveryDaysMax, isNationalHoliday);
}

/**
 * Chega a tempo? Correios: posta no próximo dia útil (hoje, se for útil) e
 * leva o prazo máximo em dias úteis — a mesma régua do ship_by, para o
 * checkout e o painel nunca discordarem. Motoboy: chega no dia da janela.
 * O texto já vem pronto para a opção ("Chega até sexta 16/10, 4 dias antes").
 */
export function assessNeededBy(option: DeliveryOptionForNeededBy, neededBy: string, now: Date): NeededByVerdict {
  const today = spDayKey(now);
  const arrivesBy = arrivalDayFor(option, today);
  const spare = calendarDaysBetween(arrivesBy, neededBy);
  if (spare >= 0) {
    const label =
      spare === 0
        ? `Chega até ${dayLabel(arrivesBy)}, no dia`
        : `Chega até ${dayLabel(arrivesBy)}, ${spare === 1 ? "1 dia antes" : `${spare} dias antes`}`;
    return { fits: true, arrivesBy, daysToSpare: spare, label };
  }
  const late = -spare;
  return { fits: false, arrivesBy, daysLate: late, label: `Pode chegar só ${dayLabel(arrivesBy)} — ${late === 1 ? "1 dia" : `${late} dias`} depois` };
}

/**
 * Até que dia a peça precisa sair para chegar em `neededBy`: motoboy é o
 * dia da janela; Correios é `neededBy` menos o prazo máximo em dias úteis.
 */
export function shipByFor(option: DeliveryOptionForNeededBy, neededBy: string): string {
  if (option.kind === "motoboy") return option.dayKey;
  return subtractBusinessDaysSP(neededBy, option.deliveryDaysMax, isNationalHoliday);
}

/** "Para o dia 16/10 — aniversário da mãe" (pedido, painel, WhatsApp). */
export function neededByLabel(neededBy: string, occasion: string | null | undefined): string {
  const [, m, d] = neededBy.split("-").map(Number);
  const day = `Para o dia ${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")}`;
  return occasion?.trim() ? `${day} — ${occasion.trim()}` : day;
}

export type TrafficLight = "red" | "amber" | "green";

/** Vermelho: precisa sair hoje ou já passou. Âmbar: amanhã. Verde: depois. */
export function trafficLight(shipBy: string, todayKey: string): TrafficLight {
  const days = calendarDaysBetween(todayKey, shipBy);
  if (days <= 0) return "red";
  if (days === 1) return "amber";
  return "green";
}

export const TRAFFIC_LIGHT_LABELS: Record<TrafficLight, string> = {
  red: "Sai hoje",
  amber: "Sai amanhã",
  green: "No prazo",
};

/** "Sai hoje" / "Sai amanhã" / "Sai até sexta 16/10" / "Atrasou 2 dias". */
export function shipByLabel(shipBy: string, todayKey: string): string {
  const days = calendarDaysBetween(todayKey, shipBy);
  if (days < 0) return `Atrasou ${-days === 1 ? "1 dia" : `${-days} dias`}`;
  if (days === 0) return "Sai hoje";
  if (days === 1) return "Sai amanhã";
  return `Sai até ${dayLabel(shipBy)}`;
}

// ---------------------------------------------------------------------------
// Datas da cidade (Círio, Natal…): o selo da vitrine
// ---------------------------------------------------------------------------

export const cityDateSchema = z.object({
  name: z.string().trim().min(1, "Dê um nome à data.").max(40, "O nome cabe em 40 caracteres."),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data no formato AAAA-MM-DD."),
});
export const cityDatesSchema = z.array(cityDateSchema).max(12, "No máximo 12 datas.");
export type CityDate = z.infer<typeof cityDateSchema>;

export interface CitySeal {
  name: string;
  date: string;
  daysUntil: number;
  /** Último dia para a peça sair pelos Correios e chegar antes. */
  orderBy: string;
  /** "Círio em 28 dias · peça até 3/10 para chegar pelos Correios". */
  text: string;
}

/**
 * A próxima data da cidade que ainda dá tempo (hoje conta), com o dia-limite
 * para pedir pelos Correios (`horizonDays` = maior prazo em dias úteis das
 * faixas ativas). null = nenhuma data à frente.
 */
export function citySealFor(dates: readonly CityDate[], now: Date, horizonDays: number | null): CitySeal | null {
  const today = spDayKey(now);
  const next = [...dates].filter((d) => isSpDayKey(d.date) && d.date >= today).sort((a, b) => a.date.localeCompare(b.date))[0];
  if (!next) return null;
  const daysUntil = calendarDaysBetween(today, next.date);
  const when = daysUntil === 0 ? "é hoje" : daysUntil === 1 ? "é amanhã" : `em ${daysUntil} dias`;
  // Sem faixa de Correios ativa não há prazo para prometer: só a contagem.
  if (horizonDays === null || horizonDays <= 0) {
    return { name: next.name, date: next.date, daysUntil, orderBy: next.date, text: `${next.name} ${when}` };
  }
  const orderBy = subtractBusinessDaysSP(next.date, horizonDays, isNationalHoliday);
  const [, m, d] = orderBy.split("-").map(Number);
  const text =
    orderBy >= today
      ? `${next.name} ${when} · peça até ${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")} para chegar pelos Correios`
      : `${next.name} ${when} · pelos Correios não chega mais; motoboy em Belém`;
  return { name: next.name, date: next.date, daysUntil, orderBy, text };
}
