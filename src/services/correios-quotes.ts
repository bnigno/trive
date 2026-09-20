// Cotação automática dos Correios (SuperFrete) para os CEPs que nenhuma
// faixa cobre: lê as configurações da dona, reaproveita as linhas gravadas
// em shipping_quotes (≤ 12 h; a regra é pickCachedQuotes, no core) ou
// pergunta ao provedor e grava um lote novo. O id de cada linha é o `rateId`
// que a sacola e a Lia carregam até o fechamento; createStoreOrder confere a
// linha por findShippingQuoteById.
//
// Nunca lança: qualquer falha (provedor fora, sem token, sem CEP de origem)
// vira a última cotação ainda válida ou, sem ela, lista vazia — e a loja
// segue exatamente como antes, Correios com o frete calculado pela equipe.
import { randomUUID } from "node:crypto";

import { and, asc, eq, gt } from "drizzle-orm";

import { CorreiosQuoteUnavailableError, isCorreiosQuotesConfigured, type CorreiosQuoter } from "@/adapters/superfrete";
import {
  applySurcharge,
  billableWeightGrams,
  CORREIOS_SERVICES,
  DEFAULT_PACKAGE_CM,
  DEFAULT_SURCHARGE_CENTS,
  pickCachedQuotes,
  quoteExpiresAt,
  quoteRequestKey,
  type CachedQuoteRow,
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
  /** Ensaio da Lia: pergunta ao provedor (e lê o cache) mas NÃO grava — os ids devolvidos são descartáveis. */
  dryRun?: boolean;
}

/**
 * PAC e SEDEX para o CEP, já com o acréscimo de embalagem, como faixas de
 * Correios que o funil de opções entende. [] quando a cotação automática
 * está desligada, mal configurada, ou o provedor falhou/não atende o trecho
 * e não há cotação anterior ainda válida.
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

  const cachedRows = await listValidQuoteRows(db, requestKey, input.now);
  const cached = pickCachedQuotes(cachedRows, input.now, CORREIOS_SERVICES);
  if (!cached.askProvider) return cached.rates;

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
    // Só o prefixo do CEP no log (a cidade, não o endereço).
    console.warn(`[correios] cotação indisponível para ${input.cep.slice(0, 5)}xxx (${why}): ${cached.rates.length > 0 ? "vale a cotação anterior" : "frete pela equipe"}.`);
    return cached.rates;
  }
  if (results.length === 0) {
    // Sem PAC nem SEDEX para o trecho (CEP inexistente, Correios sem cobertura): nada a guardar.
    console.warn(`[correios] provedor sem serviço para ${input.cep.slice(0, 5)}xxx com ${weightGrams} g: ${cached.rates.length > 0 ? "vale a cotação anterior" : "frete pela equipe"}.`);
    return cached.rates;
  }

  const batchId = randomUUID();
  const expiresAt = quoteExpiresAt(input.now);
  const values = results.map((result) => ({
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
  }));
  const inserted: CachedQuoteRow[] = input.dryRun
    ? values.map((value) => ({ ...value, id: randomUUID() }))
    : await db.insert(shippingQuotes).values(values).returning({
        id: shippingQuotes.id,
        name: shippingQuotes.name,
        priceCents: shippingQuotes.priceCents,
        deliveryDaysMin: shippingQuotes.deliveryDaysMin,
        deliveryDaysMax: shippingQuotes.deliveryDaysMax,
        createdAt: shippingQuotes.createdAt,
        expiresAt: shippingQuotes.expiresAt,
      });
  // A escolha final passa pela mesma regra: a linha antiga de um serviço continua na frente da recém-gravada.
  return pickCachedQuotes([...cachedRows, ...inserted], input.now, CORREIOS_SERVICES).rates;
}

/** Todas as linhas ainda válidas (≤ 24 h) da mesma pergunta, da mais antiga para a mais nova. */
async function listValidQuoteRows(db: ServiceDb, requestKey: string, now: Date): Promise<CachedQuoteRow[]> {
  const rows = await db
    .select({
      id: shippingQuotes.id,
      name: shippingQuotes.name,
      priceCents: shippingQuotes.priceCents,
      deliveryDaysMin: shippingQuotes.deliveryDaysMin,
      deliveryDaysMax: shippingQuotes.deliveryDaysMax,
      createdAt: shippingQuotes.createdAt,
      expiresAt: shippingQuotes.expiresAt,
    })
    .from(shippingQuotes)
    .where(and(eq(shippingQuotes.requestKey, requestKey), gt(shippingQuotes.expiresAt, now)))
    .orderBy(asc(shippingQuotes.createdAt), asc(shippingQuotes.serviceCode));
  return rows.map((row) => ({ ...row, priceCents: Number(row.priceCents) }));
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
