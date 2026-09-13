// Data marcada (PURO): dias úteis com feriado, chega a tempo por opção,
// ship_by, semáforo e o selo das datas da cidade.
import { describe, expect, it } from "vitest";

import { isNationalHoliday } from "@/core/shipping/holidays";
import {
  assessNeededBy,
  citySealFor,
  isValidNeededBy,
  postingDayFor,
  shipByFor,
  shipByLabel,
  trafficLight,
} from "@/core/shipping/needed-by";
import { addBusinessDaysSP, subtractBusinessDaysSP } from "@/lib/sp-day";

describe("dias úteis com feriado", () => {
  it("pula sábado, domingo e feriado nacional fixo (12/10); n = 0 devolve o próprio dia", () => {
    // sexta 09/10/2026 + 1 dia útil: sáb 10, dom 11, seg 12 (feriado) → ter 13
    expect(addBusinessDaysSP("2026-10-09", 1, isNationalHoliday)).toBe("2026-10-13");
    expect(addBusinessDaysSP("2026-10-09", 3, isNationalHoliday)).toBe("2026-10-15");
    expect(addBusinessDaysSP("2026-10-09", 0, isNationalHoliday)).toBe("2026-10-09");
    expect(subtractBusinessDaysSP("2026-10-13", 1, isNationalHoliday)).toBe("2026-10-09");
    expect(subtractBusinessDaysSP("2026-10-16", 5, isNationalHoliday)).toBe("2026-10-08");
    expect(isNationalHoliday("2026-12-25")).toBe(true);
    expect(isNationalHoliday("2026-10-11")).toBe(false);
  });
});

describe("isValidNeededBy", () => {
  it("dia real, hoje ou depois", () => {
    expect(isValidNeededBy("2026-10-16", "2026-10-05")).toBe(true);
    expect(isValidNeededBy("2026-10-05", "2026-10-05")).toBe(true);
    expect(isValidNeededBy("2026-10-04", "2026-10-05")).toBe(false);
    expect(isValidNeededBy("2026-02-31", "2026-01-01")).toBe(false);
    expect(isValidNeededBy("16/10/2026", "2026-01-01")).toBe(false);
  });
});

describe("assessNeededBy / shipByFor", () => {
  const now = new Date("2026-10-05T13:00:00Z"); // segunda 5/10, 10h SP
  it("Correios: sai hoje + prazo máximo em dias úteis (feriado conta); motoboy chega no dia da janela", () => {
    // 5 dias úteis a partir de seg 5/10: 6,7,8,9, (10-11 fds), 12 feriado, 13 → 13/10
    expect(assessNeededBy({ kind: "correios", deliveryDaysMax: 5 }, "2026-10-16", now)).toEqual({
      fits: true,
      arrivesBy: "2026-10-13",
      daysToSpare: 3,
      label: "Chega até terça 13/10, 3 dias antes",
    });
    expect(assessNeededBy({ kind: "correios", deliveryDaysMax: 5 }, "2026-10-13", now)).toMatchObject({ fits: true, daysToSpare: 0, label: "Chega até terça 13/10, no dia" });
    expect(assessNeededBy({ kind: "correios", deliveryDaysMax: 9 }, "2026-10-16", now)).toEqual({
      fits: false,
      arrivesBy: "2026-10-19",
      daysLate: 3,
      label: "Pode chegar só segunda 19/10 — 3 dias depois",
    });
    expect(assessNeededBy({ kind: "motoboy", dayKey: "2026-10-05" }, "2026-10-05", now)).toMatchObject({ fits: true, daysToSpare: 0 });
    expect(assessNeededBy({ kind: "motoboy", dayKey: "2026-10-06" }, "2026-10-05", now)).toMatchObject({ fits: false, daysLate: 1 });
  });

  it("fim de semana e feriado: posta no próximo dia útil — o checkout e o ship_by concordam", () => {
    expect(postingDayFor("2026-09-13")).toBe("2026-09-14"); // domingo → segunda
    expect(postingDayFor("2026-09-07")).toBe("2026-09-08"); // feriado → terça
    expect(postingDayFor("2026-09-15")).toBe("2026-09-15");
    // Domingo 13/09, PAC 5 dias úteis, "até 18/09": posta seg 14 → 15,16,17,18,21 → chega 21/09: NÃO chega.
    const sunday = new Date("2026-09-13T13:00:00Z");
    expect(assessNeededBy({ kind: "correios", deliveryDaysMax: 5 }, "2026-09-18", sunday)).toMatchObject({ fits: false, arrivesBy: "2026-09-21", daysLate: 3 });
    // E o ship_by desse pedido (11/09) é anterior ao dia de postagem (14/09): vermelho no painel — coerente com o ✕.
    expect(shipByFor({ kind: "correios", deliveryDaysMax: 5 }, "2026-09-18") < postingDayFor("2026-09-13")).toBe(true);
    // Prazo 1 dia, "até 15/09" num domingo: posta seg 14, chega ter 15 → no dia, e ship_by 14 ≥ postagem.
    expect(assessNeededBy({ kind: "correios", deliveryDaysMax: 1 }, "2026-09-15", sunday)).toMatchObject({ fits: true, arrivesBy: "2026-09-15", daysToSpare: 0 });
    expect(shipByFor({ kind: "correios", deliveryDaysMax: 1 }, "2026-09-15")).toBe("2026-09-14");
  });

  it("ship_by: Correios volta o prazo em dias úteis; motoboy é o dia da janela", () => {
    expect(shipByFor({ kind: "correios", deliveryDaysMax: 5 }, "2026-10-16")).toBe("2026-10-08");
    expect(shipByFor({ kind: "correios", deliveryDaysMax: 0 }, "2026-10-16")).toBe("2026-10-16");
    expect(shipByFor({ kind: "motoboy", dayKey: "2026-10-05" }, "2026-10-16")).toBe("2026-10-05");
  });
});

describe("trafficLight / shipByLabel", () => {
  it("hoje ou atrasado = vermelho; amanhã = âmbar; depois = verde", () => {
    expect(trafficLight("2026-10-05", "2026-10-05")).toBe("red");
    expect(trafficLight("2026-10-03", "2026-10-05")).toBe("red");
    expect(trafficLight("2026-10-06", "2026-10-05")).toBe("amber");
    expect(trafficLight("2026-10-07", "2026-10-05")).toBe("green");
    expect(shipByLabel("2026-10-03", "2026-10-05")).toBe("Atrasou 2 dias");
    expect(shipByLabel("2026-10-05", "2026-10-05")).toBe("Sai hoje");
    expect(shipByLabel("2026-10-06", "2026-10-05")).toBe("Sai amanhã");
    expect(shipByLabel("2026-10-09", "2026-10-05")).toBe("Sai até sexta 09/10");
  });
});

describe("citySealFor", () => {
  const dates = [
    { name: "Natal", date: "2026-12-25" },
    { name: "Círio", date: "2026-10-11" },
    { name: "Passou", date: "2026-09-01" },
  ];
  it("a próxima data à frente, com o dia-limite pelos Correios (dias úteis + feriado); depois do limite, só motoboy", () => {
    const seal = citySealFor(dates, new Date("2026-09-13T13:00:00Z"), 9);
    expect(seal).toMatchObject({ name: "Círio", date: "2026-10-11", daysUntil: 28 });
    // 9 dias úteis antes de dom 11/10: sex 9, qui 8, qua 7, ter 6, seg 5, sex 2, qui 1, qua 30/9, ter 29/9
    expect(seal?.orderBy).toBe("2026-09-29");
    expect(seal?.text).toBe("Círio em 28 dias · peça até 29/09 para chegar pelos Correios");
    expect(citySealFor(dates, new Date("2026-10-08T13:00:00Z"), 9)?.text).toBe("Círio em 3 dias · pelos Correios não chega mais; motoboy em Belém");
    expect(citySealFor(dates, new Date("2026-10-11T13:00:00Z"), 9)?.text).toMatch(/^Círio é hoje/);
    expect(citySealFor(dates, new Date("2026-10-20T13:00:00Z"), 9)?.name).toBe("Natal");
    expect(citySealFor([], new Date(), 9)).toBeNull();
    // Sem faixa de Correios: só a contagem, sem prometer prazo.
    expect(citySealFor(dates, new Date("2026-09-13T13:00:00Z"), null)?.text).toBe("Círio em 28 dias");
    expect(citySealFor(dates, new Date("2026-09-13T13:00:00Z"), 0)?.text).toBe("Círio em 28 dias");
    expect(citySealFor([{ name: "Passou", date: "2026-09-01" }], new Date("2026-09-13T13:00:00Z"), 9)).toBeNull();
  });
});
