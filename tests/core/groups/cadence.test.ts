import { describe, expect, it } from "vitest";

import {
  CADENCE_REFUSAL_MESSAGES,
  canPublishNow,
  canSchedulePost,
  DEFAULT_GROUP_CADENCE,
  isPostTooLate,
  nextPublishableAt,
  nextRitualDay,
  ritualHour,
  ritualWeekday,
  spWeekKey,
} from "@/core/groups/cadence";

// Segunda 2026-09-21 10:00 SP = 13:00Z.
const NOW = new Date("2026-09-21T13:00:00Z");
const sp = (day: string, hour: number) => new Date(`${day}T${String(hour).padStart(2, "0")}:00:00-03:00`);

describe("spWeekKey", () => {
  it("a semana vai de segunda a domingo no calendário de SP; a chave é a segunda", () => {
    expect(spWeekKey(sp("2026-09-21", 10))).toBe("2026-09-21"); // segunda
    expect(spWeekKey(sp("2026-09-24", 19))).toBe("2026-09-21"); // quinta
    expect(spWeekKey(sp("2026-09-27", 23))).toBe("2026-09-21"); // domingo ainda é a mesma semana
    expect(spWeekKey(sp("2026-09-28", 0))).toBe("2026-09-28"); // segunda seguinte
    // 23:30 SP de domingo = 02:30Z de segunda: continua domingo em SP.
    expect(spWeekKey(new Date("2026-09-28T02:30:00Z"))).toBe("2026-09-21");
  });
});

describe("canSchedulePost (teto 3/semana, 1/dia, domingo em silêncio, janela 9–21)", () => {
  it("terça 10h, quinta 19h e sábado 10h na mesma semana passam; o quarto post da semana não", () => {
    const tue = sp("2026-09-22", 10);
    const thu = sp("2026-09-24", 19);
    const sat = sp("2026-09-26", 10);
    expect(canSchedulePost({ candidateAt: tue, existing: [], now: NOW })).toEqual({ ok: true });
    expect(canSchedulePost({ candidateAt: thu, existing: [tue], now: NOW })).toEqual({ ok: true });
    expect(canSchedulePost({ candidateAt: sat, existing: [tue, thu], now: NOW })).toEqual({ ok: true });
    expect(canSchedulePost({ candidateAt: sp("2026-09-25", 15), existing: [tue, thu, sat], now: NOW })).toEqual({
      ok: false,
      reason: "teto_semanal",
    });
    // Semana seguinte zera a conta.
    expect(canSchedulePost({ candidateAt: sp("2026-09-29", 10), existing: [tue, thu, sat], now: NOW })).toEqual({ ok: true });
  });

  it("dois posts no mesmo dia SP nunca — mesmo em horas diferentes e mesmo com a semana livre", () => {
    const morning = sp("2026-09-22", 10);
    expect(canSchedulePost({ candidateAt: sp("2026-09-22", 18), existing: [morning], now: NOW })).toEqual({
      ok: false,
      reason: "mesmo_dia",
    });
    // 20:30 SP de terça (23:30Z) ainda é terça.
    expect(canSchedulePost({ candidateAt: new Date("2026-09-22T23:30:00Z"), existing: [morning], now: NOW })).toEqual({
      ok: false,
      reason: "mesmo_dia",
    });
  });

  it("domingo fica em silêncio; fora da janela (8h59, 21h) recusa; passado recusa, mas 'agora' tolera 2 min de fila", () => {
    expect(canSchedulePost({ candidateAt: sp("2026-09-27", 10), existing: [], now: NOW })).toEqual({ ok: false, reason: "dia_de_silencio" });
    expect(canSchedulePost({ candidateAt: new Date("2026-09-22T11:59:00Z"), existing: [], now: NOW })).toEqual({ ok: false, reason: "fora_da_janela" });
    expect(canSchedulePost({ candidateAt: sp("2026-09-22", 21), existing: [], now: NOW })).toEqual({ ok: false, reason: "fora_da_janela" });
    expect(canSchedulePost({ candidateAt: sp("2026-09-22", 20), existing: [], now: NOW })).toEqual({ ok: true });
    expect(canSchedulePost({ candidateAt: new Date(NOW.getTime() - 60_000), existing: [], now: NOW })).toEqual({ ok: true });
    expect(canSchedulePost({ candidateAt: new Date(NOW.getTime() - 3 * 60_000), existing: [], now: NOW })).toEqual({ ok: false, reason: "passado" });
  });

  it("a política é ajustável: teto 1/semana e sem dia de silêncio", () => {
    const policy = { ...DEFAULT_GROUP_CADENCE, postsPerWeek: 1, quietWeekdays: [] };
    expect(canSchedulePost({ candidateAt: sp("2026-09-27", 10), existing: [], now: NOW, policy })).toEqual({ ok: true });
    expect(canSchedulePost({ candidateAt: sp("2026-09-24", 10), existing: [sp("2026-09-22", 10)], now: NOW, policy })).toEqual({
      ok: false,
      reason: "teto_semanal",
    });
  });

  it("toda recusa tem uma frase para a dona", () => {
    for (const reason of ["passado", "dia_de_silencio", "fora_da_janela", "mesmo_dia", "teto_semanal"] as const) {
      expect(CADENCE_REFUSAL_MESSAGES[reason].length).toBeGreaterThan(10);
    }
  });
});

describe("rituais no calendário", () => {
  it("chegadas = terça 10h, enquete = quinta 19h, quem vestiu = sábado 10h; cortina e livre sem dia fixo", () => {
    expect([ritualWeekday("chegadas"), ritualHour("chegadas")]).toEqual([2, 10]);
    expect([ritualWeekday("enquete"), ritualHour("enquete")]).toEqual([4, 19]);
    expect([ritualWeekday("quem_vestiu"), ritualHour("quem_vestiu")]).toEqual([6, 10]);
    expect(ritualWeekday("cortina")).toBeNull();
    expect(ritualWeekday("livre")).toBeNull();
  });

  it("nextRitualDay: da segunda, a próxima terça; da própria terça antes das 10h, hoje; depois das 10h, a terça seguinte", () => {
    expect(nextRitualDay("chegadas", NOW)).toBe("2026-09-22");
    expect(nextRitualDay("chegadas", sp("2026-09-22", 8))).toBe("2026-09-22");
    expect(nextRitualDay("chegadas", sp("2026-09-22", 11))).toBe("2026-09-29");
    expect(nextRitualDay("enquete", NOW)).toBe("2026-09-24");
    expect(nextRitualDay("quem_vestiu", sp("2026-09-26", 12))).toBe("2026-10-03");
    // Sem dia fixo: o próximo dia que não é de silêncio (sábado 12h → domingo é silêncio → segunda).
    expect(nextRitualDay("livre", sp("2026-09-26", 12))).toBe("2026-09-28");
  });
});

describe("hora de publicar (a fila atrasa)", () => {
  it("isPostTooLate: até 6 h depois da hora marcada ainda vale; depois não", () => {
    const at = sp("2026-09-22", 10);
    expect(isPostTooLate(at, sp("2026-09-22", 15))).toBe(false);
    expect(isPostTooLate(at, new Date(at.getTime() + 6 * 3_600_000))).toBe(false);
    expect(isPostTooLate(at, new Date(at.getTime() + 6 * 3_600_000 + 1))).toBe(true);
  });

  it("canPublishNow: dentro da janela sim; até 30 min depois do fim ainda sim (folga da fila); 21h31 não; domingo nunca", () => {
    expect(canPublishNow(sp("2026-09-22", 10))).toBe(true);
    expect(canPublishNow(new Date("2026-09-23T00:20:00Z"))).toBe(true); // terça 21:20 SP
    expect(canPublishNow(new Date("2026-09-23T00:31:00Z"))).toBe(false); // terça 21:31 SP
    expect(canPublishNow(new Date("2026-09-22T11:59:00Z"))).toBe(false); // terça 08:59 SP
    expect(canPublishNow(sp("2026-09-27", 10))).toBe(false); // domingo
    expect(canPublishNow(sp("2026-09-27", 10), { ...DEFAULT_GROUP_CADENCE, quietWeekdays: [] })).toBe(true);
  });

  it("nextPublishableAt: agora se pode; senão a abertura da janela no próximo dia que não é de silêncio (sábado 22h → segunda 9h)", () => {
    const tue10 = sp("2026-09-22", 10);
    expect(nextPublishableAt(tue10)).toEqual(tue10);
    expect(nextPublishableAt(sp("2026-09-22", 22))).toEqual(sp("2026-09-23", 9));
    expect(nextPublishableAt(sp("2026-09-26", 22))).toEqual(sp("2026-09-28", 9)); // sábado à noite pula o domingo
    expect(nextPublishableAt(sp("2026-09-27", 12))).toEqual(sp("2026-09-28", 9)); // domingo ao meio-dia
    expect(nextPublishableAt(new Date("2026-09-22T11:30:00Z"))).toEqual(sp("2026-09-22", 9)); // 8h30 → 9h do mesmo dia
  });
});
