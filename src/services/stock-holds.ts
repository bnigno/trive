// Reserva gentil: a vendedora (ou o dono) segura UMA combinação para um
// telefone por algumas horas, sem pedido. O estoque continua no ledger
// (movimento 'reservation' com reference_type='hold', idempotente por chave),
// então o disponível do catálogo já desconta a reserva. Uma reserva ativa por
// telefone — o banco arbitra (unique parcial). Expiração e lembrete rodam no
// cron hold-expiry; o pedido que leva a peça converte a reserva na mesma
// transação (consumeMatchingHoldsTx).
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, isNull, lt } from "drizzle-orm";
import { z } from "zod";

import type { MessagingProvider } from "@/adapters/zapi";
import { variantLabel } from "@/core/catalog/attributes";
import {
  describeHold,
  HOLD_DEFAULT_TTL_HOURS,
  HOLD_MAX_QUANTITY,
  HOLD_REMINDER_BEFORE_MS,
  formatHoldDeadline,
  isReminderDue,
} from "@/core/stock/holds";
import { InsufficientStockError } from "@/core/stock/ledger";
import {
  auditLog,
  customers,
  products,
  productVariants,
  settings,
  stockHolds,
  stockLevels,
} from "@/db/schema";
import { siteUrl } from "@/lib/site-url";
import type { DbOrTx } from "@/queue/enqueue";
import { applyStockEffectTx } from "@/services/stock";
import { sendTemplateMessage, type SendWaMessageResult } from "@/services/wa-messaging";

export type HoldErrorCode = "HOLD_ATIVA" | "SEM_ESTOQUE" | "VARIANTE_INEXISTENTE";

export class HoldError extends Error {
  readonly code: HoldErrorCode;
  constructor(code: HoldErrorCode, message: string) {
    super(message);
    this.name = "HoldError";
    this.code = code;
  }
}

export const HOLD_REMINDER_TEMPLATE_KEY = "hold_reminder";

const E164 = /^\+[1-9]\d{7,14}$/;

export interface HoldView {
  id: string;
  variantId: string;
  sku: string;
  productName: string;
  productSlug: string;
  variantLabel: string;
  quantity: number;
  status: string;
  phoneE164: string;
  customerId: string | null;
  expiresAt: Date;
  reminderSentAt: Date | null;
  createdBy: string;
  createdAt: Date;
  description: string;
}

/** Setting hold_ttl_hours (1–168); ausente = 24 h. */
export async function holdTtlHours(db: DbOrTx): Promise<number> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, "hold_ttl_hours"))
    .limit(1);
  const value = Number(row?.value);
  return Number.isFinite(value) && value >= 1 ? Math.min(value, 168) : HOLD_DEFAULT_TTL_HOURS;
}

async function loadVariantInfo(db: DbOrTx, variantId: string) {
  const [row] = await db
    .select({
      id: productVariants.id,
      sku: productVariants.sku,
      attributes: productVariants.attributes,
      productName: products.name,
      productSlug: products.slug,
      attributesSchema: products.attributesSchema,
      onHand: stockLevels.onHand,
      reserved: stockLevels.reserved,
    })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .leftJoin(stockLevels, eq(stockLevels.productVariantId, productVariants.id))
    .where(and(eq(productVariants.id, variantId), isNull(productVariants.deletedAt)))
    .limit(1);
  if (!row) return null;
  const axes = Array.isArray(row.attributesSchema) ? (row.attributesSchema as string[]) : [];
  return {
    id: row.id,
    sku: row.sku,
    productName: row.productName,
    productSlug: row.productSlug,
    variantLabel: variantLabel((row.attributes ?? {}) as Record<string, string>, axes),
    available: (row.onHand ?? 0) - (row.reserved ?? 0),
  };
}

function toView(row: {
  id: string;
  productVariantId: string;
  sku: string;
  productName: string;
  productSlug: string;
  attributes: unknown;
  attributesSchema: unknown;
  quantity: number;
  status: string;
  phoneE164: string;
  customerId: string | null;
  expiresAt: Date;
  reminderSentAt: Date | null;
  createdBy: string;
  createdAt: Date;
}): HoldView {
  const axes = Array.isArray(row.attributesSchema) ? (row.attributesSchema as string[]) : [];
  const label = variantLabel((row.attributes ?? {}) as Record<string, string>, axes);
  return {
    id: row.id,
    variantId: row.productVariantId,
    sku: row.sku,
    productName: row.productName,
    productSlug: row.productSlug,
    variantLabel: label,
    quantity: row.quantity,
    status: row.status,
    phoneE164: row.phoneE164,
    customerId: row.customerId,
    expiresAt: row.expiresAt,
    reminderSentAt: row.reminderSentAt,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    description: describeHold({
      productName: row.productName,
      variantLabel: label,
      quantity: row.quantity,
      expiresAt: row.expiresAt,
    }),
  };
}

const holdSelect = {
  id: stockHolds.id,
  productVariantId: stockHolds.productVariantId,
  sku: productVariants.sku,
  productName: products.name,
  productSlug: products.slug,
  attributes: productVariants.attributes,
  attributesSchema: products.attributesSchema,
  quantity: stockHolds.quantity,
  status: stockHolds.status,
  phoneE164: stockHolds.phoneE164,
  customerId: stockHolds.customerId,
  expiresAt: stockHolds.expiresAt,
  reminderSentAt: stockHolds.reminderSentAt,
  createdBy: stockHolds.createdBy,
  createdAt: stockHolds.createdAt,
};

function holdsQuery(db: DbOrTx) {
  return db
    .select(holdSelect)
    .from(stockHolds)
    .innerJoin(productVariants, eq(productVariants.id, stockHolds.productVariantId))
    .innerJoin(products, eq(products.id, productVariants.productId));
}

// ---------------------------------------------------------------------------
// createStockHold
// ---------------------------------------------------------------------------

const createHoldSchema = z.object({
  variantId: z.uuid(),
  phoneE164: z.string().regex(E164, "Telefone deve estar em E.164."),
  customerId: z.uuid().nullable().optional(),
  conversationId: z.uuid().nullable().optional(),
  quantity: z.number().int().min(1).max(HOLD_MAX_QUANTITY).default(1),
  createdBy: z.enum(["lia", "admin"]).default("lia"),
  /** Prazo em horas; omitido = setting hold_ttl_hours (24). */
  ttlHours: z.number().int().min(1).max(168).optional(),
  /** Usuário do painel (audit) quando createdBy = 'admin'. */
  userId: z.uuid().optional(),
});

export type CreateStockHoldInput = z.input<typeof createHoldSchema>;

export async function createStockHold(db: DbOrTx, input: CreateStockHoldInput): Promise<HoldView> {
  const parsed = createHoldSchema.parse(input);
  const ttl = parsed.ttlHours ?? (await holdTtlHours(db));

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: stockHolds.id })
      .from(stockHolds)
      .where(and(eq(stockHolds.phoneE164, parsed.phoneE164), eq(stockHolds.status, "active")))
      .for("update")
      .limit(1);
    if (existing) {
      const [view] = await holdsQuery(tx).where(eq(stockHolds.id, existing.id)).limit(1);
      throw new HoldError(
        "HOLD_ATIVA",
        `Esta cliente já tem uma reserva ativa: ${view ? toView(view).description : existing.id}. Libere-a antes de segurar outra peça.`,
      );
    }

    const info = await loadVariantInfo(tx, parsed.variantId);
    if (!info) throw new HoldError("VARIANTE_INEXISTENTE", "Combinação não encontrada.");

    const holdId = randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttl * 3_600_000);
    await tx.insert(stockHolds).values({
      id: holdId,
      productVariantId: parsed.variantId,
      phoneE164: parsed.phoneE164,
      customerId: parsed.customerId ?? null,
      conversationId: parsed.conversationId ?? null,
      quantity: parsed.quantity,
      status: "active",
      expiresAt,
      createdBy: parsed.createdBy,
    });

    try {
      await applyStockEffectTx(tx, {
        effect: "reserve",
        variantId: parsed.variantId,
        quantity: parsed.quantity,
        referenceType: "hold",
        referenceId: holdId,
        ...(parsed.userId ? { createdBy: parsed.userId } : {}),
      });
    } catch (error) {
      if (error instanceof InsufficientStockError) {
        throw new HoldError(
          "SEM_ESTOQUE",
          `${info.productName}${info.variantLabel ? ` (${info.variantLabel})` : ""} não tem ${parsed.quantity} disponível para segurar (disponível: ${info.available}).`,
        );
      }
      throw error;
    }

    await tx.insert(auditLog).values({
      actorType: parsed.createdBy === "admin" ? "user" : "system",
      actorId: parsed.userId ?? null,
      action: "stock.hold_create",
      entityType: "stock_hold",
      entityId: holdId,
      after: {
        variantId: parsed.variantId,
        sku: info.sku,
        quantity: parsed.quantity,
        expiresAt: expiresAt.toISOString(),
        createdBy: parsed.createdBy,
        phoneE164: parsed.phoneE164,
      },
    });

    const [view] = await holdsQuery(tx).where(eq(stockHolds.id, holdId)).limit(1);
    return toView(view);
  });
}

// ---------------------------------------------------------------------------
// releaseStockHold / consumeMatchingHoldsTx / expireOverdueHolds
// ---------------------------------------------------------------------------

const releaseHoldSchema = z.object({
  holdId: z.uuid(),
  reason: z.enum(["released", "expired", "converted"]),
  orderId: z.uuid().optional(),
  userId: z.uuid().optional(),
});

export type ReleaseStockHoldInput = z.input<typeof releaseHoldSchema>;

/** Idempotente: reserva que não está ativa não é liberada de novo. */
export async function releaseStockHold(
  db: DbOrTx,
  input: ReleaseStockHoldInput,
): Promise<{ released: boolean; status: string }> {
  const parsed = releaseHoldSchema.parse(input);
  return db.transaction(async (tx) => {
    const [hold] = await tx
      .select({
        id: stockHolds.id,
        status: stockHolds.status,
        variantId: stockHolds.productVariantId,
        quantity: stockHolds.quantity,
      })
      .from(stockHolds)
      .where(eq(stockHolds.id, parsed.holdId))
      .for("update")
      .limit(1);
    if (!hold) return { released: false, status: "inexistente" };
    if (hold.status !== "active") return { released: false, status: hold.status };

    await applyStockEffectTx(tx, {
      effect: "release",
      variantId: hold.variantId,
      quantity: hold.quantity,
      referenceType: "hold",
      referenceId: hold.id,
      ...(parsed.userId ? { createdBy: parsed.userId } : {}),
    });
    const now = new Date();
    await tx
      .update(stockHolds)
      .set({
        status: parsed.reason,
        releasedAt: now,
        ...(parsed.orderId ? { orderId: parsed.orderId } : {}),
        updatedAt: now,
      })
      .where(eq(stockHolds.id, hold.id));
    await tx.insert(auditLog).values({
      actorType: parsed.userId ? "user" : "system",
      actorId: parsed.userId ?? null,
      action: "stock.hold_release",
      entityType: "stock_hold",
      entityId: hold.id,
      before: { status: "active" },
      after: { status: parsed.reason, orderId: parsed.orderId ?? null },
    });
    return { released: true, status: parsed.reason };
  });
}

/**
 * Gancho do pedido: reservas ativas deste telefone cujas peças entraram no
 * pedido viram 'converted' (a reserva da peça é liberada aqui e o próprio
 * pedido reserva em seguida, na mesma transação).
 */
export async function consumeMatchingHoldsTx(
  tx: DbOrTx,
  input: { phoneE164: string | null; variantIds: string[]; orderId: string },
): Promise<number> {
  if (!input.phoneE164 || input.variantIds.length === 0) return 0;
  const matching = await tx
    .select({ id: stockHolds.id })
    .from(stockHolds)
    .where(
      and(
        eq(stockHolds.phoneE164, input.phoneE164),
        eq(stockHolds.status, "active"),
        inArray(stockHolds.productVariantId, input.variantIds),
      ),
    );
  let converted = 0;
  for (const hold of matching) {
    const result = await releaseStockHold(tx, { holdId: hold.id, reason: "converted", orderId: input.orderId });
    if (result.released) converted += 1;
  }
  return converted;
}

export async function expireOverdueHolds(
  db: DbOrTx,
  input: { now?: Date; limit?: number } = {},
): Promise<{ expired: number }> {
  const now = input.now ?? new Date();
  const overdue = await db
    .select({ id: stockHolds.id })
    .from(stockHolds)
    .where(and(eq(stockHolds.status, "active"), lt(stockHolds.expiresAt, now)))
    .orderBy(asc(stockHolds.expiresAt))
    .limit(input.limit ?? 100);
  let expired = 0;
  for (const row of overdue) {
    const result = await releaseStockHold(db, { holdId: row.id, reason: "expired" });
    if (result.released) expired += 1;
  }
  return { expired };
}

// ---------------------------------------------------------------------------
// remindExpiringHolds — lembrete único 2 h antes de vencer
// ---------------------------------------------------------------------------

function firstName(fullName: string | null | undefined): string {
  return (fullName ?? "").trim().split(/\s+/)[0] ?? "";
}

export async function remindExpiringHolds(
  db: DbOrTx,
  provider: MessagingProvider,
  input: { now?: Date } = {},
): Promise<{ reminded: number; skipped: number }> {
  const now = input.now ?? new Date();
  const rows = await holdsQuery(db)
    .where(
      and(
        eq(stockHolds.status, "active"),
        isNull(stockHolds.reminderSentAt),
        gte(stockHolds.expiresAt, now),
        lt(stockHolds.expiresAt, new Date(now.getTime() + HOLD_REMINDER_BEFORE_MS)),
      ),
    )
    .orderBy(asc(stockHolds.expiresAt))
    .limit(50);

  let reminded = 0;
  let skipped = 0;
  for (const row of rows) {
    if (!isReminderDue({ status: row.status, expiresAt: row.expiresAt, reminderSentAt: row.reminderSentAt }, now)) {
      continue;
    }
    const view = toView(row);
    const [customer] = await db
      .select({ id: customers.id, fullName: customers.fullName })
      .from(customers)
      .where(and(eq(customers.phoneE164, row.phoneE164), isNull(customers.deletedAt)))
      .limit(1);
    const result: SendWaMessageResult = await sendTemplateMessage(db, provider, {
      templateKey: HOLD_REMINDER_TEMPLATE_KEY,
      phoneE164: row.phoneE164,
      vars: {
        nome: firstName(customer?.fullName),
        produto: `${view.productName}${view.variantLabel ? ` (${view.variantLabel})` : ""}`,
        prazo: formatHoldDeadline(row.expiresAt),
        link: `${siteUrl()}/produto/${view.productSlug}`,
      },
      ...(customer ? { customerId: customer.id } : {}),
      dedupeKey: `wa.hold_reminder:${row.id}`,
      requireOptIn: true,
    });
    // Marca mesmo quando pulou (sem opt-in, desligado): lembrete é único.
    await db
      .update(stockHolds)
      .set({ reminderSentAt: now, updatedAt: now })
      .where(eq(stockHolds.id, row.id));
    if ("sent" in result) reminded += 1;
    else skipped += 1;
  }
  return { reminded, skipped };
}

// ---------------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------------

export async function getActiveHoldByPhone(db: DbOrTx, phoneE164: string): Promise<HoldView | null> {
  const [row] = await holdsQuery(db)
    .where(and(eq(stockHolds.phoneE164, phoneE164), eq(stockHolds.status, "active")))
    .limit(1);
  return row ? toView(row) : null;
}

export async function listHoldsByCustomer(
  db: DbOrTx,
  input: { customerId?: string | null; phoneE164?: string | null; limit?: number },
): Promise<HoldView[]> {
  const conditions = [];
  if (input.customerId) conditions.push(eq(stockHolds.customerId, input.customerId));
  if (input.phoneE164) conditions.push(eq(stockHolds.phoneE164, input.phoneE164));
  if (conditions.length === 0) return [];
  const rows = await holdsQuery(db)
    .where(conditions.length === 1 ? conditions[0] : and(...conditions))
    .orderBy(desc(stockHolds.createdAt))
    .limit(input.limit ?? 10);
  return rows.map(toView);
}

export async function listHoldsByVariant(db: DbOrTx, variantId: string, limit = 20): Promise<HoldView[]> {
  const rows = await holdsQuery(db)
    .where(eq(stockHolds.productVariantId, variantId))
    .orderBy(desc(stockHolds.createdAt))
    .limit(limit);
  return rows.map(toView);
}
