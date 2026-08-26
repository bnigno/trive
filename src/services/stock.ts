import { and, desc, asc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import type { DbOrTx } from "@/queue/enqueue";
import { enqueueOutboxEvent } from "@/queue/enqueue";
import {
  auditLog,
  financialEntries,
  products,
  productVariants,
  stockLevels,
  stockMovements,
  suppliers,
  variantCosts,
} from "@/db/schema";
import {
  applyMovement,
  isLowStock,
  movementsForTransition,
  type StockLevel,
} from "@/core/stock/ledger";
import {
  repriceAfterCostChangeTx,
  type PriceVersionRow,
  type PricingDb,
} from "@/services/pricing";

// ---------------------------------------------------------------------------
// Erros de negócio
// ---------------------------------------------------------------------------

export class ServiceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ServiceError";
    this.code = code;
  }
}

export class VariantNotFoundError extends ServiceError {
  constructor(variantId: string) {
    super("VARIANT_NOT_FOUND", `Variante não encontrada: ${variantId}.`);
    this.name = "VariantNotFoundError";
  }
}

// ---------------------------------------------------------------------------
// Helpers internos
// ---------------------------------------------------------------------------

interface LockedLevel extends StockLevel {
  lowStockThreshold: number;
}

async function assertVariantExists(tx: DbOrTx, variantId: string): Promise<void> {
  const [variant] = await tx
    .select({ id: productVariants.id })
    .from(productVariants)
    .where(eq(productVariants.id, variantId))
    .limit(1);
  if (!variant) throw new VariantNotFoundError(variantId);
}

/**
 * Garante a linha em stock_levels e a trava com SELECT ... FOR UPDATE
 * antes de qualquer atualização de saldo (obrigatório na mesma transação).
 */
async function lockLevel(tx: DbOrTx, variantId: string): Promise<LockedLevel> {
  await tx
    .insert(stockLevels)
    .values({ productVariantId: variantId })
    .onConflictDoNothing();

  const [row] = await tx
    .select({
      onHand: stockLevels.onHand,
      reserved: stockLevels.reserved,
      lowStockThreshold: stockLevels.lowStockThreshold,
    })
    .from(stockLevels)
    .where(eq(stockLevels.productVariantId, variantId))
    .for("update");

  return row;
}

async function updateLevel(
  tx: DbOrTx,
  variantId: string,
  next: StockLevel,
): Promise<void> {
  await tx
    .update(stockLevels)
    .set({
      onHand: next.onHand,
      reserved: next.reserved,
      updatedAt: sql`now()`,
    })
    .where(eq(stockLevels.productVariantId, variantId));
}

/** Enfileira 'stock.low' apenas quando o disponível CRUZOU o limiar para baixo. */
async function maybeEnqueueLowStock(
  tx: DbOrTx,
  variantId: string,
  before: StockLevel,
  after: StockLevel,
  threshold: number,
): Promise<void> {
  if (!isLowStock(before, threshold) && isLowStock(after, threshold)) {
    await enqueueOutboxEvent(tx, {
      eventType: "stock.low",
      dedupeKey: `stock.low:${variantId}`,
      aggregateType: "product_variant",
      aggregateId: variantId,
      payload: {
        variantId,
        available: after.onHand - after.reserved,
        threshold,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// 1. receiveStock
// ---------------------------------------------------------------------------

const receiveStockSchema = z.object({
  variantId: z.uuid(),
  quantity: z.number().int().positive(),
  unitCostCents: z.number().int().nonnegative().optional(),
  note: z.string().min(1).optional(),
  userId: z.uuid(),
});

export type ReceiveStockInput = z.input<typeof receiveStockSchema>;

export async function receiveStock(
  db: DbOrTx,
  input: ReceiveStockInput,
): Promise<{ movementId: string; onHand: number; reserved: number }> {
  const parsed = receiveStockSchema.parse(input);

  return db.transaction(async (tx) => {
    await assertVariantExists(tx, parsed.variantId);
    const before = await lockLevel(tx, parsed.variantId);

    const after = applyMovement(before, {
      type: "purchase_in",
      quantityDelta: parsed.quantity,
    });

    const [movement] = await tx
      .insert(stockMovements)
      .values({
        productVariantId: parsed.variantId,
        type: "purchase_in",
        quantityDelta: parsed.quantity,
        unitCostCents: parsed.unitCostCents ?? null,
        note: parsed.note ?? null,
        createdBy: parsed.userId,
      })
      .returning({ id: stockMovements.id });

    await updateLevel(tx, parsed.variantId, after);

    if (parsed.unitCostCents !== undefined) {
      await tx.insert(variantCosts).values({
        productVariantId: parsed.variantId,
        costCents: parsed.unitCostCents,
        source: "purchase",
        note: parsed.note ?? null,
        createdBy: parsed.userId,
      });
      // Denormalização: custo mais recente refletido na variante.
      await tx
        .update(productVariants)
        .set({ costCents: parsed.unitCostCents, updatedAt: sql`now()` })
        .where(eq(productVariants.id, parsed.variantId));
    }

    await tx.insert(auditLog).values({
      actorType: "user",
      actorId: parsed.userId,
      action: "stock.receive",
      entityType: "stock_level",
      entityId: parsed.variantId,
      before: { onHand: before.onHand, reserved: before.reserved },
      after: {
        onHand: after.onHand,
        reserved: after.reserved,
        unitCostCents: parsed.unitCostCents ?? null,
      },
      reason: parsed.note ?? null,
    });

    return { movementId: movement.id, onHand: after.onHand, reserved: after.reserved };
  });
}

// ---------------------------------------------------------------------------
// 1b. receivePurchase — entrada de compra COM fornecedor
// ---------------------------------------------------------------------------

// repriceAfterCostChangeTx é tipado com o PricingDb estrutural; a transação
// aqui usa a mesma API drizzle (mesmo precedente do asDbOrTx em pricing.ts).
function asPricingDb(tx: DbOrTx): PricingDb {
  return tx as unknown as PricingDb;
}

const receivePurchaseSchema = z.object({
  variantId: z.uuid(),
  supplierId: z.uuid(),
  quantity: z.number().int().positive(),
  unitCostCents: z
    .number()
    .int()
    .positive("O custo unitário da compra deve ser maior que zero."),
  invoiceNumber: z.string().trim().min(1).optional(),
  dueDate: z.iso.date().optional(),
  note: z.string().min(1).optional(),
  userId: z.uuid(),
});

export type ReceivePurchaseInput = z.input<typeof receivePurchaseSchema>;

/**
 * Entrada de compra vinculada a fornecedor, TUDO numa transação:
 * movimento purchase_in referenciando o fornecedor + custo (ledger
 * variant_costs 'purchase' + denormalização) + sugestão de reprecificação
 * (mecânica do setVariantCost, só quando há preço ativo) + conta a pagar
 * pendente no financeiro. Entrada SEM fornecedor continua no receiveStock.
 */
export async function receivePurchase(
  db: DbOrTx,
  input: ReceivePurchaseInput,
): Promise<{
  movementId: string;
  onHand: number;
  reserved: number;
  financialEntryId: string;
  priceVersion: PriceVersionRow | null;
}> {
  const parsed = receivePurchaseSchema.parse(input);

  return db.transaction(async (tx) => {
    const [variant] = await tx
      .select({ id: productVariants.id, sku: productVariants.sku })
      .from(productVariants)
      .where(eq(productVariants.id, parsed.variantId))
      .limit(1);
    if (!variant) throw new VariantNotFoundError(parsed.variantId);

    const [supplier] = await tx
      .select({ id: suppliers.id, name: suppliers.name })
      .from(suppliers)
      .where(
        and(eq(suppliers.id, parsed.supplierId), isNull(suppliers.deletedAt)),
      )
      .limit(1);
    if (!supplier) {
      throw new ServiceError("SUPPLIER_NOT_FOUND", "Fornecedor não encontrado.");
    }

    const before = await lockLevel(tx, parsed.variantId);
    const after = applyMovement(before, {
      type: "purchase_in",
      quantityDelta: parsed.quantity,
    });

    const [movement] = await tx
      .insert(stockMovements)
      .values({
        productVariantId: parsed.variantId,
        type: "purchase_in",
        quantityDelta: parsed.quantity,
        unitCostCents: parsed.unitCostCents,
        referenceType: "supplier",
        referenceId: parsed.supplierId,
        note: parsed.note ?? null,
        createdBy: parsed.userId,
      })
      .returning({ id: stockMovements.id });

    await updateLevel(tx, parsed.variantId, after);

    await tx.insert(variantCosts).values({
      productVariantId: parsed.variantId,
      costCents: parsed.unitCostCents,
      source: "purchase",
      note: parsed.note ?? null,
      createdBy: parsed.userId,
    });
    // Denormalização: custo mais recente refletido na variante.
    await tx
      .update(productVariants)
      .set({ costCents: parsed.unitCostCents, updatedAt: sql`now()` })
      .where(eq(productVariants.id, parsed.variantId));

    const priceVersion = await repriceAfterCostChangeTx(asPricingDb(tx), {
      variantId: parsed.variantId,
      userId: parsed.userId,
    });

    const amountCents = parsed.quantity * parsed.unitCostCents;
    const description = `Compra: ${parsed.quantity}× ${variant.sku} — ${supplier.name}${
      parsed.invoiceNumber ? ` (NF ${parsed.invoiceNumber})` : ""
    }`;
    const [entry] = await tx
      .insert(financialEntries)
      .values({
        direction: "payable",
        category: "supplier",
        description,
        amountCents,
        status: "pending",
        dueDate: parsed.dueDate ?? null,
        supplierId: parsed.supplierId,
        createdBy: parsed.userId,
      })
      .returning({ id: financialEntries.id });

    await tx.insert(auditLog).values({
      actorType: "user",
      actorId: parsed.userId,
      action: "purchase.receive",
      entityType: "stock_level",
      entityId: parsed.variantId,
      before: { onHand: before.onHand, reserved: before.reserved },
      after: {
        onHand: after.onHand,
        reserved: after.reserved,
        supplierId: parsed.supplierId,
        unitCostCents: parsed.unitCostCents,
        amountCents,
        financialEntryId: entry.id,
        priceVersionId: priceVersion?.id ?? null,
      },
      reason: parsed.note ?? null,
    });

    return {
      movementId: movement.id,
      onHand: after.onHand,
      reserved: after.reserved,
      financialEntryId: entry.id,
      priceVersion,
    };
  });
}

// ---------------------------------------------------------------------------
// 2. adjustStock
// ---------------------------------------------------------------------------

const adjustStockSchema = z.object({
  variantId: z.uuid(),
  quantityDelta: z
    .number()
    .int()
    .refine((v) => v !== 0, { message: "O ajuste exige quantidade diferente de zero." }),
  note: z.string().min(1, { message: "A nota é obrigatória em ajustes de estoque." }),
  asLoss: z.boolean().optional(),
  userId: z.uuid(),
});

export type AdjustStockInput = z.input<typeof adjustStockSchema>;

export async function adjustStock(
  db: DbOrTx,
  input: AdjustStockInput,
): Promise<{ movementId: string; onHand: number; reserved: number }> {
  const parsed = adjustStockSchema.parse(input);
  const type = parsed.asLoss === true && parsed.quantityDelta < 0 ? "loss" : "adjustment";

  return db.transaction(async (tx) => {
    await assertVariantExists(tx, parsed.variantId);
    const before = await lockLevel(tx, parsed.variantId);

    // Valida com o core ANTES de gravar (lança se negativaria o saldo).
    const after = applyMovement(before, { type, quantityDelta: parsed.quantityDelta });

    const [movement] = await tx
      .insert(stockMovements)
      .values({
        productVariantId: parsed.variantId,
        type,
        quantityDelta: parsed.quantityDelta,
        note: parsed.note,
        createdBy: parsed.userId,
      })
      .returning({ id: stockMovements.id });

    await updateLevel(tx, parsed.variantId, after);
    await maybeEnqueueLowStock(tx, parsed.variantId, before, after, before.lowStockThreshold);

    await tx.insert(auditLog).values({
      actorType: "user",
      actorId: parsed.userId,
      action: "stock.adjust",
      entityType: "stock_level",
      entityId: parsed.variantId,
      before: { onHand: before.onHand, reserved: before.reserved },
      after: { onHand: after.onHand, reserved: after.reserved, type },
      reason: parsed.note,
    });

    return { movementId: movement.id, onHand: after.onHand, reserved: after.reserved };
  });
}

// ---------------------------------------------------------------------------
// 3. applyStockEffectTx — contrato usado pelo serviço de pedidos
// ---------------------------------------------------------------------------

const applyStockEffectSchema = z.object({
  effect: z.enum(["reserve", "consume", "release", "return"]),
  variantId: z.uuid(),
  quantity: z.number().int().positive(),
  referenceType: z.literal("order"),
  referenceId: z.uuid(),
  createdBy: z.uuid().optional(),
});

export type ApplyStockEffectInput = z.input<typeof applyStockEffectSchema>;

/**
 * Aplica o efeito de estoque de uma transição de pedido. IDEMPOTENTE por
 * idempotency_key (`${movementType}:${referenceId}:${variantId}`): movimento
 * já existente não reaplica o delta no saldo.
 */
export async function applyStockEffectTx(
  tx: DbOrTx,
  input: ApplyStockEffectInput,
): Promise<{ applied: boolean; onHand: number; reserved: number }> {
  const parsed = applyStockEffectSchema.parse(input);

  return tx.transaction(async (trx) => {
    await assertVariantExists(trx, parsed.variantId);
    const before = await lockLevel(trx, parsed.variantId);

    let current: StockLevel = { onHand: before.onHand, reserved: before.reserved };
    let appliedAny = false;

    for (const movement of movementsForTransition(parsed.effect, parsed.quantity)) {
      // onConflictDoNothing => idempotência: movimento já existente não é
      // revalidado nem reaplicado. Se applyMovement lançar após um insert
      // novo, a transação desfaz tudo (atomicidade).
      const inserted = await trx
        .insert(stockMovements)
        .values({
          productVariantId: parsed.variantId,
          type: movement.type,
          quantityDelta: movement.quantityDelta,
          referenceType: parsed.referenceType,
          referenceId: parsed.referenceId,
          idempotencyKey: `${movement.type}:${parsed.referenceId}:${parsed.variantId}`,
          createdBy: parsed.createdBy ?? null,
        })
        .onConflictDoNothing({ target: stockMovements.idempotencyKey })
        .returning({ id: stockMovements.id });

      if (inserted.length > 0) {
        current = applyMovement(current, movement);
        appliedAny = true;
      }
    }

    if (appliedAny) {
      await updateLevel(trx, parsed.variantId, current);
      await maybeEnqueueLowStock(
        trx,
        parsed.variantId,
        before,
        current,
        before.lowStockThreshold,
      );
    }

    return { applied: appliedAny, onHand: current.onHand, reserved: current.reserved };
  });
}

// ---------------------------------------------------------------------------
// 4. getStockOverview
// ---------------------------------------------------------------------------

export interface StockOverviewRow {
  variantId: string;
  sku: string;
  productName: string;
  onHand: number;
  reserved: number;
  available: number;
  lowStockThreshold: number;
  low: boolean;
}

export async function getStockOverview(db: DbOrTx): Promise<StockOverviewRow[]> {
  const lowExpr = sql`(coalesce(${stockLevels.onHand}, 0) - coalesce(${stockLevels.reserved}, 0)) <= coalesce(${stockLevels.lowStockThreshold}, 3)`;

  const rows = await db
    .select({
      variantId: productVariants.id,
      sku: productVariants.sku,
      productName: products.name,
      onHand: sql<number>`coalesce(${stockLevels.onHand}, 0)`,
      reserved: sql<number>`coalesce(${stockLevels.reserved}, 0)`,
      lowStockThreshold: sql<number>`coalesce(${stockLevels.lowStockThreshold}, 3)`,
    })
    .from(productVariants)
    .innerJoin(products, eq(productVariants.productId, products.id))
    .leftJoin(stockLevels, eq(stockLevels.productVariantId, productVariants.id))
    .where(
      and(
        eq(productVariants.isActive, true),
        isNull(productVariants.deletedAt),
        isNull(products.deletedAt),
      ),
    )
    .orderBy(desc(lowExpr), asc(products.name), asc(productVariants.sku));

  return rows.map((row) => {
    const onHand = Number(row.onHand);
    const reserved = Number(row.reserved);
    const lowStockThreshold = Number(row.lowStockThreshold);
    return {
      variantId: row.variantId,
      sku: row.sku,
      productName: row.productName,
      onHand,
      reserved,
      available: onHand - reserved,
      lowStockThreshold,
      low: isLowStock({ onHand, reserved }, lowStockThreshold),
    };
  });
}

// ---------------------------------------------------------------------------
// 5. listMovements
// ---------------------------------------------------------------------------

const listMovementsSchema = z.object({
  variantId: z.uuid(),
  limit: z.number().int().positive().max(500).default(50),
});

export type ListMovementsInput = z.input<typeof listMovementsSchema>;

export async function listMovements(db: DbOrTx, input: ListMovementsInput) {
  const parsed = listMovementsSchema.parse(input);

  return db
    .select()
    .from(stockMovements)
    .where(eq(stockMovements.productVariantId, parsed.variantId))
    .orderBy(desc(stockMovements.createdAt), desc(stockMovements.id))
    .limit(parsed.limit);
}
