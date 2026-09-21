import { describe, expect, it } from "vitest";

import { minutesToTime, parseProductRefs, parseTimeToMinutes, parseWeekdays } from "@/lib/coupon-fields";

describe("parseTimeToMinutes / minutesToTime", () => {
  it("converte e volta", () => {
    expect(parseTimeToMinutes("14:00")).toBe(840);
    expect(parseTimeToMinutes("9:05")).toBe(545);
    expect(parseTimeToMinutes("24:00")).toBe(1440);
    expect(minutesToTime(840)).toBe("14:00");
    expect(minutesToTime(545)).toBe("09:05");
    expect(minutesToTime(1440)).toBe("24:00");
  });

  it("recusa o que não é hora", () => {
    for (const raw of ["", "abc", "14", "14:60", "25:00", "24:01", "14h00"]) {
      expect(parseTimeToMinutes(raw), raw).toBeNull();
    }
  });
});

describe("parseWeekdays", () => {
  it("ordena, deduplica e trata nenhum/todos como 'todo dia'", () => {
    expect(parseWeekdays(["6", "0", "6"])).toEqual([0, 6]);
    expect(parseWeekdays([])).toBeNull();
    expect(parseWeekdays(["0", "1", "2", "3", "4", "5", "6"])).toBeNull();
    expect(parseWeekdays(["7", "x", "2"])).toEqual([2]);
  });
});

describe("parseProductRefs", () => {
  it("uma referência por linha, vírgula também separa, sem repetição", () => {
    expect(parseProductRefs("LONGO-DUNAS\n blusa-maelle , LONGO-DUNAS;\n\n")).toEqual(["LONGO-DUNAS", "blusa-maelle"]);
    expect(parseProductRefs("")).toEqual([]);
  });
});
