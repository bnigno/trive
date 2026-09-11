import { describe, expect, it } from "vitest";

import { expectedSettlementDayKey, groupSettlementForecast } from "@/core/financial/settlement";

describe("expectedSettlementDayKey", () => {
  it("conta o dia de São Paulo, não o UTC: 23h30 de SP ainda é o mesmo dia", () => {
    // 2026-09-11T02:30Z = 2026-09-10 23:30 em São Paulo.
    const paidAt = new Date("2026-09-11T02:30:00Z");
    expect(expectedSettlementDayKey(paidAt, 0)).toBe("2026-09-10");
    expect(expectedSettlementDayKey(paidAt, 30)).toBe("2026-10-10");
    expect(expectedSettlementDayKey(paidAt, 1)).toBe("2026-09-11");
  });

  it("dias negativos ou quebrados viram zero/inteiro", () => {
    const paidAt = new Date("2026-09-11T15:00:00Z");
    expect(expectedSettlementDayKey(paidAt, -5)).toBe("2026-09-11");
    expect(expectedSettlementDayKey(paidAt, 2.9)).toBe("2026-09-13");
  });
});

describe("groupSettlementForecast", () => {
  const row = (over: Partial<Parameters<typeof groupSettlementForecast>[0][number]>) => ({
    entryId: "e",
    dueDate: "2026-10-10",
    orderId: "o",
    orderNumber: 1,
    grossCents: 10000,
    feeCents: 500,
    paymentMethod: "pix",
    installments: 1,
    ...over,
  });

  it("agrupa por dia em ordem crescente, soma bruto/taxa e calcula o líquido", () => {
    const forecast = groupSettlementForecast([
      row({ dueDate: "2026-10-12", orderNumber: 1003, grossCents: 20000, feeCents: 1000 }),
      row({ dueDate: "2026-10-10", orderNumber: 1002 }),
      row({ dueDate: "2026-10-10", orderNumber: 1001, grossCents: 5000, feeCents: 250 }),
    ]);
    expect(forecast.days.map((day) => day.dayKey)).toEqual(["2026-10-10", "2026-10-12"]);
    expect(forecast.days[0]).toMatchObject({ grossCents: 15000, feeCents: 750, netCents: 14250 });
    expect(forecast.days[0].orders.map((o) => o.orderNumber)).toEqual([1001, 1002]);
    expect(forecast.days[0].label).toContain("de outubro");
    expect(forecast).toMatchObject({ totalGrossCents: 35000, totalFeeCents: 1750, totalNetCents: 33250 });
  });

  it("lista vazia dá previsão vazia", () => {
    expect(groupSettlementForecast([])).toEqual({ days: [], totalGrossCents: 0, totalFeeCents: 0, totalNetCents: 0 });
  });
});
