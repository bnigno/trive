// Transferência para a equipe (PURO): horas de silêncio saneadas, prazo do
// silêncio e a régua de "conversa parada" da volta automática.
import { describe, expect, it } from "vitest";

import {
  DEFAULT_HANDOFF_AUTO_RETURN_HOURS,
  DEFAULT_HANDOFF_SILENCE_HOURS,
  HANDOFF_HOURS_MAX,
  hoursSetting,
  isIdleForHours,
  lastActivityAt,
  silenceUntil,
} from "@/core/whatsapp/handoff";

const NOW = new Date("2026-09-11T15:00:00Z");
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 60 * 60_000);

describe("hoursSetting", () => {
  it("aceita inteiro dentro da faixa; fora dela, não inteiro ou tipo errado cai no padrão", () => {
    expect(hoursSetting(2, DEFAULT_HANDOFF_SILENCE_HOURS, { min: 1 })).toBe(2);
    expect(hoursSetting(HANDOFF_HOURS_MAX, 24, { min: 1 })).toBe(168);
    expect(hoursSetting(0, 24, { min: 1 })).toBe(24);
    expect(hoursSetting(0, 12, { min: 0 })).toBe(0);
    expect(hoursSetting(169, 12, { min: 0 })).toBe(12);
    expect(hoursSetting(1.5, 24, { min: 1 })).toBe(24);
    expect(hoursSetting("2", 24, { min: 1 })).toBe(24);
    expect(hoursSetting(undefined, DEFAULT_HANDOFF_AUTO_RETURN_HOURS, { min: 0 })).toBe(12);
  });
});

describe("silenceUntil / lastActivityAt / isIdleForHours", () => {
  it("silêncio termina N horas depois de agora", () => {
    expect(silenceUntil(NOW, 2).toISOString()).toBe("2026-09-11T17:00:00.000Z");
  });

  it("a última atividade é a mais recente entre inbound, outbound e updatedAt", () => {
    expect(
      lastActivityAt({ lastInboundAt: hoursAgo(5), lastOutboundAt: hoursAgo(2), updatedAt: hoursAgo(8) }).toISOString(),
    ).toBe(hoursAgo(2).toISOString());
    expect(lastActivityAt({ lastInboundAt: null, lastOutboundAt: null, updatedAt: hoursAgo(1) }).toISOString()).toBe(
      hoursAgo(1).toISOString(),
    );
  });

  it("parada há N horas ou mais volta; 0 nunca volta", () => {
    expect(isIdleForHours(hoursAgo(12), NOW, 12)).toBe(true);
    expect(isIdleForHours(hoursAgo(11), NOW, 12)).toBe(false);
    expect(isIdleForHours(hoursAgo(100), NOW, 0)).toBe(false);
  });
});
