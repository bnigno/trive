// Cupom que muda com o tempo — PURO. O valor da coluna é o do dia 0; os
// degraus dizem o que ele passa a valer "a partir do dia N" (contado em dias
// de calendário de São Paulo desde o início da vigência, ou desde a criação).
// Subindo, é o cupom que AMADURECE ("espero o desconto subir ou a peça acaba?");
// descendo, é o que DERRETE. A mesma estrutura serve às duas.
import { z } from "zod";

import { formatCentsBRL } from "@/lib/money";
import { spDayKey, spDayStart } from "@/lib/sp-day";

export const VALUE_SCHEDULE_MAX_STEPS = 3;

export const valueStepSchema = z.object({
  /** A partir deste dia (1 = amanhã em relação ao início). */
  afterDays: z.number().int().min(1).max(365),
  /** O valor a partir dali: pontos percentuais (percent) ou centavos (fixed). */
  value: z.number().int().min(1),
});
export type ValueStep = z.infer<typeof valueStepSchema>;

export const valueScheduleSchema = z
  .array(valueStepSchema)
  .min(1)
  .max(VALUE_SCHEDULE_MAX_STEPS, `No máximo ${VALUE_SCHEDULE_MAX_STEPS} degraus.`)
  .superRefine((steps, ctx) => {
    for (let i = 1; i < steps.length; i++) {
      if (steps[i].afterDays <= steps[i - 1].afterDays) {
        ctx.addIssue({ code: "custom", path: [i, "afterDays"], message: "Os dias dos degraus precisam crescer." });
        return;
      }
    }
  });

export interface ScheduledCoupon {
  type: "percent" | "fixed" | "free_shipping";
  value: number;
  valueSchedule: ValueStep[] | null;
  startsAt: Date | null;
  createdAt: Date;
}

/** Os degraus começam a contar da vigência quando há uma; senão, da criação. */
export function scheduleAnchor(coupon: Pick<ScheduledCoupon, "startsAt" | "createdAt">): Date {
  return coupon.startsAt ?? coupon.createdAt;
}

/** Dias de calendário de São Paulo entre a âncora e agora (nunca negativo). */
export function scheduleDayIndex(anchor: Date, now: Date): number {
  const start = spDayStart(spDayKey(anchor)).getTime();
  const today = spDayStart(spDayKey(now)).getTime();
  return Math.max(0, Math.round((today - start) / 86_400_000));
}

export function hasValueSchedule(coupon: Pick<ScheduledCoupon, "valueSchedule">): boolean {
  return coupon.valueSchedule !== null && coupon.valueSchedule.length > 0;
}

/** O que o cupom vale hoje: o último degrau já alcançado; sem degraus, o valor inicial. */
export function effectiveValue(coupon: ScheduledCoupon, now: Date): number {
  if (!hasValueSchedule(coupon)) return coupon.value;
  const day = scheduleDayIndex(scheduleAnchor(coupon), now);
  let value = coupon.value;
  for (const step of coupon.valueSchedule ?? []) {
    if (step.afterDays <= day) value = step.value;
  }
  return value;
}

export interface NextValueStep {
  value: number;
  /** Daqui a quantos dias (>= 1). */
  inDays: number;
  /** O dia em que passa a valer ('AAAA-MM-DD', SP). */
  dayKey: string;
  direction: "up" | "down";
}

/** O próximo degrau; null quando já está no último (ou sem degraus). */
export function nextValueStep(coupon: ScheduledCoupon, now: Date): NextValueStep | null {
  if (!hasValueSchedule(coupon)) return null;
  const anchor = scheduleAnchor(coupon);
  const day = scheduleDayIndex(anchor, now);
  const current = effectiveValue(coupon, now);
  const next = (coupon.valueSchedule ?? []).find((step) => step.afterDays > day);
  if (!next) return null;
  const dayKey = spDayKey(new Date(spDayStart(spDayKey(anchor)).getTime() + next.afterDays * 86_400_000 + 12 * 3_600_000));
  return { value: next.value, inDays: next.afterDays - day, dayKey, direction: next.value >= current ? "up" : "down" };
}

/** "10%" ou "R$ 20,00". */
export function couponValueLabel(type: ScheduledCoupon["type"], value: number): string {
  return type === "percent" ? `${value}%` : formatCentsBRL(value);
}

function shortDate(dayKey: string): string {
  const [, month, day] = dayKey.split("-");
  return `${day}/${month}`;
}

/** Painel: "hoje vale 10% · sobe para 15% em 20/10" / "hoje vale 15% (último degrau)"; null sem degraus. */
export function scheduleAdminLabel(coupon: ScheduledCoupon, now: Date): string | null {
  if (!hasValueSchedule(coupon)) return null;
  const today = couponValueLabel(coupon.type, effectiveValue(coupon, now));
  const next = nextValueStep(coupon, now);
  if (!next) return `hoje vale ${today} (último degrau)`;
  const verb = next.direction === "up" ? "sobe" : "cai";
  return `hoje vale ${today} · ${verb} para ${couponValueLabel(coupon.type, next.value)} em ${shortDate(next.dayKey)}`;
}

/**
 * Loja e Lia: "Hoje vale 10%. Em 9 dias (20/10) passa a 15%, se a peça ainda
 * estiver aqui." / "Hoje vale 20%. Em 3 dias (23/09) cai para 15%." /
 * "Hoje vale 15% — o valor final deste cupom." Null sem degraus.
 */
export function scheduleCustomerHint(coupon: ScheduledCoupon, now: Date): string | null {
  if (!hasValueSchedule(coupon)) return null;
  const today = couponValueLabel(coupon.type, effectiveValue(coupon, now));
  const next = nextValueStep(coupon, now);
  if (!next) return `Hoje vale ${today} — o valor final deste cupom.`;
  const when = next.inDays === 1 ? `Amanhã (${shortDate(next.dayKey)})` : `Em ${next.inDays} dias (${shortDate(next.dayKey)})`;
  const nextLabel = couponValueLabel(coupon.type, next.value);
  return next.direction === "up"
    ? `Hoje vale ${today}. ${when} passa a ${nextLabel}, se a peça ainda estiver aqui.`
    : `Hoje vale ${today}. ${when} cai para ${nextLabel}.`;
}
