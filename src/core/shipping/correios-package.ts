// Cotação automática dos Correios (SuperFrete) — as regras PURAS: a caixa
// padrão, o peso mínimo cobrado, o acréscimo de embalagem, a chave que
// identifica uma pergunta ao provedor (cache) e as janelas de validade.
// Quem fala com o provedor e com o banco é services/correios-quotes.ts.
import type { RateForOptions } from "./delivery-windows";

export const CORREIOS_SERVICES = ["PAC", "SEDEX"] as const;
export type CorreiosServiceName = (typeof CORREIOS_SERVICES)[number];

export interface PackageDimensionsCm {
  heightCm: number;
  widthCm: number;
  lengthCm: number;
}

/**
 * A caixa padrão da TRIVÉ nos mínimos que PAC e SEDEX aceitam (16 × 4 × 24 cm):
 * peça dobrada em saco + caixa fina. O peso real do carrinho é o que muda
 * o preço; pacote maior que isso é custo da loja no balcão, nunca cobrança
 * extra à cliente.
 */
export const DEFAULT_PACKAGE_CM: PackageDimensionsCm = { heightCm: 4, widthCm: 16, lengthCm: 24 };

/** Os Correios cobram no mínimo 300 g: carrinho de 100 g paga o mesmo que um de 300 g. */
export const MIN_BILLABLE_WEIGHT_GRAMS = 300;

/** Acréscimo padrão por pedido (embalagem), em centavos: R$ 3,00. A dona ajusta em /admin/frete. */
export const DEFAULT_SURCHARGE_CENTS = 300;

/** Depois disso a cotação não fecha pedido: cote de novo. Igual ao prazo do caderninho da Lia (QUOTE_MAX_AGE_MS). */
export const QUOTE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Até esta idade a mesma pergunta reaproveita o lote gravado, e portanto os
 * MESMOS ids (a sacola guarda `?frete=<id>`; a Lia, `quoteKey`). Metade da
 * validade: todo id entregue à cliente ainda vale por ≥ 12 h.
 */
export const QUOTE_REUSE_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/** O peso que vai ao provedor, entra na chave do cache e é conferido no fechamento. */
export function billableWeightGrams(totalWeightGrams: number): number {
  const rounded = Math.round(Number.isFinite(totalWeightGrams) ? totalWeightGrams : 0);
  return Math.max(rounded, MIN_BILLABLE_WEIGHT_GRAMS);
}

/** Preço do provedor + embalagem, em centavos inteiros (regra 2 de ouro: nunca float). */
export function applySurcharge(providerPriceCents: number, surchargeCents: number): number {
  if (!Number.isInteger(providerPriceCents) || providerPriceCents < 0) {
    throw new RangeError(`providerPriceCents inválido: ${providerPriceCents}`);
  }
  if (!Number.isInteger(surchargeCents) || surchargeCents < 0) {
    throw new RangeError(`surchargeCents inválido: ${surchargeCents}`);
  }
  return providerPriceCents + surchargeCents;
}

export interface QuoteRequestKeyInput {
  cepFrom: string;
  cepTo: string;
  billableWeightGrams: number;
  package: PackageDimensionsCm;
  surchargeCents: number;
  services: readonly CorreiosServiceName[];
}

/**
 * A identidade de uma pergunta ao provedor: mesma chave = mesma resposta
 * esperada, então o lote gravado serve. O acréscimo entra na chave de
 * propósito — quando a dona muda a embalagem, o cache antigo deixa de valer
 * na hora, sem limpar nada.
 */
export function quoteRequestKey(input: QuoteRequestKeyInput): string {
  const from = input.cepFrom.replace(/\D/g, "");
  const to = input.cepTo.replace(/\D/g, "");
  const { heightCm, widthCm, lengthCm } = input.package;
  const services = [...input.services].sort().join(",");
  return `superfrete|${from}|${to}|${input.billableWeightGrams}|${heightCm}x${widthCm}x${lengthCm}|s${input.surchargeCents}|${services}`;
}

export function quoteExpiresAt(createdAt: Date): Date {
  return new Date(createdAt.getTime() + QUOTE_TTL_MS);
}

/** O lote gravado em `createdAt` ainda pode ser reaproveitado em `now`? */
export function isQuoteReusable(createdAt: Date, now: Date): boolean {
  const age = now.getTime() - createdAt.getTime();
  return age >= 0 && age <= QUOTE_REUSE_MAX_AGE_MS && quoteExpiresAt(createdAt).getTime() > now.getTime();
}

/** A cotação ainda fecha pedido em `now`? */
export function isQuoteValid(expiresAt: Date, now: Date): boolean {
  return expiresAt.getTime() > now.getTime();
}

export interface StoredQuoteRow {
  id: string;
  name: string;
  priceCents: number;
  deliveryDaysMin: number;
  deliveryDaysMax: number;
}

/** A linha de shipping_quotes na forma que o funil de opções já entende (uma faixa de Correios). */
export function quoteRowToRate(row: StoredQuoteRow): RateForOptions {
  return {
    rateId: row.id,
    name: row.name,
    priceCents: Number(row.priceCents),
    deliveryDaysMin: Number(row.deliveryDaysMin),
    deliveryDaysMax: Number(row.deliveryDaysMax),
    kind: "correios",
    deliveryWindows: [],
  };
}
