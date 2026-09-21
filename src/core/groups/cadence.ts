// Cadência do Provador: o grupo recebe no máximo N posts da marca por semana
// (padrão 3), nunca dois no mesmo dia, sempre dentro da janela de envio e
// nunca no domingo. Previsibilidade é o contrário de spam — e o teto vive
// aqui, no core, para nenhum caminho (painel, fila, script) passar por cima.
// Tudo no "dia de São Paulo". Puro.
import { spDayKey, spNextDayKey, spPreviousDayKey, weekdayIndexSP } from "@/lib/sp-day";

import { DEFAULT_SEND_WINDOW, isWithinSendWindow, type SendWindow } from "@/core/whatsapp/send-window";

export type GroupPostKind = "chegadas" | "enquete" | "quem_vestiu" | "cortina" | "livre";

export interface GroupCadencePolicy {
  /** Teto de posts da marca por semana (segunda a domingo, SP). */
  postsPerWeek: number;
  window: SendWindow;
  /** Dias da semana em silêncio (0 = domingo … 6 = sábado). */
  quietWeekdays: readonly number[];
}

export const DEFAULT_GROUP_CADENCE: GroupCadencePolicy = {
  postsPerWeek: 3,
  window: DEFAULT_SEND_WINDOW,
  quietWeekdays: [0],
};

/** Um post "agora" tolera o relógio da fila: até 2 min no passado ainda é agora. */
const NOW_TOLERANCE_MS = 2 * 60_000;

export type CadenceRefusal = "passado" | "dia_de_silencio" | "fora_da_janela" | "mesmo_dia" | "teto_semanal";

export type CadenceVerdict = { ok: true } | { ok: false; reason: CadenceRefusal };

export const CADENCE_REFUSAL_MESSAGES: Record<CadenceRefusal, string> = {
  passado: "Esse horário já passou.",
  dia_de_silencio: "O Provador fica em silêncio nesse dia.",
  fora_da_janela: "Fora da janela de envio (o horário da loja no WhatsApp).",
  mesmo_dia: "Já tem um post do Provador nesse dia — um por dia.",
  teto_semanal: "Essa semana já tem o número máximo de posts do Provador.",
};

/** Chave da semana de SP a que o instante pertence: o dia da segunda-feira ('YYYY-MM-DD'). */
export function spWeekKey(at: Date): string {
  let day = spDayKey(at);
  // weekdayIndexSP: 0 = domingo. Segunda é o dia 1; domingo fecha a semana.
  let steps = (weekdayIndexSP(day) + 6) % 7;
  while (steps > 0) {
    day = spPreviousDayKey(day);
    steps -= 1;
  }
  return day;
}

/**
 * Pode agendar um post da marca em `candidateAt`? `existing` são os instantes
 * dos outros posts da sala já agendados ou enviados (o próprio post, quando
 * é reagendamento, fica de fora). A ordem das recusas é contrato: primeiro o
 * que a dona corrige mudando a hora, depois o que só muda tirando um post.
 */
export function canSchedulePost(input: {
  candidateAt: Date;
  existing: readonly Date[];
  now: Date;
  policy?: GroupCadencePolicy;
}): CadenceVerdict {
  const policy = input.policy ?? DEFAULT_GROUP_CADENCE;
  const { candidateAt, now } = input;
  if (candidateAt.getTime() < now.getTime() - NOW_TOLERANCE_MS) return { ok: false, reason: "passado" };

  const day = spDayKey(candidateAt);
  if (policy.quietWeekdays.includes(weekdayIndexSP(day))) return { ok: false, reason: "dia_de_silencio" };
  if (!isWithinSendWindow(candidateAt, policy.window)) return { ok: false, reason: "fora_da_janela" };

  const week = spWeekKey(candidateAt);
  let sameWeek = 0;
  for (const other of input.existing) {
    if (spDayKey(other) === day) return { ok: false, reason: "mesmo_dia" };
    if (spWeekKey(other) === week) sameWeek += 1;
  }
  if (sameWeek >= Math.max(1, Math.floor(policy.postsPerWeek))) return { ok: false, reason: "teto_semanal" };

  return { ok: true };
}

/** Dia da semana de cada ritual (0 = domingo); cortina e livre não têm dia fixo. */
export function ritualWeekday(kind: GroupPostKind): number | null {
  switch (kind) {
    case "chegadas":
      return 2;
    case "enquete":
      return 4;
    case "quem_vestiu":
      return 6;
    default:
      return null;
  }
}

/** Hora sugerida de cada ritual (SP): manhã para ver antes de sair, noite para votar em casa. */
export function ritualHour(kind: GroupPostKind): number {
  return kind === "enquete" ? 19 : 10;
}

/**
 * O próximo dia ('YYYY-MM-DD', SP) em que o ritual acontece, contando de
 * `from` (o próprio dia de `from` vale se ainda não passou da hora do ritual).
 * Rituais sem dia fixo devolvem o dia seguinte útil de janela.
 */
export function nextRitualDay(kind: GroupPostKind, from: Date, policy: GroupCadencePolicy = DEFAULT_GROUP_CADENCE): string {
  const weekday = ritualWeekday(kind);
  let day = spDayKey(from);
  const startHour = ritualHour(kind);
  // Hora atual em SP: se hoje é o dia do ritual mas a hora já passou, vai para a próxima semana.
  const nowHourSP = (((from.getUTCHours() - 3) % 24) + 24) % 24;
  const todayStillOpen = nowHourSP < startHour;
  for (let step = 0; step < 14; step += 1) {
    const matchesRitual = weekday === null ? !policy.quietWeekdays.includes(weekdayIndexSP(day)) : weekdayIndexSP(day) === weekday;
    if (matchesRitual && (step > 0 || todayStillOpen)) return day;
    day = spNextDayKey(day);
  }
  return day;
}
