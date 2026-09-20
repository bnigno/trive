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
  QUOTE_REUSE_MAX_AGE_MS,
  QUOTE_TTL_MS,
  quoteExpiresAt,
  quoteRequestKey,
  quoteRowToRate,
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
});
