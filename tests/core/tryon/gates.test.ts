// "Me vê com ela" (core, puro): a checagem da foto antes de gastar e os dois
// portões depois da FASHN. A visão descreve; quem decide é o código. Os
// casos vêm da calibração de 13/10 (praia de biquíni, espelho de provador,
// piscina de canga; o decote quadrado que virou redondo).
import { describe, expect, it } from "vitest";

import {
  GARMENT_JUDGE_JSON_SCHEMA,
  GARMENT_JUDGE_SYSTEM_PROMPT,
  passesGarmentJudge,
  passesPersonJudge,
  passesTryOnVerdict,
  PERSON_JUDGE_JSON_SCHEMA,
  PERSON_JUDGE_SYSTEM_PROMPT,
  storedTryOnVerdict,
  storedVerdictApproves,
  tryOnVerdictSummary,
  type GarmentJudgment,
  type PersonJudgment,
} from "@/core/tryon/judge";
import { PHOTO_CHECK_JSON_SCHEMA, photoCheckSchema, photoCheckVerdict, type PhotoCheck } from "@/core/tryon/photo-check";

const praia: PhotoCheck = { pessoas: 1, foto_de_pessoa_real: true, adulta: true, sem_roupa: false, corpo_visivel: "ate_joelhos", parte_de_baixo: "roupa_de_banho_ou_intima" };
const espelho: PhotoCheck = { ...praia, parte_de_baixo: "roupa" };

describe("checagem da foto", () => {
  it("vestido em foto de biquíni serve; blusa sobre biquíni pede outra foto (a calcinha ficaria na prévia)", () => {
    expect(photoCheckVerdict(praia, "one-pieces")).toEqual({ ok: true });
    expect(photoCheckVerdict(praia, "tops")).toEqual({ ok: false, problem: "parte_de_baixo" });
    expect(photoCheckVerdict(espelho, "tops")).toEqual({ ok: true });
  });

  it("enquadramento: até as coxas serve para vestido; só o rosto não serve para nada", () => {
    expect(photoCheckVerdict({ ...espelho, corpo_visivel: "ate_coxas" }, "one-pieces")).toEqual({ ok: true });
    expect(photoCheckVerdict({ ...espelho, corpo_visivel: "ate_cintura" }, "one-pieces")).toEqual({ ok: false, problem: "enquadramento" });
    expect(photoCheckVerdict({ ...espelho, corpo_visivel: "ate_cintura" }, "tops")).toEqual({ ok: true });
    expect(photoCheckVerdict({ ...espelho, corpo_visivel: "so_rosto" }, "tops")).toEqual({ ok: false, problem: "enquadramento" });
  });

  it("o que nunca pode vem antes do enquadramento: não é foto, ninguém, mais de uma pessoa, menor, nudez", () => {
    expect(photoCheckVerdict({ ...espelho, foto_de_pessoa_real: false, pessoas: 0 }, "tops")).toEqual({ ok: false, problem: "nao_e_foto" });
    expect(photoCheckVerdict({ ...espelho, pessoas: 0 }, "tops")).toEqual({ ok: false, problem: "sem_pessoa" });
    expect(photoCheckVerdict({ ...espelho, pessoas: 2 }, "tops")).toEqual({ ok: false, problem: "mais_de_uma_pessoa" });
    expect(photoCheckVerdict({ ...espelho, adulta: false, corpo_visivel: "so_rosto" }, "tops")).toEqual({ ok: false, problem: "nao_pode" });
    expect(photoCheckVerdict({ ...espelho, sem_roupa: true }, "one-pieces")).toEqual({ ok: false, problem: "nao_pode" });
  });

  it("o JSON pedido e o Zod andam juntos", () => {
    expect((PHOTO_CHECK_JSON_SCHEMA as { required: string[] }).required.sort()).toEqual(Object.keys(photoCheckSchema.shape).sort());
    expect(photoCheckSchema.safeParse({ ...espelho, corpo_visivel: "meio_corpo" }).success).toBe(false);
  });
});

const peca: GarmentJudgment = {
  peca_real: "blusa amarela, decote quadrado",
  peca_na_previa: "blusa amarela, decote quadrado",
  mesma_peca: true,
  cor_ok: true,
  estampa_ok: true,
  corte_ok: true,
  artefatos: [],
  nota: 9,
};
const pessoa: PersonJudgment = { mesma_pessoa: true, diferencas_no_corpo: [], corpo_preservado: true, artefatos: [] };

describe("portões depois da FASHN", () => {
  it("passa só com a peça fiel E a pessoa preservada", () => {
    expect(passesTryOnVerdict({ garment: peca, person: pessoa })).toBe(true);
    expect(tryOnVerdictSummary({ garment: peca, person: pessoa })).toBe("9/10");
  });

  it("decote diferente reprova (o caso da Maelle no espelho)", () => {
    const decote = { ...peca, peca_na_previa: "blusa amarela, decote redondo, cropped", corte_ok: false, nota: 4 };
    expect(passesGarmentJudge(decote)).toBe(false);
    expect(tryOnVerdictSummary({ garment: decote, person: pessoa })).toBe("4/10 — corte diferente");
  });

  it("corpo afinado, pessoa trocada, defeito ou nota baixa reprovam", () => {
    const afinou = { ...pessoa, corpo_preservado: false, diferencas_no_corpo: ["cintura afinada"] };
    expect(passesPersonJudge(afinou)).toBe(false);
    // Do corpo dela, só o veredito: o log e a auditoria não guardam o que o modelo disse que mudou.
    expect(tryOnVerdictSummary({ garment: peca, person: afinou })).toBe("9/10 — corpo mudou");
    const stored = storedTryOnVerdict({ garment: { ...peca, artefatos: ["dedos a mais na mão dela"] }, person: afinou }, "job-1");
    expect(stored).toEqual({
      vendorJobId: "job-1",
      passed: false,
      summary: "9/10 — 1 defeito(s) na prévia; corpo mudou",
      garment: { mesma_peca: true, cor_ok: true, estampa_ok: true, corte_ok: true, defeitos: 1, nota: 9 },
      person: { mesma_pessoa: true, corpo_preservado: false, defeitos: 0 },
    });
    // Nenhum texto livre sobre a prévia dela fica gravado (nem do corpo, nem dos defeitos, nem a descrição da peça nela).
    expect(JSON.stringify(stored)).not.toMatch(/cintura|dedos|decote quadrado/);
    expect(storedVerdictApproves(storedTryOnVerdict({ garment: peca, person: pessoa }, "job-1"), "job-1")).toBe(true);
    expect(storedVerdictApproves(storedTryOnVerdict({ garment: peca, person: pessoa }, "job-1"), "job-2")).toBe(false);
    expect(storedVerdictApproves(stored, "job-1")).toBe(false);
    expect(storedVerdictApproves(null, "job-1")).toBe(false);
    expect(passesPersonJudge({ ...pessoa, mesma_pessoa: false })).toBe(false);
    expect(passesPersonJudge({ ...pessoa, artefatos: ["dedos a mais"] })).toBe(false);
    expect(passesGarmentJudge({ ...peca, nota: 6 })).toBe(false);
    expect(passesGarmentJudge({ ...peca, artefatos: ["tecido derretido"] })).toBe(false);
  });

  it("os prompts nunca reprovam pelo que é da foto dela (selfie, celular no rosto) e pedem a descrição antes do veredito", () => {
    for (const prompt of [GARMENT_JUDGE_SYSTEM_PROMPT, PERSON_JUDGE_SYSTEM_PROMPT]) {
      expect(prompt).toContain("selfie no espelho");
      expect(prompt).toContain("celular na frente do rosto");
      expect(prompt).not.toMatch(/Instagram|editorial|feed/);
    }
    const garmentFields = Object.keys((GARMENT_JUDGE_JSON_SCHEMA as { properties: object }).properties);
    expect(garmentFields.slice(0, 2)).toEqual(["peca_real", "peca_na_previa"]);
    expect(GARMENT_JUDGE_SYSTEM_PROMPT).toContain("decote");
    expect(Object.keys((PERSON_JUDGE_JSON_SCHEMA as { properties: object }).properties)).toContain("corpo_preservado");
  });
});
