// Edições de Belém (PURO): vigência por período e/ou hora no relógio de SP
// (inclusive na virada do dia UTC), prioridade hora > período > sempre,
// dias até começar e o rótulo da vigência.
import { describe, expect, it } from "vitest";

import {
  daysUntilEdition,
  editionKind,
  editionPeriodLabel,
  isEditionCurrent,
  isEditionPast,
  isEditionUpcoming,
  pickCurrentEdition,
  type EditionRule,
} from "@/core/city-editions";

const ALWAYS: EditionRule = { startsOn: null, endsOn: null, hourStart: null, hourEnd: null };
const CIRIO: EditionRule = { startsOn: "2026-10-01", endsOn: "2026-10-12", hourStart: null, hourEnd: null };
const CHUVA: EditionRule = { startsOn: null, endsOn: null, hourStart: 14, hourEnd: 16 };
const CHUVA_DO_CIRIO: EditionRule = { ...CIRIO, hourStart: 14, hourEnd: 16 };

describe("editionKind / isEditionCurrent", () => {
  it("período é inclusivo nos dois lados, no dia de São Paulo (23h30 SP de 12/10 = 02h30Z de 13/10 ainda é Círio)", () => {
    expect(editionKind(CIRIO)).toBe("period");
    expect(isEditionCurrent(CIRIO, new Date("2026-10-01T03:00:00Z"))).toBe(true); // 00:00 SP de 1/10
    expect(isEditionCurrent(CIRIO, new Date("2026-10-01T02:59:00Z"))).toBe(false); // 23:59 SP de 30/09
    expect(isEditionCurrent(CIRIO, new Date("2026-10-13T02:30:00Z"))).toBe(true); // 23:30 SP de 12/10
    expect(isEditionCurrent(CIRIO, new Date("2026-10-13T03:00:00Z"))).toBe(false); // 00:00 SP de 13/10
  });

  it("hora do dia: [início, fim) no relógio de SP; combinada com período exige os dois", () => {
    expect(editionKind(CHUVA)).toBe("hours");
    expect(isEditionCurrent(CHUVA, new Date("2026-09-20T17:00:00Z"))).toBe(true); // 14:00 SP
    expect(isEditionCurrent(CHUVA, new Date("2026-09-20T18:59:00Z"))).toBe(true); // 15:59 SP
    expect(isEditionCurrent(CHUVA, new Date("2026-09-20T19:00:00Z"))).toBe(false); // 16:00 SP
    expect(editionKind(CHUVA_DO_CIRIO)).toBe("period_hours");
    expect(isEditionCurrent(CHUVA_DO_CIRIO, new Date("2026-10-05T17:30:00Z"))).toBe(true);
    expect(isEditionCurrent(CHUVA_DO_CIRIO, new Date("2026-09-20T17:30:00Z"))).toBe(false);
    expect(editionKind(ALWAYS)).toBe("always");
    expect(isEditionCurrent(ALWAYS, new Date("2026-01-01T00:00:00Z"))).toBe(true);
  });

  it("só começo ou só fim também valem", () => {
    expect(isEditionCurrent({ ...ALWAYS, startsOn: "2026-10-01" }, new Date("2026-12-25T12:00:00Z"))).toBe(true);
    expect(isEditionCurrent({ ...ALWAYS, endsOn: "2026-10-12" }, new Date("2026-01-01T12:00:00Z"))).toBe(true);
    expect(isEditionCurrent({ ...ALWAYS, endsOn: "2026-10-12" }, new Date("2026-10-14T12:00:00Z"))).toBe(false);
  });
});

describe("pickCurrentEdition", () => {
  const editions = [
    { id: "always", sortOrder: 0, ...ALWAYS },
    { id: "cirio", sortOrder: 5, ...CIRIO },
    { id: "chuva", sortOrder: 9, ...CHUVA },
    { id: "chuva-cirio", sortOrder: 9, ...CHUVA_DO_CIRIO },
  ];
  it("hora > período > sempre; empate pela ordem; nenhuma vigente → null", () => {
    expect(pickCurrentEdition(editions, new Date("2026-10-05T17:30:00Z"))?.id).toBe("chuva-cirio"); // 14:30 SP no Círio
    expect(pickCurrentEdition(editions, new Date("2026-10-05T12:00:00Z"))?.id).toBe("cirio"); // 9:00 SP no Círio
    expect(pickCurrentEdition(editions, new Date("2026-09-20T17:30:00Z"))?.id).toBe("chuva"); // 14:30 SP fora do Círio
    expect(pickCurrentEdition(editions, new Date("2026-09-20T12:00:00Z"))?.id).toBe("always");
    expect(pickCurrentEdition([{ id: "a", sortOrder: 2, ...CIRIO }, { id: "b", sortOrder: 1, ...CIRIO }], new Date("2026-10-05T12:00:00Z"))?.id).toBe("b");
    expect(pickCurrentEdition([{ id: "cirio", sortOrder: 0, ...CIRIO }], new Date("2026-09-20T12:00:00Z"))).toBeNull();
    // "Sempre" com ordem alta continua sendo escolhida quando é a única vigente.
    expect(pickCurrentEdition([{ id: "always-9", sortOrder: 9, ...ALWAYS }], new Date("2026-09-20T12:00:00Z"))?.id).toBe("always-9");
  });
});

describe("daysUntilEdition / isEditionUpcoming / isEditionPast", () => {
  it("conta dias no calendário de SP; 0 quando já está no ar; null sem começo ou já encerrada", () => {
    expect(daysUntilEdition(CIRIO, new Date("2026-09-21T12:00:00Z"))).toBe(10);
    expect(daysUntilEdition(CIRIO, new Date("2026-10-01T02:30:00Z"))).toBe(1); // 23:30 SP de 30/09
    expect(daysUntilEdition(CIRIO, new Date("2026-10-05T12:00:00Z"))).toBe(0);
    expect(daysUntilEdition(CIRIO, new Date("2026-10-20T12:00:00Z"))).toBeNull();
    expect(daysUntilEdition(ALWAYS, new Date("2026-10-20T12:00:00Z"))).toBeNull();
    expect(isEditionUpcoming(CIRIO, new Date("2026-09-21T12:00:00Z"))).toBe(true);
    expect(isEditionUpcoming(CIRIO, new Date("2026-10-05T12:00:00Z"))).toBe(false);
    expect(isEditionPast(CIRIO, new Date("2026-10-20T12:00:00Z"))).toBe(true);
    expect(isEditionPast(ALWAYS, new Date("2026-10-20T12:00:00Z"))).toBe(false);
  });
});

describe("editionPeriodLabel", () => {
  it("período, só começo, só fim, hora, combinado e sempre", () => {
    expect(editionPeriodLabel(CIRIO)).toBe("1 out a 12 out");
    expect(editionPeriodLabel({ ...ALWAYS, startsOn: "2026-10-01" })).toBe("a partir de 1 out");
    expect(editionPeriodLabel({ ...ALWAYS, endsOn: "2026-10-12" })).toBe("até 12 out");
    expect(editionPeriodLabel({ ...CIRIO, endsOn: "2026-10-01" })).toBe("dia 1 out");
    expect(editionPeriodLabel(CHUVA)).toBe("das 14h às 16h");
    expect(editionPeriodLabel(CHUVA_DO_CIRIO)).toBe("1 out a 12 out · das 14h às 16h");
    expect(editionPeriodLabel(ALWAYS)).toBe("sempre");
  });
});
