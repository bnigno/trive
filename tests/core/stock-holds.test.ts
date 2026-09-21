import { describe, expect, it } from "vitest";

import { describeHold, holdExpiresAt, isReminderDue } from "@/core/stock/holds";
import { lastUnitCrossed, restockCrossed } from "@/core/stock/ledger";

describe("reserva gentil", () => {
  const now = new Date("2026-09-10T15:00:00Z");

  it("vence em 24 h por padrão, com o prazo limitado a 1–168 h", () => {
    expect(holdExpiresAt(now).toISOString()).toBe("2026-09-11T15:00:00.000Z");
    expect(holdExpiresAt(now, 0).toISOString()).toBe("2026-09-10T16:00:00.000Z");
    expect(holdExpiresAt(now, 500).getTime() - now.getTime()).toBe(168 * 3_600_000);
  });

  it("lembrete único nas 2 h finais, só para reserva ativa sem lembrete", () => {
    const hold = { status: "active", expiresAt: new Date("2026-09-10T17:00:00Z"), reminderSentAt: null };
    expect(isReminderDue(hold, new Date("2026-09-10T14:59:00Z"))).toBe(false);
    expect(isReminderDue(hold, new Date("2026-09-10T15:00:00Z"))).toBe(true);
    expect(isReminderDue(hold, new Date("2026-09-10T17:00:00Z"))).toBe(false);
    expect(isReminderDue({ ...hold, reminderSentAt: now }, new Date("2026-09-10T16:00:00Z"))).toBe(false);
    expect(isReminderDue({ ...hold, status: "released" }, new Date("2026-09-10T16:00:00Z"))).toBe(false);
  });

  it("descreve a reserva para o caderninho em horário de São Paulo", () => {
    expect(
      describeHold({ productName: "Vestido Dunas", variantLabel: "Preto · M", quantity: 1, expiresAt: new Date("2026-09-11T17:00:00Z") }),
    ).toBe("1× Vestido Dunas (Preto · M) — guardada até 11/09 às 14:00");
    expect(
      describeHold({ productName: "Bolsa Tote", variantLabel: "", quantity: 2, expiresAt: new Date("2026-09-11T17:00:00Z") }),
    ).toBe("2× Bolsa Tote — guardada até 11/09 às 14:00");
  });
});

describe("restockCrossed", () => {
  it("só quando o disponível sai de ≤ 0 para > 0", () => {
    expect(restockCrossed({ onHand: 2, reserved: 2 }, { onHand: 3, reserved: 2 })).toBe(true);
    expect(restockCrossed({ onHand: 0, reserved: 0 }, { onHand: 1, reserved: 0 })).toBe(true);
    expect(restockCrossed({ onHand: 2, reserved: 2 }, { onHand: 2, reserved: 1 })).toBe(true);
    expect(restockCrossed({ onHand: 3, reserved: 0 }, { onHand: 5, reserved: 0 })).toBe(false);
    expect(restockCrossed({ onHand: 1, reserved: 1 }, { onHand: 1, reserved: 1 })).toBe(false);
    expect(restockCrossed({ onHand: 2, reserved: 0 }, { onHand: 0, reserved: 0 })).toBe(false);
  });
});

describe("lastUnitCrossed (Provador: 'ficou a última no seu tamanho')", () => {
  it("só quando o disponível cai de 2+ para exatamente 1 — venda ou reserva; reposição, zerar e ficar em 1 não contam", () => {
    expect(lastUnitCrossed({ onHand: 2, reserved: 0 }, { onHand: 1, reserved: 0 })).toBe(true);
    expect(lastUnitCrossed({ onHand: 3, reserved: 1 }, { onHand: 3, reserved: 2 })).toBe(true);
    expect(lastUnitCrossed({ onHand: 5, reserved: 0 }, { onHand: 1, reserved: 0 })).toBe(true);
    expect(lastUnitCrossed({ onHand: 1, reserved: 0 }, { onHand: 1, reserved: 0 })).toBe(false);
    expect(lastUnitCrossed({ onHand: 2, reserved: 0 }, { onHand: 0, reserved: 0 })).toBe(false);
    expect(lastUnitCrossed({ onHand: 0, reserved: 0 }, { onHand: 1, reserved: 0 })).toBe(false);
    expect(lastUnitCrossed({ onHand: 1, reserved: 0 }, { onHand: 2, reserved: 0 })).toBe(false);
  });
});
