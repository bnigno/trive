// Cotação automática dos Correios (SuperFrete) para os CEPs que nenhuma
// faixa cobre: lê as configurações da dona, reaproveita o lote gravado em
// shipping_quotes (≤ 12 h) ou pergunta ao provedor e grava um lote novo. O
// id de cada linha é o `rateId` que a sacola e a Lia carregam até o
// fechamento; createStoreOrder confere a linha por findShippingQuoteById.
//
// Nunca lança: qualquer falha (provedor fora, sem token, sem CEP de origem)
// vira lista vazia e a loja segue exatamente como antes — Correios com o
// frete calculado pela equipe.
import { randomUUID } from "node:crypto";

import { and, desc, eq, gt } from "drizzle-orm";

import { CorreiosQuoteUnavailableError, isCorreiosQuotesConfigured, type CorreiosQuoter } from "@/adapters/superfrete";
import {
  applySurcharge,
  billableWeightGrams,
  CORREIOS_SERVICES,
  DEFAULT_PACKAGE_CM,
  DEFAULT_SURCHARGE_CENTS,
  QUOTE_REUSE_MAX_AGE_MS,
  quoteExpiresAt,
  quoteRequestKey,
  quoteRowToRate,
} from "@/core/shipping/correios-package";
import type { RateForOptions } from "@/core/shipping/delivery-windows";
import { shippingQuotes } from "@/db/schema";
import { cepDigits } from "@/lib/cep";
import { getSettingsMap, type ServiceDb } from "@/services/settings";

export const CORREIOS_AUTO_SETTING_KEYS = ["correios_auto_enabled", "store_cep", "correios_surcharge_cents"] as const;

export interface CorreiosAutoSettings {
  /** O interruptor de /admin/frete. */
  enabled: boolean;
  /** CEP de origem das postagens (8 dígitos); null = não preenchido (a cotação não roda). */
  storeCep: string | null;
  /** Acréscimo de embalagem por pedido, em centavos. */
  surchargeCents: number;
}

/** As três configurações com padrões seguros (desligado, sem CEP, R$ 3,00). */
export async function getCorreiosAutoSettings(db: ServiceDb): Promise<CorreiosAutoSettings> {
  const map = await getSettingsMap(db, [...CORREIOS_AUTO_SETTING_KEYS]);
  const surcharge = map.correios_surcharge_cents;
  // Número também: um jsonb "66045335" gravado sem hífen volta como 66045335.
  const storeCep = map.store_cep;
  return {
    enabled: map.correios_auto_enabled === true,
    storeCep: typeof storeCep === "string" || typeof storeCep === "number" ? cepDigits(String(storeCep)) : null,
    surchargeCents: typeof surcharge === "number" && Number.isInteger(surcharge) && surcharge >= 0 ? surcharge : DEFAULT_SURCHARGE_CENTS,
  };
}

export interface QuoteCorreiosInput {
  /** 8 dígitos (o chamador já normalizou). */
  cep: string;
  totalWeightGrams: number;
  now: Date;
}

/**
 * PAC e SEDEX para o CEP, já com o acréscimo de embalagem, como faixas de
 * Correios que o funil de opções entende. [] quando a cotação automática
 * está desligada, mal configurada, o provedor falhou ou não atende o trecho.
 */
export async function quoteCorreiosOptions(
  db: ServiceDb,
  quoter: CorreiosQuoter,
  input: QuoteCorreiosInput,
): Promise<RateForOptions[]> {
  const settings = await getCorreiosAutoSettings(db);
  if (!settings.enabled) return [];
  if (!settings.storeCep) {
    console.warn("[correios] cotação automática ligada sem CEP de origem (store_cep): frete pela equipe.");
    return [];
  }
  if (!isCorreiosQuotesConfigured()) return [];

  const weightGrams = billableWeightGrams(input.totalWeightGrams);
  const requestKey = quoteRequestKey({
    cepFrom: settings.storeCep,
    cepTo: input.cep,
    billableWeightGrams: weightGrams,
    package: DEFAULT_PACKAGE_CM,
    surchargeCents: settings.surchargeCents,
    services: CORREIOS_SERVICES,
  });

  const cached = await findReusableBatch(db, requestKey, input.now);
  if (cached.length > 0) return cached;

  let results;
  try {
    results = await quoter.quote({
      fromCep: settings.storeCep,
      toCep: input.cep,
      weightGrams,
      package: DEFAULT_PACKAGE_CM,
      services: CORREIOS_SERVICES,
    });
  } catch (error) {
    const why = error instanceof CorreiosQuoteUnavailableError ? error.reason : error instanceof Error ? error.message : String(error);
    console.warn(`[correios] cotação indisponível para ${input.cep} (${why}): frete pela equipe.`);
    return [];
  }
  if (results.length === 0) return [];

  const batchId = randomUUID();
  const expiresAt = quoteExpiresAt(input.now);
  const rows = await db
    .insert(shippingQuotes)
    .values(
      results.map((result) => ({
        provider: "superfrete",
        requestKey,
        batchId,
        serviceCode: result.serviceCode,
        name: result.service,
        cepFrom: settings.storeCep!,
        cepTo: input.cep,
        weightGrams,
        package: { ...DEFAULT_PACKAGE_CM },
        providerPriceCents: result.priceCents,
        surchargeCents: settings.surchargeCents,
        priceCents: applySurcharge(result.priceCents, settings.surchargeCents),
        deliveryDaysMin: result.deliveryDaysMin,
        deliveryDaysMax: result.deliveryDaysMax,
        raw: result.raw ?? null,
        createdAt: input.now,
        expiresAt,
      })),
    )
    .returning({
      id: shippingQuotes.id,
      name: shippingQuotes.name,
      priceCents: shippingQuotes.priceCents,
      deliveryDaysMin: shippingQuotes.deliveryDaysMin,
      deliveryDaysMax: shippingQuotes.deliveryDaysMax,
    });
  return rows.map(quoteRowToRate).sort((a, b) => a.priceCents - b.priceCents);
}

/** O lote mais recente da mesma pergunta, se ainda é reaproveitável (≤ 12 h e não vencido). */
async function findReusableBatch(db: ServiceDb, requestKey: string, now: Date): Promise<RateForOptions[]> {
  const since = new Date(now.getTime() - QUOTE_REUSE_MAX_AGE_MS);
  const rows = await db
    .select({
      id: shippingQuotes.id,
      batchId: shippingQuotes.batchId,
      name: shippingQuotes.name,
      priceCents: shippingQuotes.priceCents,
      deliveryDaysMin: shippingQuotes.deliveryDaysMin,
      deliveryDaysMax: shippingQuotes.deliveryDaysMax,
    })
    .from(shippingQuotes)
    .where(and(eq(shippingQuotes.requestKey, requestKey), gt(shippingQuotes.createdAt, since), gt(shippingQuotes.expiresAt, now)))
    .orderBy(desc(shippingQuotes.createdAt), shippingQuotes.serviceCode);
  if (rows.length === 0) return [];
  const latestBatch = rows[0].batchId;
  return rows
    .filter((row) => row.batchId === latestBatch)
    .map(quoteRowToRate)
    .sort((a, b) => a.priceCents - b.priceCents);
}

export interface ResolvedShippingQuote {
  id: string;
  /** "PAC" / "SEDEX". */
  name: string;
  priceCents: number;
  deliveryDaysMax: number;
  cepTo: string;
  /** Peso cobrado na cotação (o fechamento confere com o da sacola de agora). */
  weightGrams: number;
  expiresAt: Date;
}

/** A cotação automática pelo id que a sacola/Lia mandou; null quando não é uma cotação. */
export async function findShippingQuoteById(db: ServiceDb, id: string): Promise<ResolvedShippingQuote | null> {
  const [row] = await db
    .select({
      id: shippingQuotes.id,
      name: shippingQuotes.name,
      priceCents: shippingQuotes.priceCents,
      deliveryDaysMax: shippingQuotes.deliveryDaysMax,
      cepTo: shippingQuotes.cepTo,
      weightGrams: shippingQuotes.weightGrams,
      expiresAt: shippingQuotes.expiresAt,
    })
    .from(shippingQuotes)
    .where(eq(shippingQuotes.id, id))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    priceCents: Number(row.priceCents),
    deliveryDaysMax: Number(row.deliveryDaysMax),
    cepTo: row.cepTo,
    weightGrams: Number(row.weightGrams),
    expiresAt: row.expiresAt,
  };
}
