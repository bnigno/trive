import { describe, expect, it } from "vitest";

import type { SizeChartRow } from "@/core/catalog/measurements";
import { adviseSize, bodyMeasurementsSchema, chartIsHalfWidth, easeOf, renderSizeAdvice } from "@/core/style/fit";

// Longo Dunas: P/M/G com busto, cintura e quadril; o G só tem comprimento.
const CHART: SizeChartRow[] = [
  { size: "P", measurements: { bust: 88, waist: 70, hip: 94 } },
  { size: "M", measurements: { bust: 94, waist: 76, hip: 100 } },
  { size: "G", measurements: { bust: 100, waist: 82, hip: 106 } },
];

describe("easeOf", () => {
  it("faixas de folga em cm: aperta (<0), marca (0–3), certo (4–10), fluido (11–18), folgado (>18)", () => {
    expect(easeOf(88, 90)).toEqual({ ease: "aperta", cm: -2 });
    expect(easeOf(90, 88)).toEqual({ ease: "marca", cm: 2 });
    expect(easeOf(94, 88)).toEqual({ ease: "certo", cm: 6 });
    expect(easeOf(100, 88)).toEqual({ ease: "fluido", cm: 12 });
    expect(easeOf(110, 88)).toEqual({ ease: "folgado", cm: 22 });
    // easeOf compara circunferências; quem decide "a meio" é a tabela inteira.
    expect(chartIsHalfWidth([{ size: "P", measurements: { bust: 47, waist: 36, hip: 50 } }])).toBe(true);
    expect(chartIsHalfWidth(CHART)).toBe(false);
    expect(chartIsHalfWidth([{ size: "Único", measurements: { length: 110 } }])).toBe(false);
  });
});

describe("adviseSize", () => {
  const body = { bustCm: 88, waistCm: 72, hipsCm: 96 };

  it("sem medidas, sem tabela ou tabela só com comprimento: kinds honestos", () => {
    expect(adviseSize(null, CHART, null)).toEqual({ kind: "no_body" });
    expect(adviseSize(body, [], null)).toEqual({ kind: "no_chart" });
    expect(adviseSize(body, [{ size: "Único", measurements: { length: 110 } }], null)).toEqual({ kind: "no_overlap" });
  });

  it("o pior ponto decide o tamanho; a recomendação segue o caimento preferido", () => {
    const advice = adviseSize(body, CHART, null);
    expect(advice.kind).toBe("advice");
    if (advice.kind !== "advice") return;
    // P: busto 0 (marca), cintura −2 (aperta), quadril −2 (aperta) → aperta.
    expect(advice.verdicts[0]).toMatchObject({ size: "P", overall: "aperta" });
    // M: busto +6, cintura +4, quadril +4 → certo.
    expect(advice.verdicts[1]).toMatchObject({ size: "M", overall: "certo" });
    // G: busto +12, cintura +10, quadril +10 → fluido (o busto puxa).
    expect(advice.verdicts[2]).toMatchObject({ size: "G", overall: "fluido" });
    expect(advice.recommended).toBe("M");
    expect(adviseSize(body, CHART, "fluido")).toMatchObject({ recommended: "G" });
    expect(adviseSize(body, CHART, "justo")).toMatchObject({ recommended: "M" });
    // Corpo maior que tudo: nada serve → sem recomendação.
    const big = adviseSize({ bustCm: 120, waistCm: 100, hipsCm: 120 }, CHART, null);
    expect(big).toMatchObject({ kind: "advice", recommended: null });
  });

  it("a convenção é da tabela inteira: 'a meio' dobra todas as linhas; corpo plus contra circunferência aperta de verdade", () => {
    const half: SizeChartRow[] = [
      { size: "P", measurements: { bust: 50, waist: 45, hip: 55 } },
      { size: "M", measurements: { bust: 53, waist: 48, hip: 58 } },
      { size: "G", measurements: { bust: 56, waist: 51, hip: 61 } },
    ];
    const fluid = adviseSize({ bustCm: 84, waistCm: 66, hipsCm: 92 }, half, "fluido");
    expect(fluid).toMatchObject({ kind: "advice", recommended: "P" });
    if (fluid.kind !== "advice") return;
    // +16/+24/+18: a cintura puxa para "folgado" — mas nada aperta (antes, a heurística por ponto dizia "aperta").
    expect(fluid.verdicts[0]).toMatchObject({ size: "P", overall: "folgado" });
    expect(fluid.verdicts[0].points.map((point) => point.cm)).toEqual([16, 24, 18]);
    // Tabela em circunferência com corpo maior que tudo: aperta, sem inventar folga.
    const plus = adviseSize({ waistCm: 110 }, CHART, null);
    expect(plus).toMatchObject({ kind: "advice", recommended: null });
    if (plus.kind !== "advice") return;
    expect(plus.verdicts.every((verdict) => verdict.overall === "aperta")).toBe(true);
  });

  it("empate marca/fluido pende para o desconforto; entre iguais, o mais confortável", () => {
    const chart: SizeChartRow[] = [
      { size: "P", measurements: { bust: 100, waist: 74, hip: 98 } },
      { size: "M", measurements: { bust: 104, waist: 80, hip: 104 } },
    ];
    const advice = adviseSize({ bustCm: 88, waistCm: 72, hipsCm: 96 }, chart, "fluido");
    expect(advice).toMatchObject({ kind: "advice", recommended: "M" });
    if (advice.kind !== "advice") return;
    expect(advice.verdicts[0]).toMatchObject({ size: "P", overall: "marca" });
    expect(advice.verdicts[1]).toMatchObject({ size: "M", overall: "fluido" });
    expect(renderSizeAdvice(advice)).toContain("o P marca na cintura e no quadril");
  });

  it("a frase é determinística e em português", () => {
    const text = renderSizeAdvice(adviseSize(body, CHART, null));
    expect(text).toContain("o P aperta na cintura e no quadril");
    expect(text).toContain("no M fica certo (busto 6 cm de folga, cintura 4 cm de folga, quadril 4 cm de folga)");
    expect(text).toContain("Eu iria de M.");
    expect(renderSizeAdvice({ kind: "no_body" })).toContain("Me conta suas medidas");
    expect(renderSizeAdvice({ kind: "no_overlap" })).toContain("só traz comprimento");
  });

  it("schema: entre 40 e 200, ao menos uma medida", () => {
    expect(bodyMeasurementsSchema.safeParse({ bustCm: 88 }).success).toBe(true);
    expect(bodyMeasurementsSchema.safeParse({}).success).toBe(false);
    expect(bodyMeasurementsSchema.safeParse({ bustCm: 20 }).success).toBe(false);
    // Numeração de roupa não é medida.
    expect(bodyMeasurementsSchema.safeParse({ bustCm: 42 }).success).toBe(false);
    expect(bodyMeasurementsSchema.safeParse({ waistCm: 55 }).success).toBe(true);
  });
});
