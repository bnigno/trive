import { describe, expect, it } from "vitest";

import {
  effectiveValue,
  nextValueStep,
  scheduleAdminLabel,
  scheduleAnchor,
  scheduleCustomerHint,
  scheduleDayIndex,
  valueScheduleSchema,
  type ScheduledCoupon,
} from "@/core/coupons/schedule";
import { formatCentsBRL } from "@/lib/money";

const sp = (iso: string) => new Date(`${iso}-03:00`);
// Criado em 11/09/2026 às 10h (SP).
const CREATED = sp("2026-09-11T10:00:00");

function coupon(over: Partial<ScheduledCoupon> = {}): ScheduledCoupon {
  return {
    type: "percent",
    value: 5,
    valueSchedule: [
      { afterDays: 7, value: 10 },
      { afterDays: 30, value: 15 },
    ],
    startsAt: null,
    createdAt: CREATED,
    ...over,
  };
}

describe("effectiveValue — amadurece", () => {
  it("dia 0..6 = 5%, 7..29 = 10%, 30+ = 15%", () => {
    expect(effectiveValue(coupon(), sp("2026-09-11T23:00:00"))).toBe(5);
    expect(effectiveValue(coupon(), sp("2026-09-17T23:59:00"))).toBe(5);
    expect(effectiveValue(coupon(), sp("2026-09-18T00:00:00"))).toBe(10);
    expect(effectiveValue(coupon(), sp("2026-10-10T12:00:00"))).toBe(10);
    expect(effectiveValue(coupon(), sp("2026-10-11T00:00:00"))).toBe(15);
    expect(effectiveValue(coupon(), sp("2027-10-11T00:00:00"))).toBe(15);
  });

  it("sem degraus: o valor inicial; antes da âncora: dia 0", () => {
    expect(effectiveValue(coupon({ valueSchedule: null }), sp("2027-01-01T00:00:00"))).toBe(5);
    expect(effectiveValue(coupon(), sp("2026-09-01T00:00:00"))).toBe(5);
  });

  it("derrete: degraus decrescentes", () => {
    const melting = coupon({ value: 20, valueSchedule: [{ afterDays: 3, value: 15 }, { afterDays: 7, value: 10 }] });
    expect(effectiveValue(melting, sp("2026-09-13T12:00:00"))).toBe(20);
    expect(effectiveValue(melting, sp("2026-09-14T12:00:00"))).toBe(15);
    expect(effectiveValue(melting, sp("2026-09-18T12:00:00"))).toBe(10);
    expect(nextValueStep(melting, sp("2026-09-12T12:00:00"))).toEqual({ value: 15, inDays: 2, dayKey: "2026-09-14", direction: "down" });
  });
});

describe("âncora e dia", () => {
  it("com vigência conta da vigência; sem, da criação", () => {
    expect(scheduleAnchor(coupon({ startsAt: sp("2026-10-01T00:00:00") }))).toEqual(sp("2026-10-01T00:00:00"));
    expect(scheduleAnchor(coupon())).toEqual(CREATED);
    expect(effectiveValue(coupon({ startsAt: sp("2026-10-01T00:00:00") }), sp("2026-10-08T00:00:00"))).toBe(10);
  });

  it("fronteira do dia de SP: 23h30 de SP → 00h30 do dia seguinte = 1 dia", () => {
    expect(scheduleDayIndex(sp("2026-09-11T23:30:00"), sp("2026-09-12T00:30:00"))).toBe(1);
    expect(scheduleDayIndex(sp("2026-09-11T23:30:00"), sp("2026-09-11T23:59:00"))).toBe(0);
  });
});

describe("nextValueStep e textos", () => {
  it("próximo degrau com dias e data; null no último", () => {
    expect(nextValueStep(coupon(), sp("2026-09-11T12:00:00"))).toEqual({ value: 10, inDays: 7, dayKey: "2026-09-18", direction: "up" });
    expect(nextValueStep(coupon(), sp("2026-09-17T12:00:00"))).toEqual({ value: 10, inDays: 1, dayKey: "2026-09-18", direction: "up" });
    expect(nextValueStep(coupon(), sp("2026-10-11T12:00:00"))).toBeNull();
    expect(nextValueStep(coupon({ valueSchedule: null }), sp("2026-09-11T12:00:00"))).toBeNull();
  });

  it("painel", () => {
    expect(scheduleAdminLabel(coupon(), sp("2026-09-11T12:00:00"))).toBe("hoje vale 5% · sobe para 10% em 18/09");
    expect(scheduleAdminLabel(coupon(), sp("2026-10-11T12:00:00"))).toBe("hoje vale 15% (último degrau)");
    expect(scheduleAdminLabel(coupon({ valueSchedule: null }), sp("2026-09-11T12:00:00"))).toBeNull();
    const melting = coupon({ value: 20, valueSchedule: [{ afterDays: 3, value: 15 }] });
    expect(scheduleAdminLabel(melting, sp("2026-09-12T12:00:00"))).toBe("hoje vale 20% · cai para 15% em 14/09");
  });

  it("cliente: subindo, amanhã, descendo, final, em reais", () => {
    expect(scheduleCustomerHint(coupon(), sp("2026-09-11T12:00:00"))).toBe("Hoje vale 5%. Em 7 dias (18/09) passa a 10%, se a peça ainda estiver aqui.");
    expect(scheduleCustomerHint(coupon(), sp("2026-09-17T12:00:00"))).toBe("Hoje vale 5%. Amanhã (18/09) passa a 10%, se a peça ainda estiver aqui.");
    expect(scheduleCustomerHint(coupon({ value: 20, valueSchedule: [{ afterDays: 3, value: 15 }] }), sp("2026-09-11T12:00:00"))).toBe("Hoje vale 20%. Em 3 dias (14/09) cai para 15%.");
    expect(scheduleCustomerHint(coupon(), sp("2026-10-11T12:00:00"))).toBe("Hoje vale 15% — o valor final deste cupom.");
    expect(scheduleCustomerHint(coupon({ type: "fixed", value: 1000, valueSchedule: [{ afterDays: 7, value: 2000 }] }), sp("2026-09-11T12:00:00"))).toBe(
      `Hoje vale ${formatCentsBRL(1000)}. Em 7 dias (18/09) passa a ${formatCentsBRL(2000)}, se a peça ainda estiver aqui.`,
    );
    expect(scheduleCustomerHint(coupon({ valueSchedule: null }), sp("2026-09-11T12:00:00"))).toBeNull();
  });
});

describe("valueScheduleSchema", () => {
  it("aceita 1–3 degraus crescentes; recusa o resto", () => {
    expect(valueScheduleSchema.safeParse([{ afterDays: 7, value: 10 }]).success).toBe(true);
    expect(valueScheduleSchema.safeParse([{ afterDays: 7, value: 10 }, { afterDays: 7, value: 12 }]).success).toBe(false);
    expect(valueScheduleSchema.safeParse([{ afterDays: 9, value: 10 }, { afterDays: 7, value: 12 }]).success).toBe(false);
    expect(valueScheduleSchema.safeParse([]).success).toBe(false);
    expect(valueScheduleSchema.safeParse([{ afterDays: 0, value: 10 }]).success).toBe(false);
    expect(valueScheduleSchema.safeParse([1, 2, 3, 4].map((i) => ({ afterDays: i, value: i }))).success).toBe(false);
  });
});
