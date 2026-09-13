// Rota do dia (PURO): atrasados / hoje por janela / próximos, ordem de
// horário, rótulos dos dias e "pagou depois da hora-limite" no relógio de SP.
import { describe, expect, it } from "vitest";

import { groupRouteOrders, isPaidAfterCutoff, routeDayLabel } from "@/core/shipping/route";
import { spWeekdayName } from "@/lib/sp-day";

const W1 = { start: "09:00", end: "12:00", cutoff: "08:00" };
const W2 = { start: "16:00", end: "19:00", cutoff: "13:00" };
const W3 = { start: "19:00", end: "21:00", cutoff: "17:00" };
const TODAY = "2026-09-18"; // sexta

function order(id: string, dayKey: string, w: { start: string; end: string; cutoff: string }) {
  return { id, window: { dayKey, ...w } };
}

describe("groupRouteOrders", () => {
  it("separa atrasados (dias antes de hoje), hoje por janela em ordem de horário e os próximos por dia", () => {
    const route = groupRouteOrders(
      [
        order("late-2", "2026-09-17", W3),
        order("t-19", TODAY, W3),
        order("t-16a", TODAY, W2),
        order("late-1", "2026-09-16", W1),
        order("t-16b", TODAY, W2),
        order("tomorrow", "2026-09-19", W1),
        order("sunday", "2026-09-20", W2),
      ],
      TODAY,
    );
    expect(route.late.map((o) => o.id)).toEqual(["late-1", "late-2"]);
    expect(route.today.map((g) => `${g.label}: ${g.orders.map((o) => o.id).join(",")}`)).toEqual([
      "16h–19h: t-16a,t-16b",
      "19h–21h: t-19",
    ]);
    expect(route.todayCount).toBe(3);
    expect(route.upcoming.map((d) => `${d.dayKey} ${d.windows.map((g) => g.label).join("/")}`)).toEqual([
      "2026-09-19 9h–12h",
      "2026-09-20 16h–19h",
    ]);
  });

  it("lista vazia → tudo vazio", () => {
    expect(groupRouteOrders([], TODAY)).toEqual({ late: [], today: [], upcoming: [], todayCount: 0 });
  });
});

describe("routeDayLabel", () => {
  it("hoje / amanhã / dia da semana com data", () => {
    expect(routeDayLabel(TODAY, TODAY, spWeekdayName)).toBe("hoje");
    expect(routeDayLabel("2026-09-19", TODAY, spWeekdayName)).toBe("amanhã");
    expect(routeDayLabel("2026-09-20", TODAY, spWeekdayName)).toBe("domingo 20/09");
  });
});

describe("isPaidAfterCutoff", () => {
  const window = { dayKey: TODAY, ...W2 }; // limite 13h
  it("pago antes do limite (no dia) não; no limite em ponto ou depois sim; dia seguinte sim; véspera não; sem pagamento não", () => {
    expect(isPaidAfterCutoff(new Date("2026-09-18T15:59:00Z"), window)).toBe(false); // 12:59 SP
    expect(isPaidAfterCutoff(new Date("2026-09-18T16:00:00Z"), window)).toBe(true); // 13:00 SP
    expect(isPaidAfterCutoff(new Date("2026-09-19T01:00:00Z"), window)).toBe(true); // 22:00 SP do mesmo dia
    expect(isPaidAfterCutoff(new Date("2026-09-19T12:00:00Z"), window)).toBe(true); // dia seguinte
    expect(isPaidAfterCutoff(new Date("2026-09-17T23:00:00Z"), window)).toBe(false); // véspera
    expect(isPaidAfterCutoff(null, window)).toBe(false);
  });
});
