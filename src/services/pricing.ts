// Serviço de PRECIFICAÇÃO: versões de preço com fluxo de aprovação.
// Regras puras vivem em @/core/pricing; aqui fica a orquestração com o banco.
import { and, desc, eq, isNotNull, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import {
  alias,
  type PgDatabase,
  type PgQueryResultHKT,
  type PgTransaction,
} from "drizzle-orm/pg-core";
import { z } from "zod";

import * as schema from "@/db/schema";
import {
  auditLog,
  paymentFeeRules,
  priceVersions,
  pricingPolicies,
  products,
  productVariants,
  settings,
  variantCosts,
} from "@/db/schema";
import { enqueueOutboxEvent, type DbOrTx } from "@/queue/enqueue";
import {
  calculatePrice,
  evaluateApproval,
  suggestMarginForPrice,
  type ApprovalReason,
  type PricingInputs,
  type PricingResult,
  type RoundingDirection,
  type RoundingMode,
} from "@/core/pricing";

type Schema = typeof schema;

/**
 * Base estrutural comum ao Db de produção (postgres.js), às suas transações e
 * ao banco dos testes (PGlite): aceita qualquer um sem cast nos chamadores.
 */
export type PricingDb =
  | PgDatabase<PgQueryResultHKT, Schema>
  | PgTransaction<PgQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>>;

export type PriceVersionRow = typeof priceVersions.$inferSelect;

export class ServiceError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ServiceError";
    this.code = code;
  }
}

// enqueueOutboxEvent é tipado com o DbOrTx do runtime; a base estrutural é a
// mesma (só usa .insert), então o estreitamento aqui é seguro.
function asDbOrTx(db: PricingDb): DbOrTx {
  return db as DbOrTx;
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const e = error as {
    code?: string;
    message?: string;
    cause?: { code?: string; message?: string };
  };
  return (
    e.code === "23505" ||
    e.cause?.code === "23505" ||
    /duplicate key|unique/i.test(e.message ?? "") ||
    /duplicate key|unique/i.test(e.cause?.message ?? "")
  );
}

const ROUNDING_MODES = ["none", "to_90", "to_99", "to_50", "integer"] as const;
const ROUNDING_DIRECTIONS = ["up", "nearest"] as const;

const uuidSchema = z.uuid();

const overridesSchema = z.object({
  targetMarginRate: z.number().min(0).lt(1).optional(),
  otherFixedCents: z.number().int().min(0).optional(),
  roundingMode: z.enum(ROUNDING_MODES).optional(),
  roundingDirection: z.enum(ROUNDING_DIRECTIONS).optional(),
});

export type PriceOverrides = z.infer<typeof overridesSchema>;

export interface PricingContext {
  feeRule: { id: string; percentRate: number; fixedFeeCents: number };
  policy: {
    id: string;
    targetMarginRate: number;
    minMarginRate: number;
    otherCostsFixedCents: number;
    otherCostsRate: number;
    roundingMode: RoundingMode;
    roundingDirection: RoundingDirection;
  };
  settings: {
    priceChangePctThreshold: number;
    firstPriceRequiresApproval: boolean;
  };
  variant: { id: string; productId: string; costCents: number };
  previousActive: {
    id: string;
    priceCents: number;
    versionNumber: number;
  } | null;
}

const POLICY_SCOPE_RANK: Record<string, number> = {
  variant: 0,
  product: 1,
  category: 2,
  global: 3,
};

async function writeAudit(
  db: PricingDb,
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

// ---------------------------------------------------------------------------
// 1. Contexto de precificação
// ---------------------------------------------------------------------------

export async function getPricingContext(
  db: PricingDb,
  variantId: string,
): Promise<PricingContext> {
  const parsedVariantId = uuidSchema.parse(variantId);

  const [variantRow] = await db
    .select({
      id: productVariants.id,
      productId: productVariants.productId,
      costCents: productVariants.costCents,
      categoryId: products.categoryId,
    })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(eq(productVariants.id, parsedVariantId))
    .limit(1);

  if (!variantRow) {
    throw new ServiceError(
      "variant_not_found",
      `Variante ${parsedVariantId} não encontrada.`,
    );
  }

  const [feeRuleRow] = await db
    .select()
    .from(paymentFeeRules)
    .where(
      and(
        eq(paymentFeeRules.isReferenceForPricing, true),
        isNull(paymentFeeRules.effectiveTo),
      ),
    )
    .orderBy(desc(paymentFeeRules.effectiveFrom))
    .limit(1);

  if (!feeRuleRow) {
    throw new ServiceError(
      "fee_rule_missing",
      "Nenhuma taxa de pagamento vigente está marcada como referência para precificação. Cadastre uma regra de taxa com essa marcação antes de precificar.",
    );
  }

  const scopeConditions: SQL[] = [
    and(
      eq(pricingPolicies.scopeType, "variant"),
      eq(pricingPolicies.scopeId, variantRow.id),
    )!,
    and(
      eq(pricingPolicies.scopeType, "product"),
      eq(pricingPolicies.scopeId, variantRow.productId),
    )!,
    eq(pricingPolicies.scopeType, "global"),
  ];
  if (variantRow.categoryId) {
    scopeConditions.push(
      and(
        eq(pricingPolicies.scopeType, "category"),
        eq(pricingPolicies.scopeId, variantRow.categoryId),
      )!,
    );
  }

  const policyCandidates = await db
    .select()
    .from(pricingPolicies)
    .where(and(eq(pricingPolicies.isActive, true), or(...scopeConditions)));

  const policyRow = [...policyCandidates].sort(
    (a, b) =>
      (POLICY_SCOPE_RANK[a.scopeType] ?? 9) -
        (POLICY_SCOPE_RANK[b.scopeType] ?? 9) ||
      b.updatedAt.getTime() - a.updatedAt.getTime(),
  )[0];

  if (!policyRow) {
    throw new ServiceError(
      "pricing_policy_missing",
      "Nenhuma política de precificação ativa se aplica a esta variante. Cadastre ao menos uma política global ativa.",
    );
  }

  const settingRows = await db
    .select()
    .from(settings)
    .where(
      or(
        eq(settings.key, "price_change_pct_threshold"),
        eq(settings.key, "first_price_requires_approval"),
      ),
    );
  const settingMap = new Map(settingRows.map((r) => [r.key, r.value]));
  const thresholdRaw = settingMap.get("price_change_pct_threshold");
  const firstPriceRaw = settingMap.get("first_price_requires_approval");

  const [previousActive] = await db
    .select({
      id: priceVersions.id,
      priceCents: priceVersions.priceCents,
      versionNumber: priceVersions.versionNumber,
    })
    .from(priceVersions)
    .where(
      and(
        eq(priceVersions.productVariantId, parsedVariantId),
        eq(priceVersions.status, "active"),
      ),
    )
    .limit(1);

  return {
    feeRule: {
      id: feeRuleRow.id,
      // numeric(7,4) chega como string do driver — converter é obrigatório.
      percentRate: Number(feeRuleRow.percentRate),
      fixedFeeCents: feeRuleRow.fixedFeeCents,
    },
    policy: {
      id: policyRow.id,
      targetMarginRate: Number(policyRow.targetMarginRate),
      minMarginRate: Number(policyRow.minMarginRate),
      otherCostsFixedCents: policyRow.otherCostsFixedCents,
      otherCostsRate: Number(policyRow.otherCostsRate),
      roundingMode: z.enum(ROUNDING_MODES).parse(policyRow.roundingMode),
      roundingDirection: z
        .enum(ROUNDING_DIRECTIONS)
        .parse(policyRow.roundingDirection),
    },
    settings: {
      priceChangePctThreshold:
        thresholdRaw === undefined ? 0.1 : Number(thresholdRaw),
      firstPriceRequiresApproval:
        firstPriceRaw === undefined ? true : firstPriceRaw === true,
    },
    variant: {
      id: variantRow.id,
      productId: variantRow.productId,
      costCents: variantRow.costCents,
    },
    previousActive: previousActive ?? null,
  };
}

function buildPricingInputs(
  ctx: PricingContext,
  overrides?: PriceOverrides,
): PricingInputs {
  return {
    costCents: ctx.variant.costCents,
    otherFixedCents:
      overrides?.otherFixedCents ?? ctx.policy.otherCostsFixedCents,
    otherRate: ctx.policy.otherCostsRate,
    feePercentRate: ctx.feeRule.percentRate,
    feeFixedCents: ctx.feeRule.fixedFeeCents,
    shippingSubsidyCents: 0,
    targetMarginRate:
      overrides?.targetMarginRate ?? ctx.policy.targetMarginRate,
    rounding: {
      mode: overrides?.roundingMode ?? ctx.policy.roundingMode,
      direction: overrides?.roundingDirection ?? ctx.policy.roundingDirection,
    },
  };
}

// ---------------------------------------------------------------------------
// 2. Preview (calculadora — não persiste)
// ---------------------------------------------------------------------------

const previewPriceSchema = z.object({
  variantId: uuidSchema,
  ...overridesSchema.shape,
});

export type PreviewPriceInput = z.input<typeof previewPriceSchema>;

export async function previewPrice(
  db: PricingDb,
  input: PreviewPriceInput,
): Promise<{
  result: PricingResult;
  context: {
    feeRuleId: string;
    policyId: string;
    costCents: number;
    previousActivePriceCents: number | null;
  };
}> {
  const parsed = previewPriceSchema.parse(input);
  const ctx = await getPricingContext(db, parsed.variantId);
  const result = calculatePrice(buildPricingInputs(ctx, parsed));
  return {
    result,
    context: {
      feeRuleId: ctx.feeRule.id,
      policyId: ctx.policy.id,
      costCents: ctx.variant.costCents,
      previousActivePriceCents: ctx.previousActive?.priceCents ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// 5. Ativação (interna, sempre dentro de transação)
// ---------------------------------------------------------------------------

async function activateVersionTx(
  tx: PricingDb,
  versionId: string,
  userId: string,
): Promise<void> {
  const [version] = await tx
    .select()
    .from(priceVersions)
    .where(eq(priceVersions.id, versionId))
    .limit(1);

  if (!version) {
    throw new ServiceError(
      "price_version_not_found",
      `Versão de preço ${versionId} não encontrada.`,
    );
  }
  if (version.status !== "approved") {
    throw new ServiceError(
      "invalid_status",
      `Apenas versões aprovadas podem ser ativadas (status atual: ${version.status}).`,
    );
  }

  const now = new Date();

  await tx
    .update(priceVersions)
    .set({ status: "superseded", supersededAt: now })
    .where(
      and(
        eq(priceVersions.productVariantId, version.productVariantId),
        eq(priceVersions.status, "active"),
        ne(priceVersions.id, versionId),
      ),
    );

  try {
    await tx
      .update(priceVersions)
      .set({ status: "active", activatedAt: now, approvedBy: userId })
      .where(eq(priceVersions.id, versionId));
  } catch (error) {
    // Rede final: índice único parcial (1 'active' por variante) no banco.
    if (isUniqueViolation(error)) {
      throw new ServiceError(
        "active_price_conflict",
        "Conflito de ativação: já existe outro preço ativo para esta variante (proteção do índice único do banco). Recarregue e tente novamente.",
        { cause: error },
      );
    }
    throw error;
  }

  await enqueueOutboxEvent(asDbOrTx(tx), {
    eventType: "price.activated",
    dedupeKey: `price.activated:${versionId}`,
    payload: {
      variantId: version.productVariantId,
      priceCents: version.priceCents,
    },
    aggregateType: "price_version",
    aggregateId: versionId,
  });
}

// ---------------------------------------------------------------------------
// 3. Criação de versão de preço
// ---------------------------------------------------------------------------

const createPriceVersionSchema = z.object({
  variantId: uuidSchema,
  userId: uuidSchema,
  origin: z.enum([
    "manual",
    "auto_cost_change",
    "auto_fee_change",
    "bulk_update",
    "initial",
  ]),
  overrides: overridesSchema.optional(),
  priceCentsManual: z.number().int().positive().optional(),
  batchId: uuidSchema.optional(),
});

export type CreatePriceVersionInput = z.input<typeof createPriceVersionSchema>;

async function createPriceVersionInTx(
  tx: PricingDb,
  parsed: z.output<typeof createPriceVersionSchema>,
): Promise<PriceVersionRow> {
  const ctx = await getPricingContext(tx, parsed.variantId);
  const inputs = buildPricingInputs(ctx, parsed.overrides);
  const calc = calculatePrice(inputs);

  let priceCents: number;
  let effectiveMarginRate: number;
  let breakdown: unknown;

  if (parsed.priceCentsManual !== undefined) {
    // Preço digitado à mão: vale o valor informado; a margem efetiva é o
    // inverso da calculadora e o breakdown do cálculo fica com uma nota.
    priceCents = parsed.priceCentsManual;
    effectiveMarginRate = suggestMarginForPrice(inputs, priceCents);
    breakdown = {
      ...calc.breakdown,
      manualPriceCents: priceCents,
      note: "Preço informado manualmente; os passos refletem o cálculo pela política vigente, não o preço final.",
    };
  } else {
    priceCents = calc.priceCents;
    effectiveMarginRate = calc.effectiveMarginRate;
    breakdown = calc.breakdown;
  }

  const totalCostCents =
    inputs.costCents +
    inputs.otherFixedCents +
    inputs.feeFixedCents +
    inputs.shippingSubsidyCents;

  // Primeira precificação = nunca houve versão ativada (ativa ou superada).
  const activatedBefore = await tx
    .select({ id: priceVersions.id })
    .from(priceVersions)
    .where(
      and(
        eq(priceVersions.productVariantId, parsed.variantId),
        isNotNull(priceVersions.activatedAt),
      ),
    )
    .limit(1);
  const isFirstPrice = activatedBefore.length === 0;

  const decision = evaluateApproval({
    newPriceCents: priceCents,
    previousActivePriceCents: ctx.previousActive?.priceCents ?? null,
    effectiveMarginRate,
    minMarginRate: ctx.policy.minMarginRate,
    totalCostCents,
    changePctThreshold: ctx.settings.priceChangePctThreshold,
    isFirstPrice,
    firstPriceRequiresApproval: ctx.settings.firstPriceRequiresApproval,
    isBulk: parsed.batchId !== undefined,
  });

  const [{ maxVersion }] = await tx
    .select({
      maxVersion: sql`coalesce(max(${priceVersions.versionNumber}), 0)`.mapWith(
        Number,
      ),
    })
    .from(priceVersions)
    .where(eq(priceVersions.productVariantId, parsed.variantId));
  const versionNumber = maxVersion + 1;

  const now = new Date();
  const [created] = await tx
    .insert(priceVersions)
    .values({
      productVariantId: parsed.variantId,
      versionNumber,
      status: decision.requiresApproval ? "pending_approval" : "approved",
      priceCents,
      previousPriceCents: ctx.previousActive?.priceCents ?? null,
      origin: parsed.origin,
      breakdown,
      costSnapshotCents: ctx.variant.costCents,
      feeRuleId: ctx.feeRule.id,
      policyId: ctx.policy.id,
      // numeric(7,4) em modo string: gravar com exatamente 4 casas.
      computedMarginRate: effectiveMarginRate.toFixed(4),
      requiresApproval: decision.requiresApproval,
      approvalReasons: decision.reasons as string[],
      batchId: parsed.batchId ?? null,
      createdBy: parsed.userId,
      ...(decision.requiresApproval
        ? {}
        : { approvedBy: parsed.userId, approvedAt: now }),
    })
    .returning();

  if (decision.requiresApproval) {
    await writeAudit(tx, {
      actorId: parsed.userId,
      action: "price.submit",
      entityType: "price_version",
      entityId: created.id,
      after: {
        priceCents,
        versionNumber,
        origin: parsed.origin,
        approvalReasons: decision.reasons,
      },
    });
  } else {
    await activateVersionTx(tx, created.id, parsed.userId);
    await writeAudit(tx, {
      actorId: parsed.userId,
      action: "price.auto_activate",
      entityType: "price_version",
      entityId: created.id,
      before: ctx.previousActive
        ? { priceCents: ctx.previousActive.priceCents }
        : null,
      after: { priceCents, versionNumber, origin: parsed.origin },
    });
  }

  const [fresh] = await tx
    .select()
    .from(priceVersions)
    .where(eq(priceVersions.id, created.id))
    .limit(1);
  return fresh;
}

export async function createPriceVersion(
  db: PricingDb,
  input: CreatePriceVersionInput,
): Promise<PriceVersionRow> {
  const parsed = createPriceVersionSchema.parse(input);
  return await db.transaction(async (tx) => createPriceVersionInTx(tx, parsed));
}

// ---------------------------------------------------------------------------
// 4. Aprovação / rejeição
// ---------------------------------------------------------------------------

const approvePriceVersionSchema = z.object({
  versionId: uuidSchema,
  userId: uuidSchema,
});

export async function approvePriceVersion(
  db: PricingDb,
  input: z.input<typeof approvePriceVersionSchema>,
): Promise<PriceVersionRow> {
  const parsed = approvePriceVersionSchema.parse(input);
  return await db.transaction(async (tx) => {
    const [version] = await tx
      .select()
      .from(priceVersions)
      .where(eq(priceVersions.id, parsed.versionId))
      .limit(1);

    if (!version) {
      throw new ServiceError(
        "price_version_not_found",
        `Versão de preço ${parsed.versionId} não encontrada.`,
      );
    }
    if (version.status !== "pending_approval") {
      throw new ServiceError(
        "invalid_status",
        `Apenas versões pendentes de aprovação podem ser aprovadas (status atual: ${version.status}).`,
      );
    }

    await tx
      .update(priceVersions)
      .set({
        status: "approved",
        approvedBy: parsed.userId,
        approvedAt: new Date(),
      })
      .where(eq(priceVersions.id, parsed.versionId));

    await activateVersionTx(tx, parsed.versionId, parsed.userId);

    await writeAudit(tx, {
      actorId: parsed.userId,
      action: "price.approve",
      entityType: "price_version",
      entityId: parsed.versionId,
      before: { status: version.status },
      after: { status: "active", priceCents: version.priceCents },
    });

    const [fresh] = await tx
      .select()
      .from(priceVersions)
      .where(eq(priceVersions.id, parsed.versionId))
      .limit(1);
    return fresh;
  });
}

const rejectPriceVersionSchema = z.object({
  versionId: uuidSchema,
  userId: uuidSchema,
  reason: z
    .string({ error: "Motivo da rejeição é obrigatório." })
    .trim()
    .min(1, "Motivo da rejeição é obrigatório."),
});

export async function rejectPriceVersion(
  db: PricingDb,
  input: z.input<typeof rejectPriceVersionSchema>,
): Promise<PriceVersionRow> {
  const parsed = rejectPriceVersionSchema.parse(input);
  return await db.transaction(async (tx) => {
    const [version] = await tx
      .select()
      .from(priceVersions)
      .where(eq(priceVersions.id, parsed.versionId))
      .limit(1);

    if (!version) {
      throw new ServiceError(
        "price_version_not_found",
        `Versão de preço ${parsed.versionId} não encontrada.`,
      );
    }
    if (version.status !== "pending_approval") {
      throw new ServiceError(
        "invalid_status",
        `Apenas versões pendentes de aprovação podem ser rejeitadas (status atual: ${version.status}).`,
      );
    }

    const [fresh] = await tx
      .update(priceVersions)
      .set({
        status: "rejected",
        rejectedAt: new Date(),
        rejectionReason: parsed.reason,
      })
      .where(eq(priceVersions.id, parsed.versionId))
      .returning();

    await writeAudit(tx, {
      actorId: parsed.userId,
      action: "price.reject",
      entityType: "price_version",
      entityId: parsed.versionId,
      before: { status: version.status },
      after: { status: "rejected" },
      reason: parsed.reason,
    });

    return fresh;
  });
}

// ---------------------------------------------------------------------------
// 6. Custo da variante
// ---------------------------------------------------------------------------

const setVariantCostSchema = z.object({
  variantId: uuidSchema,
  costCents: z.number().int().min(0),
  note: z.string().trim().min(1).optional(),
  userId: uuidSchema,
});

export async function setVariantCost(
  db: PricingDb,
  input: z.input<typeof setVariantCostSchema>,
): Promise<{
  variantId: string;
  previousCostCents: number;
  costCents: number;
  priceVersion: PriceVersionRow | null;
}> {
  const parsed = setVariantCostSchema.parse(input);
  return await db.transaction(async (tx) => {
    const [variant] = await tx
      .select({
        id: productVariants.id,
        costCents: productVariants.costCents,
      })
      .from(productVariants)
      .where(eq(productVariants.id, parsed.variantId))
      .limit(1);

    if (!variant) {
      throw new ServiceError(
        "variant_not_found",
        `Variante ${parsed.variantId} não encontrada.`,
      );
    }

    await tx.insert(variantCosts).values({
      productVariantId: parsed.variantId,
      costCents: parsed.costCents,
      source: "manual",
      note: parsed.note ?? null,
      createdBy: parsed.userId,
    });

    await tx
      .update(productVariants)
      .set({ costCents: parsed.costCents, updatedAt: new Date() })
      .where(eq(productVariants.id, parsed.variantId));

    await writeAudit(tx, {
      actorId: parsed.userId,
      action: "cost.set",
      entityType: "product_variant",
      entityId: parsed.variantId,
      before: { costCents: variant.costCents },
      after: { costCents: parsed.costCents },
      reason: parsed.note ?? null,
    });

    // Reprecificação automática apenas quando já existe preço ativo;
    // o fluxo de aprovação decide se a nova versão ativa ou fica pendente.
    const [active] = await tx
      .select({ id: priceVersions.id })
      .from(priceVersions)
      .where(
        and(
          eq(priceVersions.productVariantId, parsed.variantId),
          eq(priceVersions.status, "active"),
        ),
      )
      .limit(1);

    let priceVersion: PriceVersionRow | null = null;
    if (active) {
      priceVersion = await createPriceVersionInTx(tx, {
        variantId: parsed.variantId,
        userId: parsed.userId,
        origin: "auto_cost_change",
        overrides: undefined,
        priceCentsManual: undefined,
        batchId: undefined,
      });
    }

    return {
      variantId: parsed.variantId,
      previousCostCents: variant.costCents,
      costCents: parsed.costCents,
      priceVersion,
    };
  });
}

// ---------------------------------------------------------------------------
// 7. Consultas
// ---------------------------------------------------------------------------

export async function getActivePrice(
  db: PricingDb,
  variantId: string,
): Promise<PriceVersionRow | null> {
  const parsedVariantId = uuidSchema.parse(variantId);
  const [row] = await db
    .select()
    .from(priceVersions)
    .where(
      and(
        eq(priceVersions.productVariantId, parsedVariantId),
        eq(priceVersions.status, "active"),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function listPriceVersions(
  db: PricingDb,
  variantId: string,
): Promise<PriceVersionRow[]> {
  const parsedVariantId = uuidSchema.parse(variantId);
  return await db
    .select()
    .from(priceVersions)
    .where(eq(priceVersions.productVariantId, parsedVariantId))
    .orderBy(desc(priceVersions.versionNumber));
}

export interface PendingApprovalItem {
  versionId: string;
  variantId: string;
  versionNumber: number;
  sku: string;
  productName: string;
  priceCents: number;
  computedMarginRate: number;
  approvalReasons: ApprovalReason[];
  origin: string;
  batchId: string | null;
  createdAt: Date;
  currentActivePriceCents: number | null;
}

export async function listPendingApprovals(
  db: PricingDb,
): Promise<PendingApprovalItem[]> {
  const activePrice = alias(priceVersions, "active_price");
  const rows = await db
    .select({
      versionId: priceVersions.id,
      variantId: priceVersions.productVariantId,
      versionNumber: priceVersions.versionNumber,
      sku: productVariants.sku,
      productName: products.name,
      priceCents: priceVersions.priceCents,
      computedMarginRate: priceVersions.computedMarginRate,
      approvalReasons: priceVersions.approvalReasons,
      origin: priceVersions.origin,
      batchId: priceVersions.batchId,
      createdAt: priceVersions.createdAt,
      currentActivePriceCents: activePrice.priceCents,
    })
    .from(priceVersions)
    .innerJoin(
      productVariants,
      eq(productVariants.id, priceVersions.productVariantId),
    )
    .innerJoin(products, eq(products.id, productVariants.productId))
    .leftJoin(
      activePrice,
      and(
        eq(activePrice.productVariantId, priceVersions.productVariantId),
        eq(activePrice.status, "active"),
      ),
    )
    .where(eq(priceVersions.status, "pending_approval"))
    .orderBy(desc(priceVersions.createdAt));

  return rows.map((row) => ({
    ...row,
    computedMarginRate: Number(row.computedMarginRate),
    approvalReasons: (row.approvalReasons ?? []) as ApprovalReason[],
    currentActivePriceCents: row.currentActivePriceCents ?? null,
  }));
}

export interface PriceOverviewItem {
  variantId: string;
  sku: string;
  productName: string;
  costCents: number;
  activePriceCents: number | null;
  activeMarginRate: number | null;
  pendingCount: number;
}

export async function listPricesOverview(
  db: PricingDb,
): Promise<PriceOverviewItem[]> {
  const activePrice = alias(priceVersions, "active_price");
  const rows = await db
    .select({
      variantId: productVariants.id,
      sku: productVariants.sku,
      productName: products.name,
      costCents: productVariants.costCents,
      activePriceCents: activePrice.priceCents,
      activeMarginRate: activePrice.computedMarginRate,
      pendingCount:
        sql`(select count(*) from price_versions pv where pv.product_variant_id = ${productVariants.id} and pv.status = 'pending_approval')`.mapWith(
          Number,
        ),
    })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .leftJoin(
      activePrice,
      and(
        eq(activePrice.productVariantId, productVariants.id),
        eq(activePrice.status, "active"),
      ),
    )
    .where(
      and(eq(productVariants.isActive, true), isNull(productVariants.deletedAt)),
    )
    .orderBy(productVariants.sku);

  return rows.map((row) => ({
    ...row,
    activePriceCents: row.activePriceCents ?? null,
    activeMarginRate:
      row.activeMarginRate === null ? null : Number(row.activeMarginRate),
  }));
}
