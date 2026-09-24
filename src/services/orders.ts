import { and, desc, eq, ne, or, sql } from "drizzle-orm";
import { z } from "zod";

import {
  assertTransition,
  ORDER_STATUSES,
  requiredStockEffect,
  timestampFieldFor,
  type OrderStatus,
  type StockEffect,
} from "@/core/orders/state-machine";
import { needsPackingBeforeDispatch, NOT_PACKED_CODE, notPackedMessage } from "@/core/orders/packing";
import { initialRefundState, isAutomaticRefund } from "@/core/orders/refunds";
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
import {
  quoteCoupon,
  redeemCouponInTx,
  releaseCouponRedemptionInTx,
  ServiceError as CouponServiceError,
  type CouponQuote,
} from "@/services/coupons";
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
  /** Desconto digitado à mão (fora de cupom); soma ao desconto do cupom. */
  discountCents: z.number().int().nonnegative().default(0),
  shippingCents: z.number().int().nonnegative().default(0),
  /** Cupom honrado nesta venda (as mesmas regras do site). */
  couponCode: z.string().trim().optional(),
  /**
   * A dona mandou aplicar o cupom apesar da regra (vencido, já usado, de
   * outra cliente). Fica registrado no audit com as regras puladas.
   */
  forceCoupon: z.boolean().default(false),
  /** Tipo da entrega cobrada — só serve ao escopo do cupom de frete grátis. */
  shippingKind: z.enum(["motoboy", "correios"]).default("motoboy"),
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
    // O telefone vem junto: as regras por cliente do cupom (pessoal, primeira
    // compra, limite) precisam saber quem está comprando.
    const [customer] = await tx
      .select({ id: customers.id, phoneE164: customers.phoneE164 })
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

    // Cupom: cotado ANTES de qualquer escrita, com o preço que ESTE pedido vai
    // cobrar (a venda manual pode ter preço digitado). Recusa derruba tudo com
    // a frase do motor; `forceCoupon` pula a regra e registra qual foi.
    let coupon: CouponQuote | null = null;
    if (parsed.couponCode !== undefined && parsed.couponCode !== "") {
      try {
        coupon = await quoteCoupon(tx, {
          code: parsed.couponCode,
          items: itemRows.map((r) => ({
            variantId: r.productVariantId,
            quantity: r.quantity,
            unitPriceCentsOverride: r.unitPriceCents,
          })),
          identity: { customerId: customer.id, phoneE164: customer.phoneE164 },
          shipping:
            parsed.shippingCents > 0 ? { cents: parsed.shippingCents, kind: parsed.shippingKind } : null,
          force: parsed.forceCoupon,
        });
      } catch (error) {
        if (error instanceof CouponServiceError) {
          throw new ServiceError(error.code, error.message);
        }
        throw error;
      }
    }

    // Frete grátis do cupom abate o frete digitado; o perdoado fica no resgate.
    const shippingDiscountCents = Math.min(coupon?.shippingDiscountCents ?? 0, parsed.shippingCents);
    const chargedShippingCents = parsed.shippingCents - shippingDiscountCents;
    // Os dois descontos convivem: o do cupom e o que a dona digitou.
    const couponDiscountCents = coupon?.discountCents ?? 0;
    const discountCents = couponDiscountCents + parsed.discountCents;

    const totals = computeOrderTotals(
      itemRows.map((r) => ({
        unitPriceCents: r.unitPriceCents,
        quantity: r.quantity,
      })),
      discountCents,
      chargedShippingCents,
    );

    const [order] = await tx
      .insert(orders)
      .values({
        customerId: parsed.customerId,
        status: "draft",
        channel: "manual",
        subtotalCents: totals.subtotalCents,
        discountCents,
        couponId: coupon?.couponId ?? null,
        couponCode: coupon?.code ?? null,
        shippingCents: chargedShippingCents,
        totalCents: totals.totalCents,
        note: parsed.note ?? null,
        createdBy: parsed.userId,
      })
      .returning({ id: orders.id, orderNumber: orders.orderNumber });

    await tx
      .insert(orderItems)
      .values(itemRows.map((r) => ({ ...r, orderId: order.id })));

    // Consome 1 uso na MESMA transação: se o guard falhar (último uso perdido
    // para outro pedido), o pedido inteiro desfaz.
    if (coupon) {
      try {
        await redeemCouponInTx(
          tx,
          {
            couponId: coupon.couponId,
            orderId: order.id,
            customerId: customer.id,
            phoneE164: customer.phoneE164,
            code: coupon.code,
            discountCents: couponDiscountCents,
            shippingDiscountCents,
            appliedValue: coupon.appliedValue,
          },
          { force: parsed.forceCoupon },
        );
      } catch (error) {
        if (error instanceof CouponServiceError) {
          throw new ServiceError(error.code, error.message);
        }
        throw error;
      }
    }

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
        discountCents,
        couponCode: coupon?.code ?? null,
        couponDiscountCents,
        manualDiscountCents: parsed.discountCents,
        shippingCents: chargedShippingCents,
        shippingDiscountCents,
        totalCents: totals.totalCents,
        // Regras que a dona mandou pular (vazio quando o cupom valia mesmo).
        ...(coupon && coupon.forced.length > 0
          ? { forced: coupon.forced, forcedBy: parsed.userId }
          : {}),
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
  /** uuid do usuário, ou null para ações do SISTEMA (ex.: expiração de reserva). */
  userId: z.uuid().nullable(),
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
          createdBy: parsed.userId ?? undefined,
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
    // O dinheiro tem estado próprio: 'refunded' diz que a venda caiu, isto diz
    // se o valor voltou. Nasce aqui para o handler de order.refunded saber se
    // pode avisar a cliente agora ou se deve esperar o vendor responder.
    const refundRoute = { paymentMethod: order.paymentMethod, mpPaymentId: order.mpPaymentId };
    if (to === "refunded") {
      updateSet.refundState = initialRefundState(refundRoute);
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
    // paid = settle-or-skip-or-insert: pedido cash já nasce com receivable
    // sale PENDENTE (createStoreOrder) — liquidar a MESMA entry em vez de
    // inserir outra; se o dono liquidou antes no financeiro, no-op (nunca
    // receita dobrada); sem entry (fluxo MP normal), insere já liquidada.
    if (to === "paid" && order.totalCents > 0) {
      const [existingSale] = await tx
        .select({
          id: financialEntries.id,
          status: financialEntries.status,
        })
        .from(financialEntries)
        .where(
          and(
            eq(financialEntries.orderId, order.id),
            eq(financialEntries.direction, "receivable"),
            eq(financialEntries.category, "sale"),
            ne(financialEntries.status, "canceled"),
          ),
        )
        .limit(1)
        .for("update");
      if (existingSale) {
        if (existingSale.status === "pending") {
          await tx
            .update(financialEntries)
            .set({ status: "settled", settledAt: now, updatedAt: now })
            .where(eq(financialEntries.id, existingSale.id));
        }
      } else {
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
    }
    // Cancelamento: receivables sale PENDENTES do pedido são cancelados
    // (senão a carteira aberta infla para sempre com pedidos cash desistidos).
    if (to === "canceled") {
      await tx
        .update(financialEntries)
        .set({ status: "canceled", updatedAt: now })
        .where(
          and(
            eq(financialEntries.orderId, order.id),
            eq(financialEntries.direction, "receivable"),
            eq(financialEntries.category, "sale"),
            eq(financialEntries.status, "pending"),
          ),
        );
      // Pedido que nunca foi pago devolve o uso do cupom (a cliente não o
      // gastou de verdade). Pago e depois cancelado/reembolsado não devolve.
      if (order.paidAt === null && order.couponId !== null) {
        await releaseCouponRedemptionInTx(tx, order.id);
      }
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

    // Estorno de verdade: só para o que passou pelo Mercado Pago e só quando
    // quem reembolsa é uma PESSOA no painel. Transição vinda do webhook
    // (userId null) significa que o MP já estornou — pedir de novo seria
    // estornar em dobro.
    if (to === "refunded" && parsed.userId !== null && isAutomaticRefund(refundRoute)) {
      await enqueueOutboxEvent(tx, {
        eventType: "payment.refund",
        dedupeKey: `payment.refund:${order.id}`,
        aggregateType: "order",
        aggregateId: order.id,
        payload: { orderId: order.id, mpPaymentId: order.mpPaymentId },
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
      actorType: parsed.userId === null ? "system" : "user",
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
// updateOrderTracking
// ---------------------------------------------------------------------------

const updateOrderTrackingSchema = z.object({
  orderId: z.uuid(),
  trackingCode: z
    .string()
    .trim()
    .min(1, "Informe o código de rastreio.")
    .max(100),
  userId: z.uuid(),
});

export type UpdateOrderTrackingInput = z.input<
  typeof updateOrderTrackingSchema
>;

export async function updateOrderTracking(
  db: DbOrTx,
  input: UpdateOrderTrackingInput,
): Promise<{ orderId: string; trackingCode: string }> {
  const parsed = updateOrderTrackingSchema.parse(input);

  return db.transaction(async (tx) => {
    const [order] = await tx
      .select({
        id: orders.id,
        shippingTrackingCode: orders.shippingTrackingCode,
      })
      .from(orders)
      .where(eq(orders.id, parsed.orderId))
      .for("update");
    if (!order) {
      throw new ServiceError("ORDER_NOT_FOUND", "Pedido não encontrado.");
    }

    await tx
      .update(orders)
      .set({ shippingTrackingCode: parsed.trackingCode, updatedAt: new Date() })
      .where(eq(orders.id, order.id));

    await tx.insert(auditLog).values({
      actorType: "user",
      actorId: parsed.userId,
      action: "order.tracking",
      entityType: "order",
      entityId: order.id,
      before: { shippingTrackingCode: order.shippingTrackingCode },
      after: { shippingTrackingCode: parsed.trackingCode },
    });

    return { orderId: order.id, trackingCode: parsed.trackingCode };
  });
}

const shipOrderSchema = z.object({
  orderId: z.uuid(),
  trackingCode: z.string().trim().min(1).max(100).optional(),
  userId: z.uuid(),
});

export type ShipOrderInput = z.input<typeof shipOrderSchema>;

/**
 * "Marcar como enviado" (Correios/transportadora): só com a foto do pacote
 * (embalar antes de sair — decisão da dona, 2026-09-18). Pedido de motoboy
 * não passa por aqui (é o "Saiu" da Rota do dia). Numa transação só: o
 * rastreio (quando veio) e a transição — nada de rastreio gravado com envio
 * recusado. Idempotente para quem já foi enviado/entregue.
 */
export async function shipOrder(
  db: DbOrTx,
  input: ShipOrderInput,
): Promise<{ orderId: string; orderNumber: number; from: OrderStatus; to: OrderStatus; idempotent: boolean }> {
  const parsed = shipOrderSchema.parse(input);
  return db.transaction(async (tx) => {
    const [order] = await tx
      .select({
        id: orders.id,
        orderNumber: orders.orderNumber,
        status: orders.status,
        deliveryWindow: orders.deliveryWindow,
        packagePhotoPath: orders.packagePhotoPath,
      })
      .from(orders)
      .where(eq(orders.id, parsed.orderId))
      .for("update");
    if (!order) throw new ServiceError("ORDER_NOT_FOUND", "Pedido não encontrado.");
    const from = order.status as OrderStatus;
    const base = { orderId: order.id, orderNumber: order.orderNumber, from };
    if (from === "shipped" || from === "delivered") {
      // Já enviado: só o rastreio novo, se veio — não some em silêncio.
      if (parsed.trackingCode) await updateOrderTracking(tx, { orderId: order.id, trackingCode: parsed.trackingCode, userId: parsed.userId });
      return { ...base, to: from, idempotent: true };
    }
    if (order.deliveryWindow) {
      throw new ServiceError("MOTOBOY_ORDER", "Este pedido é de motoboy — marque a saída pelo botão Saiu (Rota do dia ou ficha).");
    }
    if (from !== "paid" && from !== "preparing") {
      throw new ServiceError("INVALID_TRANSITION", "Só um pedido pago (ou em separação) pode ser marcado como enviado.");
    }
    if (needsPackingBeforeDispatch({ status: from, packagePhotoPath: order.packagePhotoPath })) {
      throw new ServiceError(NOT_PACKED_CODE, notPackedMessage(order.orderNumber, "enviar"));
    }
    if (parsed.trackingCode) {
      await updateOrderTracking(tx, { orderId: order.id, trackingCode: parsed.trackingCode, userId: parsed.userId });
    }
    if (from === "paid") {
      await transitionOrder(tx, { orderId: order.id, to: "preparing", userId: parsed.userId });
    }
    await transitionOrder(tx, { orderId: order.id, to: "shipped", userId: parsed.userId });
    return { ...base, to: "shipped", idempotent: false };
  });
}

/**
 * "Marcar como entregue" direto (paid → delivered: entrega em mãos, dinheiro
 * na entrega baixado). Pedido de motoboy ainda na loja precisa da foto do
 * pacote antes (embalar antes de sair); sem janela, a entrega em mãos
 * dispensa a foto.
 */
export async function deliverByHand(db: DbOrTx, input: { orderId: string; userId: string }): Promise<Awaited<ReturnType<typeof transitionOrder>>> {
  const parsed = z.object({ orderId: z.uuid(), userId: z.uuid() }).parse(input);
  const [order] = await db
    .select({ orderNumber: orders.orderNumber, status: orders.status, deliveryWindow: orders.deliveryWindow, packagePhotoPath: orders.packagePhotoPath })
    .from(orders)
    .where(eq(orders.id, parsed.orderId))
    .limit(1);
  if (!order) throw new ServiceError("ORDER_NOT_FOUND", "Pedido não encontrado.");
  const window = order.deliveryWindow as { dispatchedAt?: string } | null;
  if (window && needsPackingBeforeDispatch({ status: order.status, packagePhotoPath: order.packagePhotoPath, dispatchedAt: window.dispatchedAt ?? null })) {
    throw new ServiceError(NOT_PACKED_CODE, `O pedido #${order.orderNumber} ainda não foi embalado: registre a foto do pacote antes de marcar como entregue.`);
  }
  return transitionOrder(db, { orderId: parsed.orderId, to: "delivered", userId: parsed.userId });
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

  // O snapshot é registro da época; o código ATUAL da variação vem junto
  // para a tela mostrar "hoje X" quando o dono trocou o SKU depois da venda.
  const itemRows = await db
    .select({ item: orderItems, currentSku: productVariants.sku })
    .from(orderItems)
    .leftJoin(productVariants, eq(productVariants.id, orderItems.productVariantId))
    .where(eq(orderItems.orderId, order.id));
  const items = itemRows.map((row) => ({ ...row.item, currentSku: row.currentSku }));

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
      isGift: orders.isGift,
      deliveryWindow: orders.deliveryWindow,
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
