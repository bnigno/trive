import { describe, expect, it } from "vitest";

import {
  isWithinSendWindow,
  nextSendWindowStart,
  spHour,
  staggerSchedule,
  staggerWithinWindow,
} from "@/core/whatsapp/send-window";

describe("janela de envio (São Paulo, UTC-3)", () => {
  it("converte a hora para São Paulo e decide se está na janela 9–21", () => {
    expect(spHour(new Date("2026-09-10T12:00:00Z"))).toBe(9);
    expect(spHour(new Date("2026-09-10T01:30:00Z"))).toBe(22);
    expect(isWithinSendWindow(new Date("2026-09-10T12:00:00Z"))).toBe(true); // 09:00 SP
    expect(isWithinSendWindow(new Date("2026-09-10T11:59:00Z"))).toBe(false); // 08:59 SP
    expect(isWithinSendWindow(new Date("2026-09-10T23:59:00Z"))).toBe(true); // 20:59 SP
    expect(isWithinSendWindow(new Date("2026-09-11T00:00:00Z"))).toBe(false); // 21:00 SP
    expect(isWithinSendWindow(new Date("2026-09-11T00:00:00Z"), { startHour: 8, endHour: 22 })).toBe(true);
  });

  it("próxima abertura: hoje às 9h se ainda não passou, senão amanhã; dentro da janela é agora", () => {
    const early = new Date("2026-09-10T09:30:00Z"); // 06:30 SP
    expect(nextSendWindowStart(early).toISOString()).toBe("2026-09-10T12:00:00.000Z");
    const late = new Date("2026-09-11T00:30:00Z"); // 21:30 SP de 10/09
    expect(nextSendWindowStart(late).toISOString()).toBe("2026-09-11T12:00:00.000Z");
    const inside = new Date("2026-09-10T15:00:00Z"); // 12:00 SP
    expect(nextSendWindowStart(inside)).toBe(inside);
    const custom = new Date("2026-09-10T02:00:00Z"); // 23:00 SP de 09/09
    expect(nextSendWindowStart(custom, { startHour: 10, endHour: 18 }).toISOString()).toBe("2026-09-10T13:00:00.000Z");
  });

  it("escalona N instantes a partir de um ponto, um a cada intervalo", () => {
    const from = new Date("2026-09-10T12:00:00Z");
    const times = staggerSchedule(3, { from, intervalSeconds: 20 });
    expect(times.map((t) => t.toISOString())).toEqual([
      "2026-09-10T12:00:00.000Z",
      "2026-09-10T12:00:20.000Z",
      "2026-09-10T12:00:40.000Z",
    ]);
    expect(staggerSchedule(0, { from, intervalSeconds: 20 })).toEqual([]);
    expect(staggerSchedule(2, { from, intervalSeconds: 0.2 })[1].getTime() - from.getTime()).toBe(1000);
  });
});

describe("staggerWithinWindow", () => {
  it("a fila não atravessa o fim da janela: o que não cabe hoje continua amanhã às 9h no mesmo passo", () => {
    // 20:59:30 SP = 23:59:30Z; 5 envios a cada 20 s: 2 cabem hoje, 3 vão para amanhã às 9h (12:00Z).
    const from = new Date("2026-09-19T23:59:30Z");
    const slots = staggerWithinWindow(5, { from, intervalSeconds: 20 }).map((d) => d.toISOString());
    expect(slots).toEqual([
      "2026-09-19T23:59:30.000Z",
      "2026-09-19T23:59:50.000Z",
      "2026-09-20T12:00:00.000Z",
      "2026-09-20T12:00:20.000Z",
      "2026-09-20T12:00:40.000Z",
    ]);
  });

  it("começando fora da janela, tudo parte da próxima abertura; dentro, é igual ao escalonamento simples", () => {
    const night = new Date("2026-09-20T02:00:00Z");
    expect(staggerWithinWindow(2, { from: night, intervalSeconds: 30 }).map((d) => d.toISOString())).toEqual([
      "2026-09-20T12:00:00.000Z",
      "2026-09-20T12:00:30.000Z",
    ]);
    const noon = new Date("2026-09-20T15:00:00Z");
    expect(staggerWithinWindow(3, { from: noon, intervalSeconds: 20 })).toEqual(staggerSchedule(3, { from: noon, intervalSeconds: 20 }));
    expect(staggerWithinWindow(0, { from: noon, intervalSeconds: 20 })).toEqual([]);
  });
});

