import { describe, expect, it } from "vitest";

import { deliveredStepDetail, deliveryLine, deliveryWhen, normalizeReceivedBy } from "@/core/orders/delivery";

// 20:42Z = 17:42 em São Paulo.
const AT = new Date("2026-09-13T20:42:00Z");

describe("normalizeReceivedBy", () => {
  it("fica só o primeiro nome, com inicial maiúscula; vazio ou só símbolos vira null", () => {
    expect(normalizeReceivedBy("  maria aparecida da silva ")).toBe("Maria");
    expect(normalizeReceivedBy("Portaria")).toBe("Portaria");
    expect(normalizeReceivedBy("d'Ávila")).toBe("D'Ávila");
    expect(normalizeReceivedBy("")).toBeNull();
    expect(normalizeReceivedBy("   ")).toBeNull();
    expect(normalizeReceivedBy("***")).toBeNull();
    expect(normalizeReceivedBy(null)).toBeNull();
    expect(normalizeReceivedBy("x".repeat(100))?.length).toBe(60);
  });
});

describe("deliveryWhen / deliveryLine", () => {
  it("hoje, ontem ou a data — no relógio de São Paulo", () => {
    expect(deliveryWhen(AT, new Date("2026-09-13T23:00:00Z"))).toBe("hoje às 17:42");
    expect(deliveryWhen(AT, new Date("2026-09-14T12:00:00Z"))).toBe("ontem às 17:42");
    expect(deliveryWhen(AT, new Date("2026-09-20T12:00:00Z"))).toBe("13/09 às 17:42");
    // 02:30Z do dia 14 ainda é 23:30 do dia 13 em SP.
    expect(deliveryWhen(AT, new Date("2026-09-14T02:30:00Z"))).toBe("hoje às 17:42");
  });

  it("com quem recebeu, a linha completa; sem, só a hora", () => {
    expect(deliveryLine({ deliveredAt: AT, receivedBy: "Maria", now: new Date("2026-09-13T23:00:00Z") })).toBe("hoje às 17:42, recebido por Maria");
    expect(deliveryLine({ deliveredAt: AT, receivedBy: null, now: new Date("2026-09-13T23:00:00Z") })).toBe("hoje às 17:42");
    expect(deliveredStepDetail("Maria")).toBe("Recebido por Maria");
    expect(deliveredStepDetail(null)).toBeNull();
  });
});
