import { describe, expect, it } from "vitest";

import {
  spDayEnd,
  spDayKey,
  spDayLabel,
  spDayStart,
  spNextDayKey,
  spPreviousDayKey,
  spWeekdayName,
  weekdayIndexSP,
} from "@/lib/sp-day";

describe("dia de São Paulo", () => {
  it("02h30 UTC ainda é o dia anterior em São Paulo", () => {
    expect(spDayKey(new Date("2026-09-10T02:30:00Z"))).toBe("2026-09-09");
    expect(spDayKey(new Date("2026-09-10T03:00:00Z"))).toBe("2026-09-10");
  });

  it("início e fim do dia são meia-noite de SP em UTC", () => {
    expect(spDayStart("2026-09-09").toISOString()).toBe("2026-09-09T03:00:00.000Z");
    expect(spDayEnd("2026-09-09").toISOString()).toBe("2026-09-10T03:00:00.000Z");
    expect(() => spDayStart("2026-9-9")).toThrow(RangeError);
  });

  it("anda um dia para frente e para trás, inclusive na virada do mês e do ano", () => {
    expect(spNextDayKey("2026-09-30")).toBe("2026-10-01");
    expect(spPreviousDayKey("2026-01-01")).toBe("2025-12-31");
    expect(spPreviousDayKey("2026-03-01")).toBe("2026-02-28");
  });

  it("dia da semana e rótulos em português", () => {
    // 9 de setembro de 2026 é uma quarta-feira.
    expect(weekdayIndexSP("2026-09-09")).toBe(3);
    expect(weekdayIndexSP("2026-09-13")).toBe(0);
    expect(spWeekdayName("2026-09-09")).toBe("quarta-feira");
    expect(spDayLabel("2026-09-09")).toBe("quarta-feira, 9 de setembro");
  });
});
