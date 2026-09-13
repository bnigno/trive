// Janelas do motoboy (PURO): validação, expansão em opções "hoje/amanhã"
// pelo relógio de São Paulo (inclusive na virada do dia UTC), chave da
// opção, validade da janela na hora de fechar e o texto para a cliente.
import { describe, expect, it } from "vitest";

import {
  deliveryWindowSchema,
  deliveryWindowsSchema,
  describeWindow,
  expandDeliveryOptions,
  formatWindowLabel,
  isWindowBookable,
  optionKeyFor,
  windowBelongsToRate,
  windowDateLabel,
  type RateForOptions,
} from "@/core/shipping/delivery-windows";
import { spMinutesOfDay } from "@/lib/sp-day";

const WINDOWS = [
  { start: "09:00", end: "12:00", cutoff: "08:00" },
  { start: "16:00", end: "19:00", cutoff: "13:00" },
  { start: "19:00", end: "21:00", cutoff: "13:00" },
];
const MOTOBOY: RateForOptions = { rateId: "m1", name: "Motoboy", priceCents: 1500, deliveryDaysMin: 0, deliveryDaysMax: 0, kind: "motoboy", deliveryWindows: WINDOWS };
const PAC: RateForOptions = { rateId: "p1", name: "PAC", priceCents: 1990, deliveryDaysMin: 3, deliveryDaysMax: 5, kind: "correios", deliveryWindows: [] };

describe("deliveryWindowSchema", () => {
  it("HH:MM, fim depois do início, limite antes do início; no máximo 4 janelas", () => {
    expect(deliveryWindowSchema.safeParse({ start: "19:00", end: "21:00", cutoff: "13:00" }).success).toBe(true);
    expect(deliveryWindowSchema.safeParse({ start: "21:00", end: "19:00", cutoff: "13:00" }).success).toBe(false);
    expect(deliveryWindowSchema.safeParse({ start: "19:00", end: "21:00", cutoff: "19:30" }).success).toBe(false);
    expect(deliveryWindowSchema.safeParse({ start: "7:00", end: "21:00", cutoff: "13:00" }).success).toBe(false);
    expect(deliveryWindowsSchema.safeParse(Array.from({ length: 5 }, () => WINDOWS[0])).success).toBe(false);
  });
});

describe("spMinutesOfDay", () => {
  it("minutos de parede em São Paulo, inclusive de madrugada UTC", () => {
    expect(spMinutesOfDay(new Date("2026-09-20T15:30:00Z"))).toBe(12 * 60 + 30);
    expect(spMinutesOfDay(new Date("2026-09-20T02:15:00Z"))).toBe(23 * 60 + 15);
    expect(spMinutesOfDay(new Date("2026-09-20T03:00:00Z"))).toBe(0);
  });
});

describe("expandDeliveryOptions", () => {
  it("antes do limite: janelas de hoje (motoboy primeiro); depois: amanhã; Correios é uma opção só", () => {
    const morning = new Date("2026-09-20T13:30:00Z"); // 10:30 SP (domingo 20/09)
    const options = expandDeliveryOptions([PAC, MOTOBOY], morning);
    expect(options.map((o) => o.kind === "motoboy" ? `${o.window.dayKey} ${o.label}` : `${o.kind} ${o.deliveryDaysMin}-${o.deliveryDaysMax}`)).toEqual([
      "2026-09-20 hoje, 16h–19h · pague até 13h",
      "2026-09-20 hoje, 19h–21h · pague até 13h",
      "2026-09-21 amanhã, 9h–12h",
      "correios 3-5",
    ]);
    expect(options[0].optionKey).toBe("m1:2026-09-20:16:00");
    expect(options[3].optionKey).toBe("p1");

    const afternoon = new Date("2026-09-20T16:00:00Z"); // 13:00 SP — o limite das 13h já passou
    expect(expandDeliveryOptions([MOTOBOY], afternoon).map((o) => (o.kind === "motoboy" ? o.label : ""))).toEqual([
      "amanhã, 9h–12h",
      "amanhã, 16h–19h",
      "amanhã, 19h–21h",
    ]);
  });

  it("na virada do dia UTC, o dia é o de São Paulo (23h SP = amanhã pela madrugada UTC)", () => {
    const lateNight = new Date("2026-09-21T02:00:00Z"); // 23:00 SP de 20/09
    const [first] = expandDeliveryOptions([MOTOBOY], lateNight);
    expect(first.kind === "motoboy" && first.window.dayKey).toBe("2026-09-21");
    expect(first.kind === "motoboy" && first.when).toBe("tomorrow");
  });
});

describe("isWindowBookable / windowBelongsToRate / describeWindow", () => {
  it("hoje só até o limite; amanhã sempre; ontem nunca; janela precisa existir na faixa", () => {
    const choice = { dayKey: "2026-09-20", start: "19:00", end: "21:00", cutoff: "13:00" };
    expect(isWindowBookable(choice, new Date("2026-09-20T15:59:00Z"))).toBe(true); // 12:59 SP
    expect(isWindowBookable(choice, new Date("2026-09-20T16:00:00Z"))).toBe(false); // 13:00 SP
    expect(isWindowBookable(choice, new Date("2026-09-19T20:00:00Z"))).toBe(true); // véspera
    expect(isWindowBookable(choice, new Date("2026-09-21T12:00:00Z"))).toBe(false); // dia seguinte
    expect(windowBelongsToRate(choice, WINDOWS)).toBe(true);
    expect(windowBelongsToRate({ ...choice, end: "22:00" }, WINDOWS)).toBe(false);
    expect(describeWindow(choice, new Date("2026-09-20T12:00:00Z"))).toBe("hoje, 19h–21h");
    expect(describeWindow(choice, new Date("2026-09-19T12:00:00Z"))).toBe("amanhã, 19h–21h");
    expect(describeWindow(choice, new Date("2026-09-10T12:00:00Z"))).toBe("20/09/2026, 19h–21h");
    expect(formatWindowLabel({ start: "09:00", end: "12:30", cutoff: "08:00" }, "today")).toBe("hoje, 9h–12h30 · pague até 8h");
    expect(optionKeyFor("r", { dayKey: "2026-09-20", start: "09:00" })).toBe("r:2026-09-20:09:00");
    expect(windowDateLabel(choice)).toBe("domingo 20/09, 19h–21h");
  });
});
