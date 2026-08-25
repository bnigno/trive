import { and, desc, eq, or, sql } from "drizzle-orm";
import { z } from "zod";

import {
  assertTransition,
  ORDER_STATUSES,
  requiredStockEffect,
  timestampFieldFor,
  type OrderStatus,
  type StockEffect,
} from "@/core/orders/state-machine";
import { computeOrderTotals } from "@/core/orders/totals";
import {
  auditLog,
  customers,
  financialEntries,
  orderItems,
  orders,
  orderStatusHistory,
  priceVersions,
  products,
  productVariants,
} from "@/db/schema";
import { enqueueOutboxEvent, type DbOrTx } from "@/queue/enqueue";
import { applyStockEffectTx, ServiceError } from "@/services/stock";

export { ServiceError };

// ---------------------------------------------------------------------------
// createManualOrder
// ---------------------------------------------------------------------------

const createManualOrderSchema = z.object({
  customerId: z.uuid(),
  items: z
    .array(
      z.object({
        variantId: z.uuid(),
        quantity: z.number().int().positive(),
        unitPriceCentsOverride: z.number().int().nonnegative().optional(),
      }),
    )
    .min(1, "Informe ao menos um item para o pedido."),
  discountCents: z.number().int().nonnegative().default(0),
  shippingCents: z.number().int().nonnegative().default(0),
  note: z.string().max(2000).optional(),
  userId: z.uuid(),
});

export type CreateManualOrderInput = z.input<typeof createManualOrderSchema>;

export async function createManualOrder(
  db: DbOrTx,
  input: CreateManualOrderInput,
): Promise<{ orderId: string; orderNumber: number }> {
  const parsed = createManualOrderSchema.parse(input);

  return db.transaction(async (tx) => {
    const [customer] = await tx
      .select({ id: customers.id })
      .from(customers)
      .where(eq(customers.id, parsed.customerId));
    if (!customer) {
      throw new ServiceError("CUSTOMER_NOT_FOUND", "Cliente não encontrado.");
    }

    const itemRows: {
      productVariantId: string;
      skuSnapshot: string;
      nameSnapshot: string;
      quantity: number;
      unitPriceCents: number;
      unitCostCents: number;
      priceVersionId: string | null;
      totalCents: number;
    }[] = [];

    for (const item of parsed.items) {
      const [variant] = await tx
        .select({
          id: productVariants.id,
          sku: productVariants.sku,
          costCents: productVariants.costCents,
          productName: products.name,
        })
        .from(productVariants)
        .innerJoin(products, eq(products.id, productVariants.productId))
        .where(eq(productVariants.id, item.variantId));
      if (!variant) {
        throw new ServiceError(
          "VARIANT_NOT_FOUND",
          "Variação de produto não encontrada para um dos itens.",
        );
      }

      const [activePrice] = await tx
        .select({
          id: priceVersions.id,
          priceCents: priceVersions.priceCents,
        })
        .from(priceVersions)
        .where(
          and(
            eq(priceVersions.productVariantId, item.variantId),
            eq(priceVersions.status, "active"),
          ),
        );

      const unitPriceCents =
        item.unitPriceCentsOverride ?? activePrice?.priceCents;
      if (unitPriceCents === undefined) {
        throw new ServiceError(
          "NO_ACTIVE_PRICE",
          `Sem preço ativo: defina um preço para o SKU ${variant.sku} ou informe um valor manual.`,
        );
      }

      itemRows.push({
        productVariantId: variant.id,
        skuSnapshot: variant.sku,
        nameSnapshot: variant.productName,
        quantity: item.quantity,
        unitPriceCents,
        unitCostCents: variant.costCents,
        priceVersionId: activePrice?.id ?? null,
        totalCents: unitPriceCents * item.quantity,
      });
    }

    const totals = computeOrderTotals(
      itemRows.map((r) => ({
        unitPriceCents: r.unitPriceCents,
        quantity: r.quantity,
      })),
      parsed.discountCents,
      parsed.shippingCents,
    );

    const [order] = await tx
      .insert(orders)
      .values({
        customerId: parsed.customerId,
        status: "draft",
        channel: "manual",
        subtotalCents: totals.subtotalCents,
        discountCents: parsed.discountCents,
        shippingCents: parsed.shippingCents,
        totalCents: totals.totalCents,
        note: parsed.note ?? null,
        createdBy: parsed.userId,
      })
      .returning({ id: orders.id, orderNumber: orders.orderNumber });

    await tx
      .insert(orderItems)
      .values(itemRows.map((r) => ({ ...r, orderId: order.id })));

    await tx.insert(orderStatusHistory).values({
      orderId: order.id,
      fromStatus: null,
      toStatus: "draft",
      changedBy: parsed.userId,
    });

    await tx.insert(auditLog).values({
      actorType: "user",
      actorId: parsed.userId,
      action: "order.create",
      entityType: "order",
      entityId: order.id,
      after: {
        orderNumber: order.orderNumber,
        status: "draft",
        channel: "manual",
        customerId: parsed.customerId,
        subtotalCents: totals.subtotalCents,
        discountCents: parsed.discountCents,
        shippingCents: parsed.shippingCents,
        totalCents: totals.totalCents,
        items: itemRows.map((r) => ({
          sku: r.skuSnapshot,
          quantity: r.quantity,
          unitPriceCents: r.unitPriceCents,
        })),
      },
    });

    return { orderId: order.id, orderNumber: order.orderNumber };
  });
}

// ---------------------------------------------------------------------------
// transitionOrder
// ---------------------------------------------------------------------------

const transitionOrderSchema = z.object({
  orderId: z.uuid(),
  to: z.enum(ORDER_STATUSES),
  userId: z.uuid(),
  reason: z.string().min(1).max(2000).optional(),
  /** Só para canceled/refunded pós-consumo: devolver fisicamente ao estoque. */
  restock: z.boolean().optional(),
});

export type TransitionOrderInput = z.input<typeof transitionOrderSchema>;

/** Status em que o estoque já foi consumido (baixa definitiva feita). */
const POST_CONSUMPTION_STATUSES: readonly OrderStatus[] = [
  "paid",
  "preparing",
  "shipped",
  "delivered",
];

const TIMESTAMP_COLUMN = {
  paid_at: "paidAt",
  shipped_at: "shippedAt",
  delivered_at: "deliveredAt",
  canceled_at: "canceledAt",
} as const;

export async function transitionOrder(
  db: DbOrTx,
  input: TransitionOrderInput,
): Promise<{
  orderId: string;
  orderNumber: number;
  from: OrderStatus;
  to: OrderStatus;
  idempotent: boolean;
}> {
  const parsed = transitionOrderSchema.parse(input);

  return db.transaction(async (tx) => {
    const [order] = await tx
      .select()
      .from(orders)
      .where(eq(orders.id, parsed.orderId))
      .for("update");
    if (!order) {
      throw new ServiceError("ORDER_NOT_FOUND", "Pedido não encontrado.");
    }

    const from = order.status as OrderStatus;
    const to = parsed.to;

    // Retry idempotente: pedido já está no status alvo — nada a fazer.
    if (from === to) {
      return {
        orderId: order.id,
        orderNumber: order.orderNumber,
        from,
        to,
        idempotent: true,
      };
    }

    assertTransition(from, to);

    const fromPostConsumption = POST_CONSUMPTION_STATUSES.includes(from);
    if (to === "canceled" && fromPostConsumption && !parsed.reason) {
      throw new ServiceError(
        "REASON_REQUIRED",
        "Informe o motivo para cancelar um pedido já pago.",
      );
    }

    // Efeito de estoque intrínseco à transição (reserve/consume/release).
    // Cancelamento de pending_payment SEMPRE libera a reserva (não é opcional).
    let effect: StockEffect | null = requiredStockEffect(from, to);
    if (
      effect === null &&
      parsed.restock === true &&
      (to === "canceled" || to === "refunded") &&
      fromPostConsumption
    ) {
      // Devolução física ao estoque em cancelamento pós-consumo/reembolso.
      effect = "return";
    }

    if (effect !== null) {
      const items = await tx
        .select({
          productVariantId: orderItems.productVariantId,
          quantity: orderItems.quantity,
        })
        .from(orderItems)
        .where(eq(orderItems.orderId, order.id));
      for (const item of items) {
        await applyStockEffectTx(tx, {
          effect,
          variantId: item.productVariantId,
          quantity: item.quantity,
          referenceType: "order",
          referenceId: order.id,
          createdBy: parsed.userId,
        });
      }
    }

    const now = new Date();
    const updateSet: Partial<typeof orders.$inferInsert> = {
      status: to,
      updatedAt: now,
    };
    const tsField = timestampFieldFor(to);
    if (tsField) updateSet[TIMESTAMP_COLUMN[tsField]] = now;
    if (to === "canceled" && parsed.reason) {
      updateSet.cancelReason = parsed.reason;
    }
    await tx.update(orders).set(updateSet).where(eq(orders.id, order.id));

    await tx.insert(orderStatusHistory).values({
      orderId: order.id,
      fromStatus: from,
      toStatus: to,
      changedBy: parsed.userId,
      reason: parsed.reason ?? null,
    });

    // Lançamentos financeiros derivados da transição.
    if (to === "paid" && order.totalCents > 0) {
      await tx.insert(financialEntries).values({
        direction: "receivable",
        category: "sale",
        description: `Pedido #${order.orderNumber}`,
        amountCents: order.totalCents,
        status: "settled",
        settledAt: now,
        orderId: order.id,
        createdBy: parsed.userId,
      });
    }
    if (to === "refunded" && order.totalCents > 0) {
      await tx.insert(financialEntries).values({
        direction: "payable",
        category: "refund",
        description: `Reembolso do pedido #${order.orderNumber}`,
        amountCents: order.totalCents,
        status: "pending",
        orderId: order.id,
        createdBy: parsed.userId,
      });
    }

    await enqueueOutboxEvent(tx, {
      eventType: `order.${to}`,
      dedupeKey: `order.${to}:${order.id}`,
      aggregateType: "order",
      aggregateId: order.id,
      payload: {
        orderId: order.id,
        orderNumber: order.orderNumber,
        totalCents: order.totalCents,
        customerId: order.customerId,
      },
    });

    await tx.insert(auditLog).values({
      actorType: "user",
      actorId: parsed.userId,
      action: "order.transition",
      entityType: "order",
      entityId: order.id,
      before: { status: from },
      after: { status: to, stockEffect: effect },
      reason: parsed.reason ?? null,
    });

    return {
      orderId: order.id,
      orderNumber: order.orderNumber,
      from,
      to,
      idempotent: false,
    };
  });
}

// ---------------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------------

export async function getOrderDetail(db: DbOrTx, orderId: string) {
  const parsedId = z.uuid().parse(orderId);

  const [order] = await db
    .select()
    .from(orders)
    .where(eq(orders.id, parsedId));
  if (!order) return null;

  const [customer] = await db
    .select({
      id: customers.id,
      fullName: customers.fullName,
      email: customers.email,
      phoneE164: customers.phoneE164,
    })
    .from(customers)
    .where(eq(customers.id, order.customerId));

  const items = await db
    .select()
    .from(orderItems)
    .where(eq(orderItems.orderId, order.id));

  const history = await db
    .select()
    .from(orderStatusHistory)
    .where(eq(orderStatusHistory.orderId, order.id))
    .orderBy(orderStatusHistory.createdAt, orderStatusHistory.id);

  return { ...order, customer: customer ?? null, items, history };
}

const listOrdersSchema = z.object({
  status: z.enum(ORDER_STATUSES).optional(),
  search: z.string().min(1).max(200).optional(),
  limit: z.number().int().positive().max(200).default(50),
});

export type ListOrdersInput = z.input<typeof listOrdersSchema>;

export async function listOrders(db: DbOrTx, input: ListOrdersInput = {}) {
  const parsed = listOrdersSchema.parse(input);

  const conditions = [];
  if (parsed.status) conditions.push(eq(orders.status, parsed.status));
  if (parsed.search) {
    const term = parsed.search.trim();
    const asNumber = Number(term.replace(/^#/, ""));
    const searchConditions = [
      sql`${customers.fullName} ILIKE ${`%${term}%`}`,
    ];
    if (Number.isSafeInteger(asNumber) && asNumber > 0) {
      searchConditions.push(eq(orders.orderNumber, asNumber));
    }
    conditions.push(or(...searchConditions));
  }

  return db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      status: orders.status,
      channel: orders.channel,
      totalCents: orders.totalCents,
      createdAt: orders.createdAt,
      customerId: orders.customerId,
      customerName: customers.fullName,
    })
    .from(orders)
    .innerJoin(customers, eq(customers.id, orders.customerId))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(orders.createdAt), desc(orders.orderNumber))
    .limit(parsed.limit);
}
