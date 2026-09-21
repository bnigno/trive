import { describe, expect, it } from "vitest";

import { assessLateness, lateDeliveryCouponExpiry, lateDeliveryNote, minutesLateLabel } from "@/core/delivery/lateness";

// Janela de sábado 19/09/2026, 19h–21h em São Paulo (fim = 00:00Z de 20/09).
const WINDOW = { dayKey: "2026-09-19", start: "19:00", end: "21:00" };
const sp = (iso: string) => new Date(`${iso}-03:00`);

describe("assessLateness", () => {
  it("dentro da janela ou antes: não atrasou, 0 min", () => {
    expect(assessLateness({ window: WINDOW, deliveredAt: sp("2026-09-19T20:30:00"), graceMinutes: 30 })).toEqual({ late: false, minutesLate: 0, promisedEndAt: sp("2026-09-19T21:00:00") });
    expect(assessLateness({ window: WINDOW, deliveredAt: sp("2026-09-19T18:00:00"), graceMinutes: 30 }).minutesLate).toBe(0);
  });

  it("carência: 29 min depois não é atraso, 31 min é", () => {
    expect(assessLateness({ window: WINDOW, deliveredAt: sp("2026-09-19T21:29:00"), graceMinutes: 30 })).toMatchObject({ late: false, minutesLate: 29 });
    expect(assessLateness({ window: WINDOW, deliveredAt: sp("2026-09-19T21:30:59"), graceMinutes: 30 })).toMatchObject({ late: false, minutesLate: 30 });
    expect(assessLateness({ window: WINDOW, deliveredAt: sp("2026-09-19T21:31:00"), graceMinutes: 30 })).toMatchObject({ late: true, minutesLate: 31 });
    expect(assessLateness({ window: WINDOW, deliveredAt: sp("2026-09-19T21:01:00"), graceMinutes: 0 })).toMatchObject({ late: true, minutesLate: 1 });
  });

  it("virada de dia: entregue 00h10 do dia seguinte = 190 min depois de 21h", () => {
    expect(assessLateness({ window: WINDOW, deliveredAt: sp("2026-09-20T00:10:00"), graceMinutes: 30 })).toMatchObject({ late: true, minutesLate: 190 });
  });

  it("sem janela (Correios) ou janela inválida: nunca atrasa", () => {
    expect(assessLateness({ window: null, deliveredAt: sp("2026-09-20T00:10:00"), graceMinutes: 30 })).toEqual({ late: false, minutesLate: 0, promisedEndAt: null });
    expect(assessLateness({ window: { dayKey: "hoje", start: "19:00", end: "21:00" }, deliveredAt: sp("2026-09-20T00:10:00"), graceMinutes: 30 }).late).toBe(false);
  });
});

describe("rótulos e validade", () => {
  it("minutos → texto", () => {
    expect(minutesLateLabel(42)).toBe("42 min");
    expect(minutesLateLabel(60)).toBe("1 h");
    expect(minutesLateLabel(130)).toBe("2 h 10 min");
  });

  it("nota interna com o dia e a janela", () => {
    expect(lateDeliveryNote({ minutesLate: 42, window: WINDOW })).toBe("Entrega 42 min depois da janela (sábado, 19 de setembro, 19h–21h)");
  });

  it("cupom vale N dias a partir da entrega", () => {
    expect(lateDeliveryCouponExpiry(sp("2026-09-19T21:42:00"), 30)).toEqual(sp("2026-10-19T21:42:00"));
  });
});
