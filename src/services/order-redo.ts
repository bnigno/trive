// "Refazer pedido": muda um pedido que ainda NÃO foi pago — tirar/trocar o
// cupom, passar para dinheiro na entrega (ou voltar ao link), trocar peças
// ou tamanho, mudar o presente/bilhete ou a entrega. O antigo é cancelado
// ("substituído") e nasce um pedido NOVO, com número novo, numa transação
// só: estoque e cupom saem do antigo e entram no novo; qualquer recusa
// (esgotou, cupom não vale, preço mudou) desfaz tudo e o antigo fica intacto.
// Usado pela equipe (botão no painel) e pela Lia (refazer_pedido).
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import type { CorreiosQuoter } from "@/adapters/superfrete";
import { variantLabel } from "@/core/catalog/attributes";
import { compareSizeLabels } from "@/core/catalog/sizes";
import {
  buildRedoPlan,
  describeOrderChanges,
  isOverridableBlocker,
  redoBlockerMessage,
  redoBlockers,
  redoPaymentMethodOf,
  snapshotKeptShipping,
  type DeliveryWindowSnapshot,
  type RedoChanges,
  type RedoEligibilityInput,
  type RedoItem,
  type RedoSource,
} from "@/core/orders/redo";
import { SUPERSEDED_CANCEL_REASON } from "@/core/orders/reasons";
import type { DeliveryOption } from "@/core/shipping/delivery-windows";
import { isValidNeededBy } from "@/core/shipping/needed-by";
import {
  auditLog,
  couponRedemptions,
  customers,
  deliveryStops,
  financialEntries,
  orderItems,
  orders,
  priceVersions,
  products,
  productVariants,
  siteCarts,
  stockLevels,
  waConversations,
} from "@/db/schema";
import { formatCentsBRL } from "@/lib/money";
import { sameE164 } from "@/lib/phone";
import { spDayKey, spMinutesOfDay } from "@/lib/sp-day";
import type { DbOrTx } from "@/queue/enqueue";
import { ServiceError, transitionOrder } from "@/services/orders";
import { computeTotalWeightGrams, quoteDeliveryOptions } from "@/services/store-catalog";
import { createStoreOrder, PriceChangedError, ShippingChangedError } from "@/services/store-orders";

const windowSchema = z.object({
  dayKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  start: z.string(),
  end: z.string(),
  cutoff: z.string(),
});

/** Espelho Zod de RedoChanges (core): a fronteira do painel e da Lia. */
export const redoChangesSchema = z.object({
  coupon: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("keep") }),
      z.object({ kind: z.literal("remove") }),
      z.object({ kind: z.literal("code"), code: z.string().trim().min(1).max(40) }),
    ])
    .optional(),
  paymentMethod: z.enum(["online", "cash"]).optional(),
  items: z
    .array(
      z
        .object({
          variantId: z.uuid().optional(),
          sku: z.string().trim().min(1).max(60).optional(),
          quantity: z.number().int().min(1).max(20),
          /** O preço que ela viu; ausente = o da mesma peça no pedido antigo, ou o de hoje para peça nova. */
          expectedUnitPriceCents: z.number().int().nonnegative().optional(),
        })
        .refine((item) => (item.variantId === undefined) !== (item.sku === undefined), "Cada peça vem pelo id da variante ou pelo SKU."),
    )
    .min(1, "O pedido precisa de ao menos uma peça.")
    .max(30)
    .optional(),
  gift: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("keep") }),
      z.object({ kind: z.literal("remove") }),
      z.object({
        kind: z.literal("set"),
        recipientName: z.string().trim().min(1, "Diga para quem é o presente.").max(80),
        message: z.string().trim().max(280).nullable(),
      }),
    ])
    .optional(),
  delivery: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("keep") }),
      // Uma das opções de agora (painel: "Cotar entrega"), recotada na hora com o peso novo.
      z.object({ kind: z.literal("option"), optionKey: z.string().trim().min(1).max(200) }),
      z.object({
        kind: z.literal("ship"),
        shippingRateId: z.uuid(),
        expectedShippingCents: z.number().int().nonnegative(),
        deliveryWindow: windowSchema.optional(),
        neededBy: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        occasion: z.string().trim().max(60).optional(),
        label: z.string().trim().min(1).max(120),
      }),
    ])
    .optional(),
});

const redoInputSchema = z.object({
  orderId: z.uuid(),
  changes: redoChangesSchema,
  actor: z.discriminatedUnion("type", [
    z.object({ type: z.literal("user"), userId: z.uuid() }),
    z.object({ type: z.literal("lia"), conversationId: z.uuid() }),
  ]),
  /** Só a equipe, depois de conferir no Mercado Pago que não há pagamento em andamento. */
  allowPaymentAttempt: z.boolean().optional(),
});

export type RedoPendingOrderInput = z.input<typeof redoInputSchema>;

export interface RedoPendingOrderResult {
  oldOrderId: string;
  oldOrderNumber: number;
  newOrderId: string;
  newOrderNumber: number;
  publicToken: string;
  paymentDueAt: Date | null;
  paymentMethod: "online" | "cash";
  totalCents: number;
  discountCents: number;
  shippingCents: number;
  coupon: { code: string; freeShipping: boolean; shippingDiscountCents: number } | null;
  /** O que mudou, em frases curtas ("cupom X retirado"…). */
  changes: string[];
}

/** Rótulo de cada peça ("1× Vestido Amora (G)") e o peso, lidos do catálogo. */
async function loadItemFacts(db: DbOrTx, variantIds: string[]) {
  if (variantIds.length === 0) return new Map<string, { label: string; weightGrams: number | null }>();
  const rows = await db
    .select({
      id: productVariants.id,
      weightGrams: productVariants.weightGrams,
      attributes: productVariants.attributes,
      productName: products.name,
      attributesSchema: products.attributesSchema,
    })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(inArray(productVariants.id, variantIds));
  return new Map(
    rows.map((row) => {
      const variant = variantLabel((row.attributes ?? {}) as Record<string, string>, (row.attributesSchema ?? []) as string[]);
      return [row.id, { label: variant ? `${row.productName} (${variant})` : row.productName, weightGrams: row.weightGrams }];
    }),
  );
}

function weightOf(items: readonly RedoItem[], facts: Map<string, { weightGrams: number | null }>): number {
  return computeTotalWeightGrams(items.map((item) => ({ weightGrams: facts.get(item.variantId)?.weightGrams ?? null, quantity: item.quantity })));
}

type RedoItemInput = NonNullable<z.infer<typeof redoChangesSchema>["items"]>[number];

/** Variantes vendáveis agora (produto ativo, variante ativa, preço ativo), por id ou SKU. */
async function loadSellableVariants(db: DbOrTx, input: { variantIds: string[]; skus: string[] }) {
  if (input.variantIds.length === 0 && input.skus.length === 0) return [];
  const byId = input.variantIds.length > 0 ? inArray(productVariants.id, input.variantIds) : undefined;
  const bySku = input.skus.length > 0 ? inArray(sql`lower(${productVariants.sku})`, input.skus.map((sku) => sku.toLowerCase())) : undefined;
  return db
    .select({ variantId: productVariants.id, sku: productVariants.sku, priceCents: priceVersions.priceCents })
    .from(productVariants)
    .innerJoin(products, and(eq(products.id, productVariants.productId), eq(products.status, "active"), isNull(products.deletedAt)))
    .innerJoin(priceVersions, and(eq(priceVersions.productVariantId, productVariants.id), eq(priceVersions.status, "active")))
    .where(and(eq(productVariants.isActive, true), isNull(productVariants.deletedAt), byId && bySku ? sql`(${byId} or ${bySku})` : (byId ?? bySku)));
}

/**
 * As peças do pedido novo, com o preço esperado: o que veio; senão o da MESMA
 * peça no pedido antigo (preço que subiu desde então trava, como no checkout,
 * e só passa com o "preço de hoje" aceito); senão o de hoje — peça nova (outro
 * tamanho, outra peça) é escolhida agora, pelo preço que aparece, e o resumo
 * que vai para a cliente diz o preço. SKU repetido soma.
 */
async function resolveRedoItems(db: DbOrTx, items: readonly RedoItemInput[], oldItems: readonly RedoItem[]): Promise<RedoItem[]> {
  const variants = await loadSellableVariants(db, {
    variantIds: items.flatMap((item) => (item.variantId ? [item.variantId] : [])),
    skus: items.flatMap((item) => (item.sku ? [item.sku] : [])),
  });
  const merged = new Map<string, RedoItem>();
  for (const item of items) {
    const variant = item.variantId
      ? variants.find((row) => row.variantId === item.variantId)
      : variants.find((row) => row.sku.toLowerCase() === item.sku?.toLowerCase());
    if (!variant) {
      throw new ServiceError("REDO_ITEM_NOT_FOUND", item.sku ? `Não encontrei a peça de SKU "${item.sku}" à venda.` : "Uma das peças escolhidas não está mais à venda.");
    }
    const old = oldItems.find((line) => line.variantId === variant.variantId);
    const price = item.expectedUnitPriceCents ?? old?.expectedUnitPriceCents ?? variant.priceCents;
    const existing = merged.get(variant.variantId);
    // Duas linhas na mesma peça: vale o preço que veio explícito (o "preço de hoje" aceito), não o da primeira.
    merged.set(variant.variantId, {
      variantId: variant.variantId,
      quantity: (existing?.quantity ?? 0) + item.quantity,
      expectedUnitPriceCents: item.expectedUnitPriceCents ?? existing?.expectedUnitPriceCents ?? price,
    });
  }
  return [...merged.values()];
}

/** O que impede refazer este pedido agora (a mesma conta no painel e na transação). */
async function loadEligibility(db: DbOrTx, order: typeof orders.$inferSelect, now: Date): Promise<RedoEligibilityInput> {
  const [replacedBy] = order.replacedByOrderId
    ? await db.select({ orderNumber: orders.orderNumber }).from(orders).where(eq(orders.id, order.replacedByOrderId)).limit(1)
    : [];
  const [openStop] = await db
    .select({ id: deliveryStops.id })
    .from(deliveryStops)
    .where(and(eq(deliveryStops.orderId, order.id), eq(deliveryStops.status, "pending")))
    .limit(1);
  const [settledSale] = await db
    .select({ id: financialEntries.id })
    .from(financialEntries)
    .where(
      and(
        eq(financialEntries.orderId, order.id),
        eq(financialEntries.direction, "receivable"),
        eq(financialEntries.category, "sale"),
        eq(financialEntries.status, "settled"),
      ),
    )
    .limit(1);
  return {
    orderNumber: order.orderNumber,
    status: order.status,
    channel: order.channel,
    packagePhotoPath: order.packagePhotoPath,
    dispatchedAt: order.deliveryWindow?.dispatchedAt ?? null,
    hasOpenDeliveryStop: Boolean(openStop),
    mpPaymentId: order.mpPaymentId,
    reservationExpired: order.status === "pending_payment" && order.paymentDueAt !== null && order.paymentDueAt.getTime() <= now.getTime(),
    saleSettled: Boolean(settledSale),
    paymentMethod: order.paymentMethod,
    replacedByOrderNumber: replacedBy?.orderNumber ?? null,
  };
}

type OrderAddress = { postalCode: string; street: string; number: string; complement: string | null; district: string; city: string; state: string };

async function loadOrderLines(db: DbOrTx, orderId: string): Promise<RedoItem[]> {
  const lines = await db
    .select({ variantId: orderItems.productVariantId, quantity: orderItems.quantity, unitPriceCents: orderItems.unitPriceCents })
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId));
  return lines.map((line) => ({ variantId: line.variantId, quantity: line.quantity, expectedUnitPriceCents: line.unitPriceCents }));
}

function deliveryOptionLabel(option: DeliveryOption): string {
  return option.kind === "motoboy"
    ? `${option.name} — ${option.label}`
    : `${option.name} — ${option.deliveryDaysMin === option.deliveryDaysMax ? `${option.deliveryDaysMax}` : `${option.deliveryDaysMin} a ${option.deliveryDaysMax}`} dias úteis`;
}

/** Quando o cupom deste pedido foi avaliado de verdade: volta pela cadeia de refeitos enquanto o cupom é o mesmo. */
async function couponOriginDate(db: DbOrTx, order: { id: string; couponCode: string | null; createdAt: Date }): Promise<Date> {
  let origin = order.createdAt;
  let currentId = order.id;
  for (let hop = 0; hop < 20 && order.couponCode; hop += 1) {
    const [previous] = await db
      .select({ id: orders.id, couponCode: orders.couponCode, createdAt: orders.createdAt })
      .from(orders)
      .where(eq(orders.replacedByOrderId, currentId))
      .limit(1);
    if (!previous || previous.couponCode !== order.couponCode) break;
    origin = previous.createdAt;
    currentId = previous.id;
  }
  return origin;
}

export interface RedoServiceOptions {
  now?: Date;
  /** Cotação automática dos Correios (fora das faixas do motoboy) para a entrega escolhida de novo. */
  correios?: CorreiosQuoter;
}

export async function redoPendingOrder(db: DbOrTx, rawInput: RedoPendingOrderInput, options: RedoServiceOptions = {}): Promise<RedoPendingOrderResult> {
  const input = redoInputSchema.parse(rawInput);
  const now = options.now ?? new Date();
  const userId = input.actor.type === "user" ? input.actor.userId : null;

  return db.transaction(async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.id, input.orderId)).limit(1).for("update");
    if (!order) throw new ServiceError("NOT_FOUND", "Pedido não encontrado.");

    // A Lia só mexe no pedido da cliente da conversa (pelo cadastro ou pelo telefone).
    if (input.actor.type === "lia") {
      const [conversation] = await tx
        .select({ customerId: waConversations.customerId, phoneE164: waConversations.phoneE164 })
        .from(waConversations)
        .where(eq(waConversations.id, input.actor.conversationId))
        .limit(1);
      const [owner] = await tx.select({ phoneE164: customers.phoneE164 }).from(customers).where(eq(customers.id, order.customerId)).limit(1);
      const mine =
        conversation !== undefined &&
        (conversation.customerId === order.customerId || (owner?.phoneE164 != null && sameE164(owner.phoneE164, conversation.phoneE164)));
      if (!mine) throw new ServiceError("REDO_NOT_YOURS", `O pedido #${order.orderNumber} não é desta conversa: nada mudou.`);
    }

    const eligibility = await loadEligibility(tx, order, now);
    // Passar por cima do "pagamento em andamento" é só da equipe (conferiu no Mercado Pago) — nunca da Lia.
    const override = input.actor.type === "user" && input.allowPaymentAttempt === true;
    const blocker = redoBlockers(eligibility).find((item) => !(override && isOverridableBlocker(item)));
    if (blocker) throw new ServiceError("REDO_NOT_ALLOWED", redoBlockerMessage(blocker, eligibility));

    const [customer] = await tx
      .select({ id: customers.id, fullName: customers.fullName, phoneE164: customers.phoneE164 })
      .from(customers)
      .where(eq(customers.id, order.customerId))
      .limit(1);
    const address = order.shippingAddress as OrderAddress | null;
    if (!customer?.phoneE164 || !address) {
      throw new ServiceError("REDO_NOT_ALLOWED", `O pedido #${order.orderNumber} não tem telefone ou endereço da cliente: refaça pela venda manual.`);
    }

    const oldItems = await loadOrderLines(tx, order.id);
    const [redemption] = await tx
      .select({ shippingDiscountCents: couponRedemptions.shippingDiscountCents })
      .from(couponRedemptions)
      .where(and(eq(couponRedemptions.orderId, order.id), isNull(couponRedemptions.releasedAt)))
      .limit(1);

    const newItems = input.changes.items ? await resolveRedoItems(tx, input.changes.items, oldItems) : oldItems;
    const facts = await loadItemFacts(tx, [...new Set([...oldItems, ...newItems].map((item) => item.variantId))]);
    const kept = snapshotKeptShipping(
      {
        shippingCents: order.shippingCents,
        shippingService: order.shippingService,
        shippingQuoteId: order.shippingQuoteId,
        deliveryWindow: order.deliveryWindow as DeliveryWindowSnapshot | null,
        neededBy: order.neededBy,
        occasion: order.occasion,
        shipBy: order.shipBy,
      },
      redemption?.shippingDiscountCents ?? 0,
    );
    const source: RedoSource = {
      couponCode: order.couponCode,
      paymentMethod: order.paymentMethod,
      items: oldItems,
      gift: order.isGift && order.giftRecipientName ? { recipientName: order.giftRecipientName, message: order.giftMessage, deliverBy: order.giftDeliverBy } : null,
      // Cupom mantido vale como no PRIMEIRO pedido da cadeia que já o tinha (#A → #B → #C).
      createdAt: await couponOriginDate(tx, order),
      kept,
      weightGrams: weightOf(oldItems, facts),
    };
    const newWeightGrams = weightOf(newItems, facts);
    const todayKey = spDayKey(now);
    let delivery: RedoChanges["delivery"];
    const requested = input.changes.delivery;
    if (requested?.kind === "option") {
      // Recota AGORA, com o peso novo: o preço e a janela são os de hoje (a hora-limite pode ter passado).
      const available = await quoteDeliveryOptions(tx, { cep: address.postalCode, totalWeightGrams: newWeightGrams, now }, options.correios ? { correios: options.correios } : {});
      const chosen = available.find((option) => option.optionKey === requested.optionKey);
      if (!chosen) throw new ServiceError("REDO_DELIVERY_GONE", "Essa opção de entrega não vale mais (a hora-limite pode ter passado): cote a entrega de novo.");
      const keepNeededBy = order.neededBy && isValidNeededBy(order.neededBy, todayKey) ? order.neededBy : null;
      delivery = {
        kind: "ship",
        shippingRateId: chosen.rateId,
        expectedShippingCents: chosen.priceCents,
        ...(chosen.kind === "motoboy" ? { deliveryWindow: chosen.window } : {}),
        ...(keepNeededBy ? { neededBy: keepNeededBy, ...(order.occasion ? { occasion: order.occasion } : {}) } : {}),
        label: deliveryOptionLabel(chosen),
      };
    } else {
      delivery = requested;
    }
    const requestedChanges: RedoChanges = {
      ...(input.changes.coupon ? { coupon: input.changes.coupon } : {}),
      ...(input.changes.paymentMethod ? { paymentMethod: input.changes.paymentMethod } : {}),
      ...(input.changes.items ? { items: newItems } : {}),
      ...(input.changes.gift ? { gift: input.changes.gift } : {}),
      ...(delivery ? { delivery } : {}),
    };
    const planned = buildRedoPlan(source, requestedChanges, { newWeightGrams, todayKey, nowMinutes: spMinutesOfDay(now) });
    if (!planned.ok) throw new ServiceError(planned.code, planned.message);
    const plan = planned.plan;

    // 1. O antigo sai: estoque, uso do cupom e valor a receber voltam (a máquina de estados faz tudo).
    await transitionOrder(tx, { orderId: order.id, to: "canceled", userId, reason: SUPERSEDED_CANCEL_REASON });

    // 2. O novo entra, com as mesmas cliente e endereço — e a entrega mantida sem recotar.
    const created = await createStoreOrder(
      tx,
      {
        channel: order.channel === "whatsapp" ? "whatsapp" : "store",
        customer: { fullName: customer.fullName, phone: customer.phoneE164, marketingOptIn: false },
        address: { ...address, complement: address.complement ?? undefined },
        items: plan.items,
        ...(plan.delivery.kind === "ship"
          ? {
              shippingRateId: plan.delivery.shippingRateId,
              expectedShippingCents: plan.delivery.expectedShippingCents,
              ...(plan.delivery.deliveryWindow ? { deliveryWindow: plan.delivery.deliveryWindow } : {}),
              ...(plan.delivery.neededBy ? { neededBy: plan.delivery.neededBy } : {}),
              ...(plan.delivery.occasion ? { occasion: plan.delivery.occasion } : {}),
            }
          : {}),
        ...(plan.couponCode ? { couponCode: plan.couponCode } : {}),
        paymentMethod: plan.paymentMethod,
        ...(plan.gift
          ? { gift: { recipientName: plan.gift.recipientName, ...(plan.gift.message ? { message: plan.gift.message } : {}), ...(plan.gift.deliverBy ? { deliverBy: plan.gift.deliverBy } : {}) } }
          : {}),
      },
      {
        now,
        ...(plan.delivery.kind === "keep" ? { keptShipping: plan.delivery.kept } : {}),
        ...(plan.couponAsOf ? { couponAsOf: plan.couponAsOf } : {}),
        attribution: order.attribution ?? null,
      },
    ).catch((error: unknown) => {
      // A linguagem do checkout ("desde que você montou o carrinho") vira a do refazer.
      if (error instanceof PriceChangedError) {
        const list = error.changes.map((change) => `${change.name}: era ${formatCentsBRL(change.oldPriceCents)}, hoje é ${formatCentsBRL(change.newPriceCents)}`).join("; ");
        throw new ServiceError("REDO_PRICE_CHANGED", `O preço mudou desde o pedido #${order.orderNumber} (${list}). Nada mudou: o #${order.orderNumber} continua valendo. Para refazer, só com o preço de hoje e o SIM dela.`);
      }
      if (error instanceof ShippingChangedError) {
        throw new ServiceError("REDO_SHIPPING_CHANGED", `O frete mudou (agora ${formatCentsBRL(error.newPriceCents)}). Nada mudou: cote a entrega de novo.`);
      }
      throw error;
    });

    const [newOrder] = await tx.select({ customerId: orders.customerId }).from(orders).where(eq(orders.id, created.orderId)).limit(1);
    if (newOrder?.customerId !== order.customerId) {
      // Nunca acontece com o mesmo telefone; se acontecer, desfaz tudo.
      throw new ServiceError("REDO_CUSTOMER_MISMATCH", "O pedido novo ficou com outra cliente — nada foi mudado.");
    }

    // Pix manual (a equipe conferiu que nada entrou): o novo continua no Pix,
    // com o prazo estendido que ela já tinha — nunca encurta para o do link.
    if (order.paymentMethod === "pix_manual" && plan.paymentMethod === "online") {
      // Sem prazo no antigo (era dinheiro na entrega antes da chave) continua sem prazo.
      const dueAt =
        order.paymentDueAt === null
          ? null
          : !created.paymentDueAt || order.paymentDueAt.getTime() > created.paymentDueAt.getTime()
            ? order.paymentDueAt
            : created.paymentDueAt;
      await tx.update(orders).set({ paymentMethod: "pix_manual", paymentDueAt: dueAt, updatedAt: now }).where(eq(orders.id, created.orderId));
      created.paymentDueAt = dueAt;
    }

    // 3. O antigo aponta para o novo; a ponte do site (a origem da venda) acompanha.
    await tx.update(orders).set({ replacedByOrderId: created.orderId, updatedAt: now }).where(eq(orders.id, order.id));
    await tx.update(siteCarts).set({ orderId: created.orderId }).where(eq(siteCarts.orderId, order.id));

    const changes = describeOrderChanges(
      source,
      plan,
      (item) =>
        `${item.quantity}× ${facts.get(item.variantId)?.label ?? "peça"} por ${formatCentsBRL(item.expectedUnitPriceCents)}${item.quantity > 1 ? " cada" : ""}`,
    );
    await tx.insert(auditLog).values({
      actorType: userId ? "user" : "system",
      actorId: userId,
      action: "order.redo",
      entityType: "order",
      entityId: order.id,
      after: {
        newOrderId: created.orderId,
        newOrderNumber: created.orderNumber,
        changes,
        actor: input.actor.type,
        // O que a equipe conferiu antes de passar por cima ("pagamento em andamento", "chave Pix enviada").
        overriddenBlockers: override ? redoBlockers(eligibility).filter(isOverridableBlocker) : [],
      },
    });

    return {
      oldOrderId: order.id,
      oldOrderNumber: order.orderNumber,
      newOrderId: created.orderId,
      newOrderNumber: created.orderNumber,
      publicToken: created.publicToken,
      paymentDueAt: created.paymentDueAt,
      paymentMethod: plan.paymentMethod,
      totalCents: created.totalCents,
      discountCents: created.discountCents,
      shippingCents: created.shippingCents,
      coupon: created.coupon,
      changes,
    };
  });
}

export interface RedoFormLine {
  variantId: string;
  label: string;
  quantity: number;
  unitPriceCents: number;
  /** As variantes da mesma peça à venda (tamanho/cor), com o disponível contando o que este pedido já segura. */
  siblings: { variantId: string; label: string; available: number; priceCents: number }[];
}

export interface RedoFormData {
  orderId: string;
  orderNumber: number;
  /** Vazio = pode refazer; "overridable" = só a caixa "conferi no Mercado Pago" libera. */
  blockers: { message: string; overridable: boolean }[];
  lines: RedoFormLine[];
  couponCode: string | null;
  paymentMethod: "online" | "cash";
  gift: { recipientName: string; message: string | null } | null;
  keptDeliveryLabel: string;
}

/** O que o card "Refazer pedido" do painel mostra; null se o pedido não existe. */
export async function getRedoFormData(db: DbOrTx, orderId: string): Promise<RedoFormData | null> {
  const parsedId = z.uuid().safeParse(orderId);
  if (!parsedId.success) return null;
  const [order] = await db.select().from(orders).where(eq(orders.id, parsedId.data)).limit(1);
  if (!order) return null;

  const eligibility = await loadEligibility(db, order, new Date());
  const blockers = redoBlockers(eligibility).map((blocker) => ({ message: redoBlockerMessage(blocker, eligibility), overridable: isOverridableBlocker(blocker) }));
  const oldItems = await loadOrderLines(db, order.id);

  const productRows = oldItems.length
    ? await db
        .select({ variantId: productVariants.id, productId: productVariants.productId })
        .from(productVariants)
        .where(inArray(productVariants.id, oldItems.map((item) => item.variantId)))
    : [];
  const productIds = [...new Set(productRows.map((row) => row.productId))];
  const siblingRows = productIds.length
    ? await db
        .select({
          variantId: productVariants.id,
          productId: productVariants.productId,
          attributes: productVariants.attributes,
          attributesSchema: products.attributesSchema,
          productName: products.name,
          priceCents: priceVersions.priceCents,
          onHand: stockLevels.onHand,
          reserved: stockLevels.reserved,
        })
        .from(productVariants)
        .innerJoin(products, and(eq(products.id, productVariants.productId), eq(products.status, "active"), isNull(products.deletedAt)))
        .innerJoin(priceVersions, and(eq(priceVersions.productVariantId, productVariants.id), eq(priceVersions.status, "active")))
        .leftJoin(stockLevels, eq(stockLevels.productVariantId, productVariants.id))
        .where(and(inArray(productVariants.productId, productIds), eq(productVariants.isActive, true), isNull(productVariants.deletedAt)))
    : [];
  const facts = await loadItemFacts(db, oldItems.map((item) => item.variantId));
  const heldByThisOrder = (variantId: string) => (order.status === "pending_payment" ? (oldItems.find((item) => item.variantId === variantId)?.quantity ?? 0) : 0);

  const lines: RedoFormLine[] = oldItems.map((item) => {
    const productId = productRows.find((row) => row.variantId === item.variantId)?.productId;
    const rows = siblingRows
      .filter((row) => row.productId === productId)
      .sort((a, b) => compareSizeLabels(String((a.attributes as Record<string, string> | null)?.tamanho ?? ""), String((b.attributes as Record<string, string> | null)?.tamanho ?? "")));
    const siblings = rows.map((row) => ({
      variantId: row.variantId,
      label: variantLabel((row.attributes ?? {}) as Record<string, string>, (row.attributesSchema ?? []) as string[]) || row.productName,
      available: Math.max(0, (row.onHand ?? 0) - (row.reserved ?? 0) + heldByThisOrder(row.variantId)),
      priceCents: row.priceCents,
    }));
    const current = siblings.find((sibling) => sibling.variantId === item.variantId);
    return {
      variantId: item.variantId,
      label: facts.get(item.variantId)?.label ?? "Peça",
      quantity: item.quantity,
      unitPriceCents: item.expectedUnitPriceCents,
      // A peça do pedido sempre aparece (mesmo fora de venda), para o seletor nunca mostrar outra.
      siblings: current ? siblings : [{ variantId: item.variantId, label: `${facts.get(item.variantId)?.label ?? "Peça"} (não está mais à venda)`, available: 0, priceCents: item.expectedUnitPriceCents }, ...siblings],
    };
  });

  const window = order.deliveryWindow as DeliveryWindowSnapshot | null;
  return {
    orderId: order.id,
    orderNumber: order.orderNumber,
    blockers,
    lines,
    couponCode: order.couponCode,
    paymentMethod: redoPaymentMethodOf(order.paymentMethod),
    gift: order.isGift && order.giftRecipientName ? { recipientName: order.giftRecipientName, message: order.giftMessage } : null,
    keptDeliveryLabel: window ? `${window.rateName} — ${window.label}` : order.shippingService ? `Correios — ${order.shippingService}` : "a entrega do pedido",
  };
}

const quoteRedoDeliverySchema = z.object({
  orderId: z.uuid(),
  items: redoChangesSchema.shape.items,
});

/** "Cotar entrega" do painel: as opções de agora para o endereço do pedido e o peso das peças escolhidas. */
export async function quoteRedoDelivery(
  db: DbOrTx,
  rawInput: z.input<typeof quoteRedoDeliverySchema>,
  options: RedoServiceOptions = {},
): Promise<{ optionKey: string; label: string; priceCents: number }[]> {
  const input = quoteRedoDeliverySchema.parse(rawInput);
  const [order] = await db.select({ id: orders.id, shippingAddress: orders.shippingAddress }).from(orders).where(eq(orders.id, input.orderId)).limit(1);
  const address = order?.shippingAddress as OrderAddress | null | undefined;
  if (!order || !address) throw new ServiceError("NOT_FOUND", "Pedido sem endereço de entrega.");
  const oldItems = await loadOrderLines(db, order.id);
  const items = input.items ? await resolveRedoItems(db, input.items, oldItems) : oldItems;
  const facts = await loadItemFacts(db, items.map((item) => item.variantId));
  const available = await quoteDeliveryOptions(
    db,
    { cep: address.postalCode, totalWeightGrams: weightOf(items, facts), now: options.now ?? new Date() },
    options.correios ? { correios: options.correios } : {},
  );
  return available.map((option) => ({ optionKey: option.optionKey, label: deliveryOptionLabel(option), priceCents: option.priceCents }));
}

/** O que o refazer gravou (o audit): as mudanças e quem refez, para o aviso da dona. */
export async function loadRedoAudit(db: DbOrTx, oldOrderId: string): Promise<{ changes: string[]; actor: "user" | "lia" | null }> {
  const [row] = await db
    .select({ after: auditLog.after })
    .from(auditLog)
    .where(and(eq(auditLog.action, "order.redo"), eq(auditLog.entityId, oldOrderId)))
    .limit(1);
  const after = (row?.after ?? null) as { changes?: unknown; actor?: unknown } | null;
  const changes = Array.isArray(after?.changes) ? after.changes.filter((item): item is string => typeof item === "string") : [];
  const actor = after?.actor === "user" || after?.actor === "lia" ? after.actor : null;
  return { changes, actor };
}

/**
 * As variáveis do "seu pedido foi atualizado" (cliente e dona): o que mudou,
 * somado em todos os refazer desde o número que ela conhece; quem refez (o
 * último); e a frase da reserva — Pix manual sem prazo não tem hora.
 */
export async function redoNoticeVars(db: DbOrTx, input: { redoHops: string[]; prazo: string }): Promise<{ mudancas: string; quem: string; reserva: string }> {
  const audits = await Promise.all(input.redoHops.map((hop) => loadRedoAudit(db, hop)));
  const changes = [...new Set(audits.flatMap((audit) => audit.changes))];
  const actor = audits.at(-1)?.actor ?? null;
  return {
    mudancas: changes.length > 0 ? changes.join("; ") : "ajustes no pedido",
    quem: actor === "lia" ? "a Lia, a pedido da cliente" : "a equipe",
    reserva: input.prazo ? `Sua reserva fica garantida até ${input.prazo}. ` : "",
  };
}
