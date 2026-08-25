// Serviço de FRETE (admin): CRUD das faixas de shipping_rates.
// A vitrine cota pelo serviço store-catalog (quoteShipping) — aqui vive só a
// gestão: listar, criar e atualizar faixas de CEP/peso com preço e prazo.
import { asc, desc, eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { z } from "zod";

import * as schema from "@/db/schema";
import { auditLog, shippingRates } from "@/db/schema";

/** Base estrutural comum ao Db de produção, transações e o TestDb (PGlite). */
export type ServiceDb = PgDatabase<PgQueryResultHKT, typeof schema>;

export class ServiceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ServiceError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Helpers internos
// ---------------------------------------------------------------------------

async function writeAudit(
  db: ServiceDb,
  entry: {
    actorId: string;
    action: string;
    entityType: string;
    entityId: string;
    before?: unknown;
    after?: unknown;
  },
): Promise<void> {
  await db.insert(auditLog).values({
    actorType: "user",
    actorId: entry.actorId,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    before: entry.before ?? null,
    after: entry.after ?? null,
    reason: null,
  });
}

/** Normaliza CEP para 8 dígitos; lança ServiceError (pt-BR) se inválido. */
function normalizeCepDigits(cep: string, label: string): string {
  const digits = cep.replace(/\D/g, "");
  if (digits.length !== 8) {
    throw new ServiceError(
      "cep_invalido",
      `${label} inválido. Informe um CEP com 8 dígitos, ex.: 01310-100.`,
    );
  }
  return digits;
}

export interface ShippingRate {
  id: string;
  name: string;
  /** 8 dígitos, sem hífen (ex.: '01000000'). */
  cepStart: string;
  cepEnd: string;
  weightMinGrams: number;
  weightMaxGrams: number;
  priceCents: number;
  deliveryDaysMin: number;
  deliveryDaysMax: number;
  isActive: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

function toShippingRate(row: typeof shippingRates.$inferSelect): ShippingRate {
  return {
    id: row.id,
    name: row.name,
    cepStart: row.cepStart,
    cepEnd: row.cepEnd,
    weightMinGrams: row.weightMinGrams,
    weightMaxGrams: row.weightMaxGrams,
    // bigint mode number já chega como number; Number() cobre o TestDb.
    priceCents: Number(row.priceCents),
    deliveryDaysMin: row.deliveryDaysMin,
    deliveryDaysMax: row.deliveryDaysMax,
    isActive: row.isActive,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Validação compartilhada (create/update)
// ---------------------------------------------------------------------------

const rateFieldsSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Informe um nome para a faixa de frete.")
    .max(120, "O nome da faixa é longo demais (máximo 120 caracteres)."),
  cepStart: z.string(),
  cepEnd: z.string(),
  weightMinGrams: z
    .number()
    .int("O peso mínimo deve ser um inteiro em gramas.")
    .min(0, "O peso mínimo não pode ser negativo."),
  weightMaxGrams: z
    .number()
    .int("O peso máximo deve ser um inteiro em gramas.")
    .min(0, "O peso máximo não pode ser negativo."),
  priceCents: z
    .number()
    .int("O preço do frete deve ser um inteiro em centavos.")
    .min(0, "O preço do frete não pode ser negativo."),
  deliveryDaysMin: z
    .number()
    .int("O prazo mínimo deve ser um número inteiro de dias.")
    .min(0, "O prazo mínimo não pode ser negativo."),
  deliveryDaysMax: z
    .number()
    .int("O prazo máximo deve ser um número inteiro de dias.")
    .min(0, "O prazo máximo não pode ser negativo."),
  userId: z.uuid(),
});

type RateFields = z.output<typeof rateFieldsSchema>;

/** Normaliza CEPs e valida coerência das faixas; lança ServiceError pt-BR. */
function normalizeRateFields(parsed: RateFields): RateFields {
  const cepStart = normalizeCepDigits(parsed.cepStart, "CEP inicial");
  const cepEnd = normalizeCepDigits(parsed.cepEnd, "CEP final");

  // Comparação de STRING funciona: ambos têm exatamente 8 dígitos.
  if (cepStart > cepEnd) {
    throw new ServiceError(
      "faixa_cep_invertida",
      "A faixa de CEP está invertida: o CEP inicial deve ser menor ou igual ao CEP final.",
    );
  }
  if (parsed.weightMinGrams > parsed.weightMaxGrams) {
    throw new ServiceError(
      "faixa_peso_invertida",
      "A faixa de peso está invertida: o peso mínimo deve ser menor ou igual ao peso máximo.",
    );
  }
  if (parsed.deliveryDaysMin > parsed.deliveryDaysMax) {
    throw new ServiceError(
      "prazo_invertido",
      "O prazo de entrega está invertido: o mínimo de dias deve ser menor ou igual ao máximo.",
    );
  }

  return { ...parsed, cepStart, cepEnd };
}

function rateAuditSnapshot(rate: ShippingRate): Record<string, unknown> {
  return {
    name: rate.name,
    cepStart: rate.cepStart,
    cepEnd: rate.cepEnd,
    weightMinGrams: rate.weightMinGrams,
    weightMaxGrams: rate.weightMaxGrams,
    priceCents: rate.priceCents,
    deliveryDaysMin: rate.deliveryDaysMin,
    deliveryDaysMax: rate.deliveryDaysMax,
    isActive: rate.isActive,
  };
}

// ---------------------------------------------------------------------------
// 1. listShippingRates
// ---------------------------------------------------------------------------

/** Todas as faixas (ativas primeiro), do frete mais barato ao mais caro. */
export async function listShippingRates(db: ServiceDb): Promise<ShippingRate[]> {
  const rows = await db
    .select()
    .from(shippingRates)
    .orderBy(
      desc(shippingRates.isActive),
      asc(shippingRates.priceCents),
      asc(shippingRates.sortOrder),
      asc(shippingRates.name),
    );
  return rows.map(toShippingRate);
}

// ---------------------------------------------------------------------------
// 2. createShippingRate
// ---------------------------------------------------------------------------

export type CreateShippingRateInput = z.input<typeof rateFieldsSchema>;

export async function createShippingRate(
  db: ServiceDb,
  input: CreateShippingRateInput,
): Promise<ShippingRate> {
  const fields = normalizeRateFields(rateFieldsSchema.parse(input));

  const created = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(shippingRates)
      .values({
        name: fields.name,
        cepStart: fields.cepStart,
        cepEnd: fields.cepEnd,
        weightMinGrams: fields.weightMinGrams,
        weightMaxGrams: fields.weightMaxGrams,
        priceCents: fields.priceCents,
        deliveryDaysMin: fields.deliveryDaysMin,
        deliveryDaysMax: fields.deliveryDaysMax,
      })
      .returning();

    const rate = toShippingRate(row);
    await writeAudit(tx, {
      actorId: fields.userId,
      action: "shipping.create",
      entityType: "shipping_rate",
      entityId: rate.id,
      before: null,
      after: rateAuditSnapshot(rate),
    });
    return rate;
  });

  return created;
}

// ---------------------------------------------------------------------------
// 3. updateShippingRate
// ---------------------------------------------------------------------------

const updateShippingRateSchema = rateFieldsSchema.extend({
  id: z.uuid(),
  isActive: z.boolean(),
});

export type UpdateShippingRateInput = z.input<typeof updateShippingRateSchema>;

export async function updateShippingRate(
  db: ServiceDb,
  input: UpdateShippingRateInput,
): Promise<ShippingRate> {
  const parsed = updateShippingRateSchema.parse(input);
  const fields = normalizeRateFields(parsed);

  const updated = await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(shippingRates)
      .where(eq(shippingRates.id, parsed.id))
      .limit(1);

    if (!current) {
      throw new ServiceError(
        "faixa_nao_encontrada",
        "Faixa de frete não encontrada. Recarregue a página e tente novamente.",
      );
    }

    const [row] = await tx
      .update(shippingRates)
      .set({
        name: fields.name,
        cepStart: fields.cepStart,
        cepEnd: fields.cepEnd,
        weightMinGrams: fields.weightMinGrams,
        weightMaxGrams: fields.weightMaxGrams,
        priceCents: fields.priceCents,
        deliveryDaysMin: fields.deliveryDaysMin,
        deliveryDaysMax: fields.deliveryDaysMax,
        isActive: parsed.isActive,
        updatedAt: new Date(),
      })
      .where(eq(shippingRates.id, parsed.id))
      .returning();

    const rate = toShippingRate(row);
    await writeAudit(tx, {
      actorId: fields.userId,
      action: "shipping.update",
      entityType: "shipping_rate",
      entityId: rate.id,
      before: rateAuditSnapshot(toShippingRate(current)),
      after: rateAuditSnapshot(rate),
    });
    return rate;
  });

  return updated;
}
