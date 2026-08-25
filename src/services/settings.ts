// Serviço de CONFIGURAÇÕES: taxas de pagamento (vigências), política padrão
// de precificação e chaves de settings permitidas. Taxas NUNCA são editadas:
// encerra-se a vigência atual e cria-se uma nova linha (histórico completo).
import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { z } from "zod";

import * as schema from "@/db/schema";
import { auditLog, paymentFeeRules, pricingPolicies, settings } from "@/db/schema";
import { toE164BR } from "@/lib/phone";

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
    reason?: string | null;
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
    reason: entry.reason ?? null,
  });
}

export const PAYMENT_METHODS = ["pix", "credit_card", "boleto"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

const ROUNDING_MODES = ["none", "to_90", "to_99", "to_50", "integer"] as const;
const ROUNDING_DIRECTIONS = ["up", "nearest"] as const;

// ---------------------------------------------------------------------------
// 1. Taxas de pagamento (payment_fee_rules)
// ---------------------------------------------------------------------------

export interface FeeRule {
  id: string;
  paymentMethod: PaymentMethod;
  installmentsMax: number;
  /** Fração: 0.0498 = 4,98%. */
  percentRate: number;
  fixedFeeCents: number;
  settlementDays: number;
  isReferenceForPricing: boolean;
  effectiveFrom: Date;
  effectiveTo: Date | null;
}

function toFeeRule(row: typeof paymentFeeRules.$inferSelect): FeeRule {
  return {
    id: row.id,
    paymentMethod: row.paymentMethod as PaymentMethod,
    installmentsMax: row.installmentsMax,
    // numeric(7,4) chega como string do driver — converter é obrigatório.
    percentRate: Number(row.percentRate),
    fixedFeeCents: row.fixedFeeCents,
    settlementDays: row.settlementDays,
    isReferenceForPricing: row.isReferenceForPricing,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
  };
}

/** Regras vigentes (effective_to IS NULL) + histórico (vigências encerradas). */
export async function getFeeRules(
  db: ServiceDb,
): Promise<{ current: FeeRule[]; history: FeeRule[] }> {
  const [currentRows, historyRows] = await Promise.all([
    db
      .select()
      .from(paymentFeeRules)
      .where(isNull(paymentFeeRules.effectiveTo))
      .orderBy(paymentFeeRules.paymentMethod, desc(paymentFeeRules.effectiveFrom)),
    db
      .select()
      .from(paymentFeeRules)
      .where(isNotNull(paymentFeeRules.effectiveTo))
      .orderBy(desc(paymentFeeRules.effectiveTo)),
  ]);
  return {
    current: currentRows.map(toFeeRule),
    history: historyRows.map(toFeeRule),
  };
}

const replaceFeeRuleSchema = z.object({
  paymentMethod: z.enum(PAYMENT_METHODS),
  /** Fração entre 0 e 1 (ex.: 4,98% = 0.0498). */
  percentRate: z
    .number()
    .min(0, "A taxa percentual não pode ser negativa.")
    .lt(1, "A taxa percentual deve ser menor que 100%."),
  fixedFeeCents: z.number().int().min(0, "A tarifa fixa não pode ser negativa."),
  settlementDays: z
    .number()
    .int()
    .min(0, "O prazo de repasse não pode ser negativo."),
  installmentsMax: z.number().int().min(1).optional(),
  isReferenceForPricing: z.boolean().optional(),
  userId: z.uuid(),
});

export type ReplaceFeeRuleInput = z.input<typeof replaceFeeRuleSchema>;

/**
 * Substitui a taxa vigente do método: encerra a vigência atual
 * (effective_to = now) e cria uma nova linha. Se `isReferenceForPricing`
 * for omitido, a nova regra herda a marcação da regra substituída — assim
 * trocar a taxa do método de referência mantém a referência.
 */
export async function replaceFeeRule(
  db: ServiceDb,
  input: ReplaceFeeRuleInput,
): Promise<FeeRule> {
  const parsed = replaceFeeRuleSchema.parse(input);

  const created = await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(paymentFeeRules)
      .where(
        and(
          eq(paymentFeeRules.paymentMethod, parsed.paymentMethod),
          isNull(paymentFeeRules.effectiveTo),
        ),
      )
      .orderBy(desc(paymentFeeRules.effectiveFrom))
      .limit(1);

    const now = new Date();

    if (current) {
      await tx
        .update(paymentFeeRules)
        .set({ effectiveTo: now })
        .where(eq(paymentFeeRules.id, current.id));
    }

    const isReference =
      parsed.isReferenceForPricing ?? current?.isReferenceForPricing ?? false;

    if (isReference) {
      // Só pode existir UMA regra vigente marcada como referência.
      await tx
        .update(paymentFeeRules)
        .set({ isReferenceForPricing: false })
        .where(
          and(
            eq(paymentFeeRules.isReferenceForPricing, true),
            isNull(paymentFeeRules.effectiveTo),
          ),
        );
    }

    const [row] = await tx
      .insert(paymentFeeRules)
      .values({
        paymentMethod: parsed.paymentMethod,
        installmentsMax: parsed.installmentsMax ?? current?.installmentsMax ?? 1,
        // numeric(7,4) em modo string: gravar com exatamente 4 casas.
        percentRate: parsed.percentRate.toFixed(4),
        fixedFeeCents: parsed.fixedFeeCents,
        settlementDays: parsed.settlementDays,
        isReferenceForPricing: isReference,
        effectiveFrom: now,
      })
      .returning();

    await writeAudit(tx, {
      actorId: parsed.userId,
      action: "feerule.replace",
      entityType: "payment_fee_rule",
      entityId: row.id,
      before: current
        ? {
            feeRuleId: current.id,
            percentRate: Number(current.percentRate),
            fixedFeeCents: current.fixedFeeCents,
            settlementDays: current.settlementDays,
            isReferenceForPricing: current.isReferenceForPricing,
          }
        : null,
      after: {
        paymentMethod: parsed.paymentMethod,
        percentRate: parsed.percentRate,
        fixedFeeCents: parsed.fixedFeeCents,
        settlementDays: parsed.settlementDays,
        installmentsMax: parsed.installmentsMax ?? current?.installmentsMax ?? 1,
        isReferenceForPricing: isReference,
      },
    });

    return row;
  });

  return toFeeRule(created);
}

// ---------------------------------------------------------------------------
// 2. Política padrão de precificação (pricing_policies, escopo global)
// ---------------------------------------------------------------------------

export interface DefaultPolicy {
  id: string;
  name: string;
  /** Fração: 0.3 = 30%. */
  targetMarginRate: number;
  minMarginRate: number;
  otherCostsFixedCents: number;
  otherCostsRate: number;
  roundingMode: (typeof ROUNDING_MODES)[number];
  roundingDirection: (typeof ROUNDING_DIRECTIONS)[number];
  updatedAt: Date;
}

function toDefaultPolicy(row: typeof pricingPolicies.$inferSelect): DefaultPolicy {
  return {
    id: row.id,
    name: row.name,
    targetMarginRate: Number(row.targetMarginRate),
    minMarginRate: Number(row.minMarginRate),
    otherCostsFixedCents: row.otherCostsFixedCents,
    otherCostsRate: Number(row.otherCostsRate),
    roundingMode: z.enum(ROUNDING_MODES).parse(row.roundingMode),
    roundingDirection: z.enum(ROUNDING_DIRECTIONS).parse(row.roundingDirection),
    updatedAt: row.updatedAt,
  };
}

/** Política global ativa mais recente (a "política padrão" da loja). */
export async function getDefaultPolicy(
  db: ServiceDb,
): Promise<DefaultPolicy | null> {
  const [row] = await db
    .select()
    .from(pricingPolicies)
    .where(
      and(
        eq(pricingPolicies.scopeType, "global"),
        eq(pricingPolicies.isActive, true),
      ),
    )
    .orderBy(desc(pricingPolicies.updatedAt))
    .limit(1);
  return row ? toDefaultPolicy(row) : null;
}

const updateDefaultPolicySchema = z
  .object({
    /** Fração entre 0 e 1 (ex.: 30% = 0.3). */
    targetMarginRate: z
      .number()
      .min(0, "A margem alvo não pode ser negativa.")
      .lt(1, "A margem alvo deve ser menor que 100%."),
    minMarginRate: z
      .number()
      .min(0, "A margem mínima não pode ser negativa.")
      .lt(1, "A margem mínima deve ser menor que 100%."),
    roundingMode: z.enum(ROUNDING_MODES),
    roundingDirection: z.enum(ROUNDING_DIRECTIONS),
    otherCostsFixedCents: z
      .number()
      .int()
      .min(0, "Os custos fixos não podem ser negativos."),
    userId: z.uuid(),
  })
  .refine((value) => value.minMarginRate <= value.targetMarginRate, {
    message: "A margem mínima não pode ser maior que a margem alvo.",
  });

export type UpdateDefaultPolicyInput = z.input<typeof updateDefaultPolicySchema>;

/** Atualiza (ou cria, se não existir) a política global padrão. */
export async function updateDefaultPolicy(
  db: ServiceDb,
  input: UpdateDefaultPolicyInput,
): Promise<DefaultPolicy> {
  const parsed = updateDefaultPolicySchema.parse(input);

  const saved = await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(pricingPolicies)
      .where(
        and(
          eq(pricingPolicies.scopeType, "global"),
          eq(pricingPolicies.isActive, true),
        ),
      )
      .orderBy(desc(pricingPolicies.updatedAt))
      .limit(1);

    const values = {
      targetMarginRate: parsed.targetMarginRate.toFixed(4),
      minMarginRate: parsed.minMarginRate.toFixed(4),
      roundingMode: parsed.roundingMode,
      roundingDirection: parsed.roundingDirection,
      otherCostsFixedCents: parsed.otherCostsFixedCents,
      updatedAt: new Date(),
    };

    let row: typeof pricingPolicies.$inferSelect;
    if (current) {
      [row] = await tx
        .update(pricingPolicies)
        .set(values)
        .where(eq(pricingPolicies.id, current.id))
        .returning();
    } else {
      [row] = await tx
        .insert(pricingPolicies)
        .values({ name: "Política padrão", scopeType: "global", ...values })
        .returning();
    }

    await writeAudit(tx, {
      actorId: parsed.userId,
      action: "pricing_policy.update",
      entityType: "pricing_policy",
      entityId: row.id,
      before: current
        ? {
            targetMarginRate: Number(current.targetMarginRate),
            minMarginRate: Number(current.minMarginRate),
            roundingMode: current.roundingMode,
            roundingDirection: current.roundingDirection,
            otherCostsFixedCents: current.otherCostsFixedCents,
          }
        : null,
      after: {
        targetMarginRate: parsed.targetMarginRate,
        minMarginRate: parsed.minMarginRate,
        roundingMode: parsed.roundingMode,
        roundingDirection: parsed.roundingDirection,
        otherCostsFixedCents: parsed.otherCostsFixedCents,
      },
    });

    return row;
  });

  return toDefaultPolicy(saved);
}

// ---------------------------------------------------------------------------
// 3. Settings (chaves permitidas)
// ---------------------------------------------------------------------------

const SETTING_VALUE_SCHEMAS: Record<string, z.ZodType> = {
  /** Fração: 0.1 = 10% de variação máxima sem aprovação. */
  price_change_pct_threshold: z
    .number()
    .min(0, "O limite de variação não pode ser negativo.")
    .max(1, "O limite de variação deve ser no máximo 100%."),
  first_price_requires_approval: z.boolean(),
  default_low_stock_threshold: z
    .number()
    .int()
    .min(0, "O limiar de estoque baixo não pode ser negativo."),
  stock_reservation_ttl_minutes: z
    .number()
    .int()
    .positive("O tempo de reserva deve ser maior que zero."),
  // --- Dados da loja (rodapé e páginas legais — Decreto 7.962/2013) ---
  store_name: z.string().trim().max(120, "O nome da loja é longo demais."),
  store_cnpj: z.string().trim().max(20, "CNPJ longo demais."),
  store_address: z.string().trim().max(300, "O endereço é longo demais."),
  store_email: z
    .string()
    .trim()
    .max(200, "O e-mail é longo demais.")
    .refine(
      (value) => value === "" || z.email().safeParse(value).success,
      "E-mail inválido.",
    ),
  store_whatsapp: z
    .string()
    .trim()
    .transform((value, ctx) => {
      if (value === "") return "";
      const e164 = toE164BR(value);
      if (!e164) {
        ctx.addIssue({
          code: "custom",
          message:
            "WhatsApp inválido. Informe DDD + número, ex.: (11) 99999-8888.",
        });
        return z.NEVER;
      }
      return e164;
    }),
};

export const ALLOWED_SETTING_KEYS = Object.keys(SETTING_VALUE_SCHEMAS);

export async function getSettingsMap(
  db: ServiceDb,
  keys: string[],
): Promise<Record<string, unknown>> {
  if (keys.length === 0) return {};
  const rows = await db
    .select()
    .from(settings)
    .where(inArray(settings.key, keys));
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

const updateSettingSchema = z.object({
  key: z.string().min(1),
  value: z.unknown(),
  userId: z.uuid(),
});

export type UpdateSettingInput = z.input<typeof updateSettingSchema>;

export async function updateSetting(
  db: ServiceDb,
  input: UpdateSettingInput,
): Promise<{ key: string; value: unknown }> {
  const parsed = updateSettingSchema.parse(input);

  const valueSchema = SETTING_VALUE_SCHEMAS[parsed.key];
  if (!valueSchema) {
    throw new ServiceError(
      "setting_desconhecida",
      `Configuração desconhecida: "${parsed.key}". Esta chave não pode ser alterada por aqui.`,
    );
  }

  const valueResult = valueSchema.safeParse(parsed.value);
  if (!valueResult.success) {
    throw new ServiceError(
      "valor_invalido",
      valueResult.error.issues[0]?.message ??
        `Valor inválido para a configuração "${parsed.key}".`,
    );
  }
  const value = valueResult.data;

  await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(settings)
      .where(eq(settings.key, parsed.key))
      .limit(1);

    await tx
      .insert(settings)
      .values({ key: parsed.key, value, updatedBy: parsed.userId })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value, updatedBy: parsed.userId, updatedAt: new Date() },
      });

    await writeAudit(tx, {
      actorId: parsed.userId,
      action: "setting.update",
      entityType: "setting",
      entityId: parsed.key,
      before: current ? { value: current.value } : null,
      after: { value },
    });
  });

  return { key: parsed.key, value };
}
