// {{janela}} e {{dia}} do aviso "Saiu da TRIVÉ" (motoboy) — puros.
import { describe, expect, it } from "vitest";

import { buildOrderVars, deliveryDayWord } from "@/services/wa-messaging";

const base = { orderNumber: 1234, customerName: "Ana Souza", totalCents: 15900, publicToken: "tok", paymentDueAt: null };

describe("buildOrderVars com janela de motoboy", () => {
  it("janela '19h e 21h' e dia 'hoje' / 'amanhã' / 'sábado 19/09'; sem janela ficam vazias", () => {
    const window = { dayKey: "2026-09-18", start: "19:00", end: "21:00" };
    const today = new Date("2026-09-18T14:00:00Z");
    expect(buildOrderVars({ ...base, deliveryWindow: window, now: today })).toMatchObject({ janela: "19h e 21h", dia: "hoje" });
    expect(buildOrderVars({ ...base, deliveryWindow: window, now: new Date("2026-09-17T14:00:00Z") }).dia).toBe("amanhã");
    expect(buildOrderVars({ ...base, deliveryWindow: { ...window, dayKey: "2026-09-19" }, now: new Date("2026-09-17T14:00:00Z") }).dia).toBe("sábado 19/09");
    expect(buildOrderVars({ ...base, deliveryWindow: { dayKey: "2026-09-18", start: "09:30", end: "12:00" }, now: today }).janela).toBe("9h30 e 12h");
    expect(buildOrderVars(base)).toMatchObject({ janela: "", dia: "" });
  });

  it("deliveryDayWord segue o dia de São Paulo, não o UTC", () => {
    // 23:30 SP de 17/09 = 02:30Z de 18/09 → "amanhã" para 18/09.
    expect(deliveryDayWord("2026-09-18", new Date("2026-09-18T02:30:00Z"))).toBe("amanhã");
  });
});
