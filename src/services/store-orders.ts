// Pedidos da LOJA pública (Fase 2): checkout com pagamento manual (Pix via
// WhatsApp), reserva de estoque com expiração curta e página pública de
// acompanhamento por token SEM dados pessoais.
import { and, asc, eq, gte, isNull, lt, lte } from "drizzle-orm";
import { z } from "zod";

import { InsufficientStockError } from "@/core/stock/ledger";
import { computeOrderTotals } from "@/core/orders/totals";
import {
  auditLog,
  customerAddresses,
  customers,
  financialEntries,
  orderItems,
  orders,
  orderStatusHistory,
  priceVersions,
  products,
  productVariants,
  settings,
  shippingRates,
  stockLevels,
} from "@/db/schema";
import { normalizeDocument } from "@/lib/document";
import { toE164BR } from "@/lib/phone";
import { enqueueOutboxEvent, type DbOrTx } from "@/queue/enqueue";
import {
  quoteCoupon,
  redeemCouponInTx,
  ServiceError as CouponServiceError,
  type CouponQuote,
} from "@/services/coupons";
import { ServiceError, transitionOrder } from "@/services/orders";

export { ServiceError };

// ---------------------------------------------------------------------------
// Erros estruturados para a UI (CDC: preço anunciado vincula — nunca cobrar
// silenciosamente um valor diferente do que o cliente viu).
// ---------------------------------------------------------------------------

export interface PriceChange {
  variantId: string;
  name: string;
  oldPriceCents: number;
  newPriceCents: number;
}

export class PriceChangedError extends Error {
  readonly code = "PRICE_CHANGED";
  readonly changes: PriceChange[];
  constructor(changes: PriceChange[]) {
    super(
      "O preço de um ou mais itens mudou desde que você montou o carrinho. Confira os novos valores antes de confirmar.",
    );
    this.name = "PriceChangedError";
    this.changes = changes;
  }
}

export class ShippingChangedError extends Error {
  readonly code = "SHIPPING_CHANGED";
  readonly newPriceCents: number;
  constructor(newPriceCents: number) {
    super(
      "O valor do frete mudou. Confira o novo valor antes de confirmar o pedido.",
    );
    this.name = "ShippingChangedError";
    this.newPriceCents = newPriceCents;
  }
}

export const RESERVATION_EXPIRED_REASON =
  "Reserva expirada — pagamento não confirmado no prazo";

const DEFAULT_RESERVATION_TTL_MINUTES = 120;

// ---------------------------------------------------------------------------
// createStoreOrder
// ---------------------------------------------------------------------------

const storeCustomerSchema = z.object({
  fullName: z.string().trim().min(3, "Informe o nome completo."),
  document: z.string().transform((value, ctx) => {
    const doc = normalizeDocument(value);
    if (!doc) {
      ctx.addIssue({ code: "custom", message: "CPF ou CNPJ inválido" });
      return z.NEVER;
    }
    return doc;
  }),
  phone: z.string().transform((value, ctx) => {
    const e164 = toE164BR(value);
    if (!e164) {
      ctx.addIssue({
        code: "custom",
        message: "Telefone inválido. Informe DDD + número.",
      });
      return z.NEVER;
    }
    return e164;
  }),
  email: z.email("E-mail inválido.").optional(),
  /** LGPD: opt-in explícito — nunca assumido. */
  marketingOptIn: z.boolean(),
});

const storeAddressSchema = z.object({
  postalCode: z
    .string()
    .transform((v) => v.replace(/\D/g, ""))
    .pipe(z.string().regex(/^\d{8}$/, "CEP inválido: informe os 8 dígitos.")),
  street: z.string().trim().min(1, "Informe a rua."),
  number: z.string().trim().min(1, "Informe o número."),
  complement: z.string().trim().max(200).optional(),
  district: z.string().trim().min(1, "Informe o bairro."),
  city: z.string().trim().min(1, "Informe a cidade."),
  state: z
    .string()
    .trim()
    .toUpperCase()
    .pipe(z.string().regex(/^[A-Z]{2}$/, "UF inválida: use a sigla de 2 letras.")),
});

const createStoreOrderSchema = z.object({
  /** Origem do pedido: loja pública (default) ou bot de vendas no WhatsApp. */
  channel: z.enum(["store", "whatsapp"]).default("store"),
  customer: storeCustomerSchema,
  address: storeAddressSchema,
  items: z
    .array(
      z.object({
        variantId: z.uuid(),
        quantity: z.number().int().positive(),
        /** Preço unitário que o cliente VIU na vitrine (em centavos). */
        expectedUnitPriceCents: z.number().int().nonnegative(),
      }),
    )
    .min(1, "Informe ao menos um item para o pedido."),
  shippingRateId: z.uuid(),
  /** Frete que o cliente VIU no carrinho (em centavos). */
  expectedShippingCents: z.number().int().nonnegative(),
  /** Código de cupom digitado no checkout (opcional; normalizado no serviço). */
  couponCode: z.string().trim().optional(),
  /**
   * 'online' (default): pagamento pelo link (MP/página pública) com prazo de
   * reserva; 'cash': dinheiro na entrega — sem prazo (payment_due_at NULL,
   * isento de expiração/lembrete) e com receivable pendente para o dono
   * baixar manualmente.
   */
  paymentMethod: z.enum(["online", "cash"]).default("online"),
});

export type CreateStoreOrderInput = z.input<typeof createStoreOrderSchema>;

export interface CreateStoreOrderResult {
  orderId: string;
  orderNumber: number;
  publicToken: string;
  /** Null em pedido 'cash' (dinheiro na entrega não expira). */
  paymentDueAt: Date | null;
  totalCents: number;
}

export async function createStoreOrder(
  db: DbOrTx,
  input: CreateStoreOrderInput,
): Promise<CreateStoreOrderResult> {
  const parsed = createStoreOrderSchema.parse(input);

  return db.transaction(async (tx) => {
    // (a) Itens: preço ATIVO atual — o servidor SEMPRE recalcula. Divergências
    // são acumuladas para reportar TODAS de uma vez.
    const priceChanges: PriceChange[] = [];
    let totalWeightGrams = 0;
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
          weightGrams: productVariants.weightGrams,
          isActive: productVariants.isActive,
          deletedAt: productVariants.deletedAt,
          productName: products.name,
          productStatus: products.status,
          productDeletedAt: products.deletedAt,
        })
        .from(productVariants)
        .innerJoin(products, eq(products.id, productVariants.productId))
        .where(eq(productVariants.id, item.variantId));

      if (
        !variant ||
        !variant.isActive ||
        variant.deletedAt !== null ||
        variant.productStatus !== "active" ||
        variant.productDeletedAt !== null
      ) {
        throw new ServiceError(
          "VARIANT_UNAVAILABLE",
          variant
            ? `O produto "${variant.productName}" não está mais disponível na loja. Remova-o do carrinho para continuar.`
            : "Um dos itens do carrinho não está mais disponível na loja. Atualize o carrinho para continuar.",
        );
      }

      const [activePrice] = await tx
        .select({ id: priceVersions.id, priceCents: priceVersions.priceCents })
        .from(priceVersions)
        .where(
          and(
            eq(priceVersions.productVariantId, item.variantId),
            eq(priceVersions.status, "active"),
          ),
        );
      if (!activePrice) {
        throw new ServiceError(
          "NO_ACTIVE_PRICE",
          `O produto "${variant.productName}" está indisponível para venda no momento. Remova-o do carrinho para continuar.`,
        );
      }

      if (activePrice.priceCents !== item.expectedUnitPriceCents) {
        priceChanges.push({
          variantId: variant.id,
          name: variant.productName,
          oldPriceCents: item.expectedUnitPriceCents,
          newPriceCents: activePrice.priceCents,
        });
      }

      totalWeightGrams += (variant.weightGrams ?? 0) * item.quantity;
      itemRows.push({
        productVariantId: variant.id,
        skuSnapshot: variant.sku,
        nameSnapshot: variant.productName,
        quantity: item.quantity,
        unitPriceCents: activePrice.priceCents,
        unitCostCents: variant.costCents,
        priceVersionId: activePrice.id,
        totalCents: activePrice.priceCents * item.quantity,
      });
    }

    if (priceChanges.length > 0) {
      throw new PriceChangedError(priceChanges);
    }

    // (b) Frete: a opção escolhida deve estar ativa; o valor é RECALCULADO
    // pelo peso total e pelo CEP (faixas da tabela shipping_rates).
    const [chosenRate] = await tx
      .select({ id: shippingRates.id, name: shippingRates.name, isActive: shippingRates.isActive })
      .from(shippingRates)
      .where(eq(shippingRates.id, parsed.shippingRateId));
    if (!chosenRate || !chosenRate.isActive) {
      throw new ServiceError(
        "SHIPPING_RATE_UNAVAILABLE",
        "A opção de frete escolhida não está mais disponível. Escolha outra opção de entrega.",
      );
    }

    const cep = parsed.address.postalCode;
    const [applicableRate] = await tx
      .select({ id: shippingRates.id, priceCents: shippingRates.priceCents })
      .from(shippingRates)
      .where(
        and(
          eq(shippingRates.isActive, true),
          eq(shippingRates.name, chosenRate.name),
          lte(shippingRates.cepStart, cep),
          gte(shippingRates.cepEnd, cep),
          lte(shippingRates.weightMinGrams, totalWeightGrams),
          gte(shippingRates.weightMaxGrams, totalWeightGrams),
        ),
      )
      .orderBy(asc(shippingRates.sortOrder), asc(shippingRates.id))
      .limit(1);
    if (!applicableRate) {
      throw new ServiceError(
        "SHIPPING_UNAVAILABLE",
        "Não há entrega disponível para o CEP informado com esta opção de frete. Escolha outra opção.",
      );
    }

    const shippingCents = applicableRate.priceCents;
    if (shippingCents !== parsed.expectedShippingCents) {
      throw new ShippingChangedError(shippingCents);
    }

    // (b2) Cupom: cotação ANTES de qualquer escrita — cupom inválido derruba
    // o checkout com mensagem clara sem criar nada. O CONSUMO (used_count)
    // acontece só depois do insert do pedido, nesta MESMA transação, com
    // guard atômico contra corrida no último uso.
    const subtotalCents = itemRows.reduce((sum, r) => sum + r.totalCents, 0);
    let coupon: CouponQuote | null = null;
    if (parsed.couponCode !== undefined && parsed.couponCode !== "") {
      try {
        coupon = await quoteCoupon(tx, {
          code: parsed.couponCode,
          subtotalCents,
        });
      } catch (error) {
        if (error instanceof CouponServiceError) {
          // Reempacota na classe de erro da loja para a UI tratar uniforme.
          throw new ServiceError(error.code, error.message);
        }
        throw error;
      }
    }

    // Pré-checagem de estoque com mensagem amigável ANTES de qualquer escrita
    // (a reserva na transição ainda revalida com lock — corrida segura).
    for (const row of itemRows) {
      const [level] = await tx
        .select({ onHand: stockLevels.onHand, reserved: stockLevels.reserved })
        .from(stockLevels)
        .where(eq(stockLevels.productVariantId, row.productVariantId));
      const available = (level?.onHand ?? 0) - (level?.reserved ?? 0);
      if (available < row.quantity) {
        throw new ServiceError(
          "OUT_OF_STOCK",
          `Que pena — o item "${row.nameSnapshot}" esgotou. Remova-o do carrinho ou reduza a quantidade para continuar.`,
        );
      }
    }

    // (c) Cliente: procura por documento (dígitos), senão por telefone E.164.
    const doc = parsed.customer.document;
    const phone = parsed.customer.phone;

    let [existing] = await tx
      .select({ id: customers.id, marketingOptIn: customers.marketingOptIn })
      .from(customers)
      .where(
        and(eq(customers.documentNumber, doc.digits), isNull(customers.deletedAt)),
      );
    if (!existing) {
      [existing] = await tx
        .select({ id: customers.id, marketingOptIn: customers.marketingOptIn })
        .from(customers)
        .where(and(eq(customers.phoneE164, phone), isNull(customers.deletedAt)));
    }

    let customerId: string;
    if (existing) {
      customerId = existing.id;
      const updateSet: Partial<typeof customers.$inferInsert> = {
        fullName: parsed.customer.fullName,
        documentType: doc.type,
        documentNumber: doc.digits,
        phoneE164: phone,
        updatedAt: new Date(),
      };
      if (parsed.customer.email !== undefined) {
        updateSet.email = parsed.customer.email;
      }
      // LGPD: nunca rebaixa opt-in true→false silenciosamente no checkout.
      if (parsed.customer.marketingOptIn) {
        updateSet.marketingOptIn = true;
      }
      await tx.update(customers).set(updateSet).where(eq(customers.id, customerId));

      await tx.insert(auditLog).values({
        actorType: "system",
        actorId: null,
        action: "customer.store_update",
        entityType: "customer",
        entityId: customerId,
        after: {
          fullName: parsed.customer.fullName,
          documentType: doc.type,
          marketingOptIn: parsed.customer.marketingOptIn || existing.marketingOptIn,
        },
      });
    } else {
      const [created] = await tx
        .insert(customers)
        .values({
          fullName: parsed.customer.fullName,
          email: parsed.customer.email ?? null,
          phoneE164: phone,
          documentType: doc.type,
          documentNumber: doc.digits,
          marketingOptIn: parsed.customer.marketingOptIn,
        })
        .returning({ id: customers.id });
      customerId = created.id;

      await tx.insert(auditLog).values({
        actorType: "system",
        actorId: null,
        action: "customer.store_create",
        entityType: "customer",
        entityId: customerId,
        after: {
          fullName: parsed.customer.fullName,
          documentType: doc.type,
          marketingOptIn: parsed.customer.marketingOptIn,
        },
      });
    }

    // Endereço: adiciona apenas se ainda não existe um igual.
    const addressValues = {
      postalCode: parsed.address.postalCode,
      street: parsed.address.street,
      number: parsed.address.number,
      complement: parsed.address.complement ?? null,
      district: parsed.address.district,
      city: parsed.address.city,
      state: parsed.address.state,
    };
    const knownAddresses = await tx
      .select()
      .from(customerAddresses)
      .where(eq(customerAddresses.customerId, customerId));
    const alreadyKnown = knownAddresses.some(
      (a) =>
        a.postalCode === addressValues.postalCode &&
        a.street === addressValues.street &&
        a.number === addressValues.number &&
        (a.complement ?? null) === addressValues.complement &&
        a.district === addressValues.district &&
        a.city === addressValues.city &&
        a.state === addressValues.state,
    );
    if (!alreadyKnown) {
      await tx.insert(customerAddresses).values({
        customerId,
        ...addressValues,
        isDefault: knownAddresses.length === 0,
      });
    }

    // (d) Pedido channel 'store' em draft, com snapshots (sku/nome/custo/
    // price_version) e snapshot jsonb do endereço de entrega.
    // quoteCoupon já garante desconto <= subtotal (clamp/percent),
    // condição que computeOrderTotals revalida.
    const totals = computeOrderTotals(
      itemRows.map((r) => ({
        unitPriceCents: r.unitPriceCents,
        quantity: r.quantity,
      })),
      coupon?.discountCents ?? 0,
      shippingCents,
    );

    const [order] = await tx
      .insert(orders)
      .values({
        customerId,
        status: "draft",
        channel: parsed.channel,
        subtotalCents: totals.subtotalCents,
        discountCents: coupon?.discountCents ?? 0,
        couponId: coupon?.couponId ?? null,
        couponCode: coupon?.code ?? null,
        shippingCents,
        totalCents: totals.totalCents,
        shippingAddress: addressValues,
        note: "Pedido da loja",
        createdBy: null,
      })
      .returning({
        id: orders.id,
        orderNumber: orders.orderNumber,
        publicToken: orders.publicToken,
      });

    await tx
      .insert(orderItems)
      .values(itemRows.map((r) => ({ ...r, orderId: order.id })));

    // Consome 1 uso do cupom na MESMA transação do pedido: se o guard falhar
    // (último uso perdido para um pedido simultâneo), TUDO desfaz.
    if (coupon) {
      try {
        await redeemCouponInTx(tx, coupon.couponId);
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
      changedBy: null,
    });

    // (e) draft→pending_payment: reserva o estoque (reuso da máquina de
    // estados). Corrida rara entre a pré-checagem e o lock → mensagem amigável.
    try {
      await transitionOrder(tx, {
        orderId: order.id,
        to: "pending_payment",
        userId: null,
      });
    } catch (error) {
      if (error instanceof InsufficientStockError) {
        throw new ServiceError(
          "OUT_OF_STOCK",
          "Um dos itens do pedido esgotou agora há pouco. Atualize o carrinho e tente novamente.",
        );
      }
      throw error;
    }

    // (f) Prazo e forma de pagamento.
    // - online: prazo da reserva a partir da setting (fallback 120 min);
    // - cash: payment_due_at fica NULL (sem expiração nem lembrete — o cron e
    //   a recuperação filtram por payment_due_at não-nulo) e nasce um
    //   receivable PENDENTE que o dono liquida ao receber o dinheiro.
    let paymentDueAt: Date | null = null;
    if (parsed.paymentMethod === "cash") {
      await tx
        .update(orders)
        .set({ paymentMethod: "cash", updatedAt: new Date() })
        .where(eq(orders.id, order.id));
      if (totals.totalCents > 0) {
        await tx.insert(financialEntries).values({
          direction: "receivable",
          category: "sale",
          description: `Pedido #${order.orderNumber}`,
          amountCents: totals.totalCents,
          status: "pending",
          orderId: order.id,
          createdBy: null,
        });
      }
    } else {
      const [ttlRow] = await tx
        .select({ value: settings.value })
        .from(settings)
        .where(eq(settings.key, "stock_reservation_ttl_minutes"));
      const ttlMinutes =
        typeof ttlRow?.value === "number" &&
        Number.isInteger(ttlRow.value) &&
        ttlRow.value > 0
          ? ttlRow.value
          : DEFAULT_RESERVATION_TTL_MINUTES;
      paymentDueAt = new Date(Date.now() + ttlMinutes * 60_000);
      await tx
        .update(orders)
        .set({ paymentDueAt, updatedAt: new Date() })
        .where(eq(orders.id, order.id));
    }

    // (g) Efeito externo só via outbox, na MESMA transação.
    await enqueueOutboxEvent(tx, {
      eventType: "order.store_created",
      dedupeKey: `order.store_created:${order.id}`,
      aggregateType: "order",
      aggregateId: order.id,
      payload: {
        orderId: order.id,
        orderNumber: order.orderNumber,
        totalCents: totals.totalCents,
        customerId,
      },
    });

    await tx.insert(auditLog).values({
      actorType: "system",
      actorId: null,
      action: "order.store_create",
      entityType: "order",
      entityId: order.id,
      after: {
        orderNumber: order.orderNumber,
        channel: "store",
        customerId,
        subtotalCents: totals.subtotalCents,
        discountCents: coupon?.discountCents ?? 0,
        couponCode: coupon?.code ?? null,
        shippingCents,
        totalCents: totals.totalCents,
        paymentMethod: parsed.paymentMethod,
        paymentDueAt: paymentDueAt?.toISOString() ?? null,
        items: itemRows.map((r) => ({
          sku: r.skuSnapshot,
          quantity: r.quantity,
          unitPriceCents: r.unitPriceCents,
        })),
      },
    });

    return {
      orderId: order.id,
      orderNumber: order.orderNumber,
      publicToken: order.publicToken,
      paymentDueAt,
      totalCents: totals.totalCents,
    };
  });
}

// ---------------------------------------------------------------------------
// Expiração de reservas (cron + lazy expire da página pública)
// ---------------------------------------------------------------------------

/**
 * Expira UM pedido se (ainda) estiver pending_payment e vencido, com lock —
 * seguro contra corrida com pagamento simultâneo. Retorna true se expirou.
 */
async function expireIfStillOverdue(
  db: DbOrTx,
  orderId: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [order] = await tx
      .select({
        id: orders.id,
        status: orders.status,
        paymentDueAt: orders.paymentDueAt,
      })
      .from(orders)
      .where(eq(orders.id, orderId))
      .for("update");
    if (
      !order ||
      order.status !== "pending_payment" ||
      order.paymentDueAt === null ||
      order.paymentDueAt.getTime() >= Date.now()
    ) {
      return false;
    }
    // Libera a reserva (release) via máquina de estados; ator SISTEMA.
    await transitionOrder(tx, {
      orderId: order.id,
      to: "canceled",
      userId: null,
      reason: RESERVATION_EXPIRED_REASON,
    });
    return true;
  });
}

const expireOverdueReservationsSchema = z.object({
  limit: z.number().int().positive().max(500).default(50),
});

export type ExpireOverdueReservationsInput = z.input<
  typeof expireOverdueReservationsSchema
>;

export async function expireOverdueReservations(
  db: DbOrTx,
  input: ExpireOverdueReservationsInput = {},
): Promise<{ expired: number }> {
  const parsed = expireOverdueReservationsSchema.parse(input);

  const overdue = await db
    .select({ id: orders.id })
    .from(orders)
    .where(
      and(
        eq(orders.status, "pending_payment"),
        lt(orders.paymentDueAt, new Date()),
      ),
    )
    .orderBy(asc(orders.paymentDueAt))
    .limit(parsed.limit);

  let expired = 0;
  for (const row of overdue) {
    if (await expireIfStillOverdue(db, row.id)) expired++;
  }
  return { expired };
}

// ---------------------------------------------------------------------------
// getPublicOrder — página pública por token, SEM dados pessoais
// ---------------------------------------------------------------------------

export interface PublicOrderItem {
  name: string;
  sku: string;
  quantity: number;
  unitPriceCents: number;
  totalCents: number;
}

export interface PublicOrder {
  orderNumber: number;
  status: string;
  createdAt: Date;
  paymentDueAt: Date | null;
  /** 'cash'/'pix_manual' mudam o bloco "Como pagar" da página pública. */
  paymentMethod: string | null;
  trackingCode: string | null;
  subtotalCents: number;
  discountCents: number;
  shippingCents: number;
  totalCents: number;
  items: PublicOrderItem[];
  canceledReason: string | null;
}

/**
 * Pedido para a página pública /pedido/[token]. O token vaza em
 * encaminhamentos de WhatsApp: NUNCA retornar nome, telefone, documento,
 * e-mail ou endereço. Reserva vencida é expirada aqui (lazy) antes de
 * responder, para o cliente nunca ver um "aguardando pagamento" fantasma.
 */
export async function getPublicOrder(
  db: DbOrTx,
  token: string,
): Promise<PublicOrder | null> {
  const parsedToken = z.uuid().safeParse(token);
  if (!parsedToken.success) return null;

  const selectOrder = () =>
    db
      .select({
        id: orders.id,
        orderNumber: orders.orderNumber,
        status: orders.status,
        createdAt: orders.createdAt,
        paymentDueAt: orders.paymentDueAt,
        paymentMethod: orders.paymentMethod,
        trackingCode: orders.shippingTrackingCode,
        subtotalCents: orders.subtotalCents,
        discountCents: orders.discountCents,
        shippingCents: orders.shippingCents,
        totalCents: orders.totalCents,
        canceledReason: orders.cancelReason,
      })
      .from(orders)
      .where(eq(orders.publicToken, parsedToken.data));

  let [order] = await selectOrder();
  if (!order) return null;

  // Lazy expire: reserva vencida é cancelada ANTES de responder.
  if (
    order.status === "pending_payment" &&
    order.paymentDueAt !== null &&
    order.paymentDueAt.getTime() < Date.now()
  ) {
    await expireIfStillOverdue(db, order.id);
    [order] = await selectOrder();
    if (!order) return null;
  }

  const items = await db
    .select({
      name: orderItems.nameSnapshot,
      sku: orderItems.skuSnapshot,
      quantity: orderItems.quantity,
      unitPriceCents: orderItems.unitPriceCents,
      totalCents: orderItems.totalCents,
    })
    .from(orderItems)
    .where(eq(orderItems.orderId, order.id));

  return {
    orderNumber: order.orderNumber,
    status: order.status,
    createdAt: order.createdAt,
    paymentDueAt: order.paymentDueAt,
    paymentMethod: order.paymentMethod,
    trackingCode: order.trackingCode,
    subtotalCents: order.subtotalCents,
    discountCents: order.discountCents,
    shippingCents: order.shippingCents,
    totalCents: order.totalCents,
    items,
    canceledReason: order.canceledReason,
  };
}
