// Portão de fidelidade e custo do ensaio (core, puro): o JSON do julgamento,
// a regra de corte, o resumo para a dona, o teto de tentativas e a conta
// em centavos de dólar (arredondada para cima).
import { describe, expect, it } from "vitest";

import {
  creditsFor,
  creditsToUsdCents,
  estimateRequestUsdCents,
  FASHN_CREDITS_PER_IMAGE,
  studioCostTable,
  usdCentsToBrlCents,
} from "@/core/studio/cost";
import {
  canRetryAttempt,
  FIDELITY_JSON_SCHEMA,
  FIDELITY_MIN_SCORE,
  fidelityJudgmentSchema,
  fidelitySummary,
  MAX_ATTEMPTS_PER_OPTION,
  passesFidelity,
} from "@/core/studio/fidelity";

const APPROVED = { mesma_peca: true, cor_ok: true, estampa_ok: true, corte_ok: true, artefatos: [], nota: 8 };

describe("portão de fidelidade", () => {
  it("o schema JSON e o Zod pedem os mesmos campos e recusam nota fora de 0–10", () => {
    const required = (FIDELITY_JSON_SCHEMA as { required: string[] }).required;
    expect(required.sort()).toEqual(Object.keys(fidelityJudgmentSchema.shape).sort());
    expect(fidelityJudgmentSchema.safeParse({ ...APPROVED, nota: 11 }).success).toBe(false);
    expect(fidelityJudgmentSchema.safeParse({ ...APPROVED, nota: 7.5 }).success).toBe(false);
    expect(fidelityJudgmentSchema.safeParse({ ...APPROVED, artefatos: ["  "] }).success).toBe(false);
    expect(fidelityJudgmentSchema.safeParse(APPROVED).success).toBe(true);
  });

  it("passa só com os quatro sim, nota no corte e nenhum defeito", () => {
    expect(passesFidelity(APPROVED)).toBe(true);
    expect(passesFidelity({ ...APPROVED, nota: FIDELITY_MIN_SCORE })).toBe(true);
    expect(passesFidelity({ ...APPROVED, nota: FIDELITY_MIN_SCORE - 1 })).toBe(false);
    expect(passesFidelity({ ...APPROVED, estampa_ok: false, nota: 10 })).toBe(false);
    expect(passesFidelity({ ...APPROVED, artefatos: ["mão com seis dedos"] })).toBe(false);
    expect(passesFidelity({ ...APPROVED, nota: 5 }, 5)).toBe(true);
  });

  it("o resumo diz a nota e o que reprovou", () => {
    expect(fidelitySummary(APPROVED)).toBe("8/10");
    expect(fidelitySummary({ ...APPROVED, cor_ok: false, estampa_ok: false, nota: 4 })).toBe("4/10 — cor, estampa");
    expect(fidelitySummary({ ...APPROVED, artefatos: ["tecido derretido"], nota: 6 })).toBe("6/10 — tecido derretido");
    expect(fidelitySummary({ ...APPROVED, nota: 6 })).toBe("6/10 — abaixo do corte");
    expect(fidelitySummary({ ...APPROVED, mesma_peca: false, nota: 2 })).toContain("outra peça");
  });

  it("há uma repetição por opção, e só uma", () => {
    expect(MAX_ATTEMPTS_PER_OPTION).toBe(2);
    expect(canRetryAttempt(0)).toBe(true);
    expect(canRetryAttempt(1)).toBe(false);
    expect(canRetryAttempt(0, 1)).toBe(false);
  });
});

describe("custo do ensaio", () => {
  it("créditos viram centavos de dólar arredondados para cima", () => {
    expect(creditsToUsdCents(1)).toBe(8);
    expect(creditsToUsdCents(2)).toBe(15);
    expect(creditsToUsdCents(3)).toBe(23);
    expect(creditsToUsdCents(0)).toBe(0);
  });

  it("a tabela por chamada segue a doc da FASHN", () => {
    expect(FASHN_CREDITS_PER_IMAGE.tryon).toEqual({ economica: 1, alta: 3 });
    expect(FASHN_CREDITS_PER_IMAGE.model_photo).toEqual({ economica: 2, alta: 4 });
    expect(creditsFor("tryon", "economica", 3)).toBe(3);
    expect(creditsFor("model_photo", "alta", 2)).toBe(8);
  });

  it("a estimativa de um pedido conta a retentativa média do portão e o julgamento", () => {
    // 3 opções × 1,2 = 3,6 → 4 imagens: 4 créditos = 30 centavos + 4 julgamentos.
    expect(estimateRequestUsdCents({ options: 3, quality: "economica" })).toEqual({
      credits: 4,
      vendorUsdCents: 30,
      judgeUsdCents: 8,
      totalUsdCents: 38,
    });
    expect(estimateRequestUsdCents({ options: 3, quality: "alta" }).credits).toBe(12);
    expect(estimateRequestUsdCents({ options: 1, quality: "economica", retryShare: 0 }).totalUsdCents).toBe(10);
    expect(usdCentsToBrlCents(38)).toBe(209);
    expect(usdCentsToBrlCents(100, 500)).toBe(500);
  });

  it("a conta da dona: por foto, por cor, por peça e por mês, em US$ e R$", () => {
    const economica = studioCostTable({ quality: "economica" });
    expect(economica.map((line) => line.usdCents)).toEqual([10, 38, 114, 4560]);
    expect(economica[3]).toEqual({ label: "1 mês, 40 peças novas", usdCents: 4560, brlCents: 25080 });
    const alta = studioCostTable({ quality: "alta", brlPerUsdCents: 500 });
    expect(alta.map((line) => line.usdCents)).toEqual([25, 98, 294, 11760]);
    expect(alta[0]?.brlCents).toBe(125);
  });
});
