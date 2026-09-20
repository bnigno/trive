// Regras puras da cotação automática dos Correios: peso mínimo cobrado,
// acréscimo inteiro, chave do cache determinística (e sensível ao acréscimo),
// janelas de reuso/validade e a linha gravada como faixa de Correios.
import { describe, expect, it } from "vitest";

import {
  applySurcharge,
  billableWeightGrams,
  CORREIOS_SERVICES,
  DEFAULT_PACKAGE_CM,
  DEFAULT_SURCHARGE_CENTS,
  isQuoteReusable,
  isQuoteValid,
  MIN_BILLABLE_WEIGHT_GRAMS,
  PARTIAL_QUOTE_RETRY_MS,
  pickCachedQuotes,
  QUOTE_REUSE_MAX_AGE_MS,
  QUOTE_TTL_MS,
  quoteExpiresAt,
  quoteRequestKey,
  quoteRowToRate,
  type CachedQuoteRow,
} from "@/core/shipping/correios-package";

const KEY_INPUT = {
  cepFrom: "66045-335",
  cepTo: "01310100",
  billableWeightGrams: 300,
  package: DEFAULT_PACKAGE_CM,
  surchargeCents: 300,
  services: CORREIOS_SERVICES,
};

describe("correios-package (core)", () => {
  it("constantes: caixa 16×4×24 (mínimos PAC/SEDEX), 300 g, R$ 3,00, 24 h de validade e 12 h de reuso", () => {
    expect(DEFAULT_PACKAGE_CM).toEqual({ heightCm: 4, widthCm: 16, lengthCm: 24 });
    expect(MIN_BILLABLE_WEIGHT_GRAMS).toBe(300);
    expect(DEFAULT_SURCHARGE_CENTS).toBe(300);
    expect(QUOTE_TTL_MS).toBe(24 * 60 * 60 * 1000);
    expect(QUOTE_REUSE_MAX_AGE_MS).toBe(12 * 60 * 60 * 1000);
    expect(CORREIOS_SERVICES).toEqual(["PAC", "SEDEX"]);
  });

  it("billableWeightGrams: abaixo de 300 g cobra 300; acima cobra o peso arredondado; lixo vira 300", () => {
    expect(billableWeightGrams(0)).toBe(300);
    expect(billableWeightGrams(100)).toBe(300);
    expect(billableWeightGrams(300)).toBe(300);
    expect(billableWeightGrams(301)).toBe(301);
    expect(billableWeightGrams(1600.4)).toBe(1600);
    expect(billableWeightGrams(Number.NaN)).toBe(300);
    expect(billableWeightGrams(-5)).toBe(300);
  });

  it("applySurcharge soma inteiros em centavos e recusa float ou negativo", () => {
    expect(applySurcharge(2290, 300)).toBe(2590);
    expect(applySurcharge(2290, 0)).toBe(2290);
    expect(() => applySurcharge(22.9, 300)).toThrow(RangeError);
    expect(() => applySurcharge(2290, -1)).toThrow(RangeError);
    expect(() => applySurcharge(-1, 300)).toThrow(RangeError);
  });

  it("quoteRequestKey é determinística, ignora máscara do CEP, ordena os serviços e muda com peso, caixa e acréscimo", () => {
    const key = quoteRequestKey(KEY_INPUT);
    expect(key).toBe("superfrete|66045335|01310100|300|4x16x24|s300|PAC,SEDEX");
    expect(quoteRequestKey({ ...KEY_INPUT, cepFrom: "66045335", services: ["SEDEX", "PAC"] })).toBe(key);
    expect(quoteRequestKey({ ...KEY_INPUT, billableWeightGrams: 600 })).not.toBe(key);
    expect(quoteRequestKey({ ...KEY_INPUT, surchargeCents: 500 })).not.toBe(key);
    expect(quoteRequestKey({ ...KEY_INPUT, package: { heightCm: 8, widthCm: 16, lengthCm: 24 } })).not.toBe(key);
    expect(quoteRequestKey({ ...KEY_INPUT, cepTo: "01310101" })).not.toBe(key);
    expect(quoteRequestKey({ ...KEY_INPUT, services: ["PAC"] })).not.toBe(key);
  });

  it("validade e reuso nas bordas: reusa até 12 h (inclusive), vale até 24 h (exclusivo), nunca antes de criada", () => {
    const createdAt = new Date("2026-09-19T12:00:00Z");
    expect(quoteExpiresAt(createdAt).toISOString()).toBe("2026-09-20T12:00:00.000Z");

    expect(isQuoteReusable(createdAt, createdAt)).toBe(true);
    expect(isQuoteReusable(createdAt, new Date("2026-09-20T00:00:00Z"))).toBe(true);
    expect(isQuoteReusable(createdAt, new Date("2026-09-20T00:00:00.001Z"))).toBe(false);
    expect(isQuoteReusable(createdAt, new Date("2026-09-19T11:59:59Z"))).toBe(false);

    const expiresAt = quoteExpiresAt(createdAt);
    expect(isQuoteValid(expiresAt, new Date("2026-09-20T11:59:59.999Z"))).toBe(true);
    expect(isQuoteValid(expiresAt, expiresAt)).toBe(false);
    expect(isQuoteValid(expiresAt, new Date("2026-09-21T00:00:00Z"))).toBe(false);
  });

  it("quoteRowToRate: a linha vira faixa de Correios sem janelas, com o id como rateId e números normalizados", () => {
    expect(quoteRowToRate({ id: "q-1", name: "PAC", priceCents: 2590 as unknown as number, deliveryDaysMin: 6, deliveryDaysMax: 9 })).toEqual({
      rateId: "q-1",
      name: "PAC",
      priceCents: 2590,
      deliveryDaysMin: 6,
      deliveryDaysMax: 9,
      kind: "correios",
      deliveryWindows: [],
    });
  });

  describe("pickCachedQuotes (a regra do cache)", () => {
    const NOW = new Date("2026-09-19T15:00:00Z");
    const H = 3600_000;
    function row(over: Partial<CachedQuoteRow> & { name: string; ageMs: number; id: string }): CachedQuoteRow {
      const createdAt = new Date(NOW.getTime() - over.ageMs);
      return {
        priceCents: over.name === "PAC" ? 2590 : 4290,
        deliveryDaysMin: over.name === "PAC" ? 6 : 2,
        deliveryDaysMax: over.name === "PAC" ? 9 : 3,
        createdAt,
        expiresAt: quoteExpiresAt(createdAt),
        ...over,
      };
    }

    it("sem nada: pergunta ao provedor, sem plano B", () => {
      expect(pickCachedQuotes([], NOW, CORREIOS_SERVICES)).toEqual({ rates: [], askProvider: true, fallbackRates: [] });
    });

    it("lote completo recente: devolve as duas linhas por preço e não pergunta", () => {
      const pick = pickCachedQuotes([row({ id: "s1", name: "SEDEX", ageMs: H }), row({ id: "p1", name: "PAC", ageMs: H })], NOW, CORREIOS_SERVICES);
      expect(pick.askProvider).toBe(false);
      expect(pick.rates.map((r) => [r.rateId, r.name, r.kind])).toEqual([["p1", "PAC", "correios"], ["s1", "SEDEX", "correios"]]);
      expect(pick.fallbackRates.map((r) => r.rateId)).toEqual(["p1", "s1"]);
    });

    it("dois lotes reaproveitáveis da mesma chave: por serviço vence a linha MAIS ANTIGA (o id da cliente não muda)", () => {
      const pick = pickCachedQuotes(
        [row({ id: "p2", name: "PAC", ageMs: 1_000 }), row({ id: "s2", name: "SEDEX", ageMs: 1_000 }), row({ id: "p1", name: "PAC", ageMs: 2 * H }), row({ id: "s1", name: "SEDEX", ageMs: 2 * H })],
        NOW,
        CORREIOS_SERVICES,
      );
      expect(pick.rates.map((r) => r.rateId)).toEqual(["p1", "s1"]);
      expect(pick.askProvider).toBe(false);
    });

    it("lote parcial (só PAC): dentro da carência devolve só o PAC sem perguntar; depois da carência pergunta e o PAC antigo continua na frente", () => {
      const recent = pickCachedQuotes([row({ id: "p1", name: "PAC", ageMs: PARTIAL_QUOTE_RETRY_MS })], NOW, CORREIOS_SERVICES);
      expect(recent).toMatchObject({ askProvider: false });
      expect(recent.rates.map((r) => r.rateId)).toEqual(["p1"]);

      const later = pickCachedQuotes([row({ id: "p1", name: "PAC", ageMs: PARTIAL_QUOTE_RETRY_MS + 1 })], NOW, CORREIOS_SERVICES);
      expect(later.askProvider).toBe(true);
      expect(later.rates.map((r) => r.rateId)).toEqual(["p1"]);
      expect(later.fallbackRates.map((r) => r.rateId)).toEqual(["p1"]);

      // O provedor respondeu com os dois: o PAC antigo segue com o mesmo id; o SEDEX é o novo.
      const merged = pickCachedQuotes([row({ id: "p1", name: "PAC", ageMs: 2 * H }), row({ id: "p2", name: "PAC", ageMs: 0 }), row({ id: "s2", name: "SEDEX", ageMs: 0 })], NOW, CORREIOS_SERVICES);
      expect(merged.rates.map((r) => r.rateId)).toEqual(["p1", "s2"]);
      expect(merged.askProvider).toBe(false);
    });

    it("entre 12 h e 24 h: pergunta ao provedor, mas o plano B é a linha mais recente ainda válida (o id que a cliente carrega fecha pedido)", () => {
      const pick = pickCachedQuotes(
        [row({ id: "p0", name: "PAC", ageMs: 20 * H }), row({ id: "p1", name: "PAC", ageMs: 13 * H }), row({ id: "s1", name: "SEDEX", ageMs: 13 * H })],
        NOW,
        CORREIOS_SERVICES,
      );
      expect(pick.askProvider).toBe(true);
      expect(pick.rates).toEqual([]);
      expect(pick.fallbackRates.map((r) => r.rateId)).toEqual(["p1", "s1"]);
    });

    it("linha vencida não conta nem como plano B; exatamente 12 h ainda reaproveita", () => {
      const expired = row({ id: "p0", name: "PAC", ageMs: 25 * H });
      expect(pickCachedQuotes([expired], NOW, CORREIOS_SERVICES)).toEqual({ rates: [], askProvider: true, fallbackRates: [] });
      const edge = pickCachedQuotes([row({ id: "p1", name: "PAC", ageMs: QUOTE_REUSE_MAX_AGE_MS }), row({ id: "s1", name: "SEDEX", ageMs: QUOTE_REUSE_MAX_AGE_MS })], NOW, CORREIOS_SERVICES);
      expect(edge.askProvider).toBe(false);
      expect(edge.rates.map((r) => r.rateId)).toEqual(["p1", "s1"]);
    });

    it("só o serviço pedido conta", () => {
      const pick = pickCachedQuotes([row({ id: "p1", name: "PAC", ageMs: H }), row({ id: "s1", name: "SEDEX", ageMs: H })], NOW, ["SEDEX"]);
      expect(pick.rates.map((r) => r.rateId)).toEqual(["s1"]);
      expect(pick.askProvider).toBe(false);
    });
  });
});
