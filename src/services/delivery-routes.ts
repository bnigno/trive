// Rota do dia do motoboy: os pedidos pagos com janela de entrega, agrupados
// para a manhã da dona (atrasados / hoje por janela / próximos), o botão
// "Saiu" (paid → preparing → shipped numa transação só; o evento
// order.shipped avisa a cliente "saiu da maison") e o reagendamento de uma
// janela que passou. A regra de agrupamento é pura (core/shipping/route).
import { and, asc, eq, inArray, isNotNull, or } from "drizzle-orm";
import { z } from "zod";

import type { OrderStatus } from "@/core/orders/state-machine";
import { PAYMENT_METHOD_LABELS_SHORT, type PaymentMethod } from "@/core/orders/payment-methods";
import {
  deliveryWindowSchema,
  windowBelongsToRate,
  windowDateLabel,
  type DeliveryWindow,
  type DeliveryWindowChoice,
} from "@/core/shipping/delivery-windows";
import { groupRouteOrders, isPaidAfterCutoff, type RouteOfDay } from "@/core/shipping/route";
import { auditLog, customers, orderItems, orders, productVariants, shippingRates } from "@/db/schema";
import { spDayKey } from "@/lib/sp-day";
import { enqueueOutboxEvent, type DbOrTx } from "@/queue/enqueue";
import { ServiceError, transitionOrder } from "@/services/orders";
import { parseWindows } from "@/services/shipping";

export interface RouteOrder {
  id: string;
  orderNumber: number;
  status: OrderStatus;
  window: DeliveryWindowChoice;
  rateName: string;
  /** "sexta 18/09, 19h–21h" — o retrato gravado no fechamento. */
  windowLabel: string;
  customerName: string;
  phoneE164: string | null;
  /** "Av. Nazaré, 100, apto 12 — Nazaré, Belém" (o que o motoboy precisa). */
  addressLine: string | null;
  postalCode: string | null;
  itemsCount: number;
  /** "Longo Dunas · Areia · M ×1" por linha. */
  itemsSummary: string[];
  totalCents: number;
  paymentMethod: PaymentMethod | null;
  /** Dinheiro na entrega: o motoboy precisa receber. */
  collectCashCents: number | null;
  isGift: boolean;
  packagePhotoPath: string | null;
  paidAt: Date | null;
  /** Pagou depois da hora-limite: a promessa "hoje" precisa de um olhar da dona. */
  paidAfterCutoff: boolean;
  /** Saiu com o motoboy (pedido em dinheiro ainda por receber). */
  dispatchedAt: Date | null;
}

/** Retrato gravado por createStoreOrder (tolerante: linha estranha não derruba a rota). */
const storedWindowSchema = z.object({
  dayKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  start: z.string(),
  end: z.string(),
  cutoff: z.string(),
  rateName: z.string().default("Motoboy"),
  label: z.string().optional(),
  dispatchedAt: z.string().optional(),
});

const storedAddressSchema = z
  .object({
    postalCode: z.string().optional(),
    street: z.string().optional(),
    number: z.string().optional(),
    complement: z.string().nullish(),
    district: z.string().optional(),
    city: z.string().optional(),
  })
  .partial();

export function addressLineOf(raw: unknown): { line: string | null; postalCode: string | null } {
  const parsed = storedAddressSchema.safeParse(raw);
  if (!parsed.success) return { line: null, postalCode: null };
  const a = parsed.data;
  const head = [a.street, a.number, a.complement].filter((part) => part && part.trim()).join(", ");
  const tail = [a.district, a.city].filter((part) => part && part.trim()).join(", ");
  const line = [head, tail].filter(Boolean).join(" — ");
  return { line: line || null, postalCode: a.postalCode ?? null };
}

/** Pago ou em separação — e o dinheiro na entrega, que fica "aguardando pagamento" até o motoboy voltar. */
const ROUTE_STATUSES: OrderStatus[] = ["paid", "preparing"];
const routeStatusFilter = () =>
  or(inArray(orders.status, ROUTE_STATUSES), and(eq(orders.status, "pending_payment"), eq(orders.paymentMethod, "cash")))!;

export async function listRouteOrders(db: DbOrTx): Promise<RouteOrder[]> {
  const rows = await db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      status: orders.status,
      deliveryWindow: orders.deliveryWindow,
      shippingAddress: orders.shippingAddress,
      totalCents: orders.totalCents,
      paymentMethod: orders.paymentMethod,
      isGift: orders.isGift,
      packagePhotoPath: orders.packagePhotoPath,
      paidAt: orders.paidAt,
      customerName: customers.fullName,
      phoneE164: customers.phoneE164,
    })
    .from(orders)
    .innerJoin(customers, eq(customers.id, orders.customerId))
    .where(and(routeStatusFilter(), isNotNull(orders.deliveryWindow)))
    .orderBy(asc(orders.paidAt), asc(orders.orderNumber));
  if (rows.length === 0) return [];

  const items = await db
    .select({
      orderId: orderItems.orderId,
      quantity: orderItems.quantity,
      name: orderItems.nameSnapshot,
      sku: orderItems.skuSnapshot,
      attributes: productVariants.attributes,
    })
    .from(orderItems)
    .leftJoin(productVariants, eq(productVariants.id, orderItems.productVariantId))
    .where(inArray(orderItems.orderId, rows.map((row) => row.id)));
  const itemsByOrder = new Map<string, { count: number; lines: string[] }>();
  for (const item of items) {
    const entry = itemsByOrder.get(item.orderId) ?? { count: 0, lines: [] };
    entry.count += item.quantity;
    const attrs = item.attributes && typeof item.attributes === "object" ? Object.values(item.attributes as Record<string, string>).filter(Boolean) : [];
    entry.lines.push([item.name, ...attrs].join(" · ") + (item.quantity > 1 ? ` ×${item.quantity}` : ""));
    itemsByOrder.set(item.orderId, entry);
  }

  const result: RouteOrder[] = [];
  for (const row of rows) {
    const stored = storedWindowSchema.safeParse(row.deliveryWindow);
    if (!stored.success) continue;
    const { rateName, label, dispatchedAt, ...window } = stored.data;
    const address = addressLineOf(row.shippingAddress);
    const paymentMethod = (row.paymentMethod ?? null) as PaymentMethod | null;
    result.push({
      id: row.id,
      orderNumber: row.orderNumber,
      status: row.status as OrderStatus,
      window,
      rateName,
      windowLabel: label ?? windowDateLabel(window),
      customerName: row.customerName,
      phoneE164: row.phoneE164,
      addressLine: address.line,
      postalCode: address.postalCode,
      itemsCount: itemsByOrder.get(row.id)?.count ?? 0,
      itemsSummary: itemsByOrder.get(row.id)?.lines ?? [],
      totalCents: row.totalCents,
      paymentMethod,
      collectCashCents: paymentMethod === "cash" ? row.totalCents : null,
      isGift: row.isGift,
      packagePhotoPath: row.packagePhotoPath,
      paidAt: row.paidAt,
      paidAfterCutoff: isPaidAfterCutoff(row.paidAt, window),
      dispatchedAt: dispatchedAt ? new Date(dispatchedAt) : null,
    });
  }
  return result;
}

/** A rota como a tela mostra. `now` injetável (o "hoje" é o de São Paulo). */
export async function listRouteOfDay(db: DbOrTx, input: { now?: Date } = {}): Promise<RouteOfDay<RouteOrder> & { todayKey: string }> {
  const todayKey = spDayKey(input.now ?? new Date());
  const grouped = groupRouteOrders(await listRouteOrders(db), todayKey);
  return { ...grouped, todayKey };
}

/** Quantos saem hoje + quantos atrasaram (card do dashboard). */
export async function countRouteOfDay(db: DbOrTx, input: { now?: Date } = {}): Promise<{ today: number; late: number }> {
  const route = await listRouteOfDay(db, input);
  return { today: route.todayCount, late: route.late.length };
}

export function paymentLabelOf(method: PaymentMethod | null): string {
  return method ? (PAYMENT_METHOD_LABELS_SHORT[method] ?? method) : "";
}

// ---------------------------------------------------------------------------
// "Saiu": a peça está com o motoboy
// ---------------------------------------------------------------------------

const dispatchSchema = z.object({
  orderId: z.uuid(),
  userId: z.uuid(),
  now: z.date().optional(),
});

export interface DispatchResult {
  orderId: string;
  orderNumber: number;
  from: OrderStatus;
  /** 'shipped' (pago) ou 'pending_payment' (dinheiro na entrega: saiu, paga ao receber). */
  to: OrderStatus;
  idempotent: boolean;
}

/**
 * "Saiu": a peça está com o motoboy.
 * - Pedido pago (ou em separação): paid → preparing → shipped na mesma
 *   transação (a máquina não tem paid → shipped); só a transição final gera
 *   efeito externo — order.shipped vira "Saiu da maison" com a janela.
 * - Dinheiro na entrega: o pedido fica "aguardando pagamento" até o motoboy
 *   voltar, então não há transição — a saída fica no retrato da janela
 *   (dispatchedAt) e o aviso vai pela fila (order.out_for_delivery).
 * Idempotente: quem já saiu devolve `idempotent: true`, sem novo aviso.
 */
export async function dispatchOrder(db: DbOrTx, input: z.input<typeof dispatchSchema>): Promise<DispatchResult> {
  const parsed = dispatchSchema.parse(input);
  const now = parsed.now ?? new Date();
  return db.transaction(async (tx) => {
    const [order] = await tx
      .select({
        id: orders.id,
        orderNumber: orders.orderNumber,
        status: orders.status,
        paymentMethod: orders.paymentMethod,
        deliveryWindow: orders.deliveryWindow,
      })
      .from(orders)
      .where(eq(orders.id, parsed.orderId))
      .for("update");
    if (!order) throw new ServiceError("ORDER_NOT_FOUND", "Pedido não encontrado.");
    if (!order.deliveryWindow) {
      throw new ServiceError("NOT_MOTOBOY", "Este pedido não é de motoboy — use o envio normal com rastreio.");
    }
    const from = order.status as OrderStatus;
    const base = { orderId: order.id, orderNumber: order.orderNumber, from };
    if (from === "shipped" || order.deliveryWindow.dispatchedAt) return { ...base, to: from, idempotent: true };

    const snapshot = { ...order.deliveryWindow, dispatchedAt: now.toISOString() };
    if (from === "pending_payment" && order.paymentMethod === "cash") {
      await tx.update(orders).set({ deliveryWindow: snapshot, updatedAt: now }).where(eq(orders.id, order.id));
      await enqueueOutboxEvent(tx, {
        eventType: "order.out_for_delivery",
        dedupeKey: `order.out_for_delivery:${order.id}`,
        aggregateType: "order",
        aggregateId: order.id,
        payload: { orderId: order.id, orderNumber: order.orderNumber },
      });
      await tx.insert(auditLog).values({
        actorType: "user",
        actorId: parsed.userId,
        action: "order.dispatch",
        entityType: "order",
        entityId: order.id,
        after: { dispatchedAt: snapshot.dispatchedAt, paymentMethod: "cash" },
      });
      return { ...base, to: "pending_payment", idempotent: false };
    }
    if (!ROUTE_STATUSES.includes(from)) {
      throw new ServiceError("INVALID_TRANSITION", "Só um pedido pago (ou em dinheiro na entrega) pode sair para entrega.");
    }
    if (from === "paid") {
      await transitionOrder(tx, { orderId: order.id, to: "preparing", userId: parsed.userId });
    }
    await transitionOrder(tx, { orderId: order.id, to: "shipped", userId: parsed.userId });
    await tx.update(orders).set({ deliveryWindow: snapshot }).where(eq(orders.id, order.id));
    return { ...base, to: "shipped", idempotent: false };
  });
}

// ---------------------------------------------------------------------------
// Reagendar a janela (pagamento caiu depois do limite, ou a janela passou)
// ---------------------------------------------------------------------------

const rescheduleSchema = z.object({
  orderId: z.uuid(),
  userId: z.uuid(),
  dayKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Dia inválido."),
  window: deliveryWindowSchema,
  now: z.date().optional(),
});

/** Janelas que a dona pode escolher ao reagendar: as das faixas de motoboy ativas. */
export async function listMotoboyWindows(db: DbOrTx): Promise<{ rateName: string; windows: DeliveryWindow[] }[]> {
  const rows = await db
    .select({ name: shippingRates.name, deliveryWindows: shippingRates.deliveryWindows })
    .from(shippingRates)
    .where(and(eq(shippingRates.kind, "motoboy"), eq(shippingRates.isActive, true)))
    .orderBy(asc(shippingRates.sortOrder), asc(shippingRates.name));
  return rows.map((row) => ({ rateName: row.name, windows: parseWindows(row.deliveryWindows) })).filter((r) => r.windows.length > 0);
}

/**
 * Troca a janela do pedido (ainda por sair) por outra de uma faixa de
 * motoboy ativa, em hoje ou num dia futuro. Não avisa a cliente: a dona
 * combina pelo WhatsApp (o link está na rota). Fica no audit.
 */
export async function rescheduleOrderWindow(db: DbOrTx, input: z.input<typeof rescheduleSchema>): Promise<DeliveryWindowChoice> {
  const parsed = rescheduleSchema.parse(input);
  const todayKey = spDayKey(parsed.now ?? new Date());
  if (parsed.dayKey < todayKey) throw new ServiceError("PAST_DAY", "Escolha hoje ou um dia que ainda vem.");
  return db.transaction(async (tx) => {
    const [order] = await tx
      .select({ id: orders.id, status: orders.status, paymentMethod: orders.paymentMethod, deliveryWindow: orders.deliveryWindow })
      .from(orders)
      .where(eq(orders.id, parsed.orderId))
      .for("update");
    if (!order) throw new ServiceError("ORDER_NOT_FOUND", "Pedido não encontrado.");
    if (!order.deliveryWindow) throw new ServiceError("NOT_MOTOBOY", "Este pedido não é de motoboy.");
    const waitingCash = order.status === "pending_payment" && order.paymentMethod === "cash";
    if (order.deliveryWindow.dispatchedAt || (!ROUTE_STATUSES.includes(order.status as OrderStatus) && !waitingCash)) {
      throw new ServiceError("INVALID_TRANSITION", "Só um pedido que ainda não saiu pode ser reagendado.");
    }
    const rates = await listMotoboyWindows(tx);
    const owner = rates.find((r) => r.rateName === order.deliveryWindow?.rateName && windowBelongsToRate(parsed.window, r.windows))
      ?? rates.find((r) => windowBelongsToRate(parsed.window, r.windows));
    if (!owner) throw new ServiceError("WINDOW_UNKNOWN", "Essa janela não existe mais nas faixas de motoboy.");

    const choice: DeliveryWindowChoice = { dayKey: parsed.dayKey, ...parsed.window };
    const snapshot = { ...order.deliveryWindow, ...choice, rateName: owner.rateName, label: windowDateLabel(choice) };
    await tx.update(orders).set({ deliveryWindow: snapshot, updatedAt: new Date() }).where(eq(orders.id, order.id));
    await tx.insert(auditLog).values({
      actorType: "user",
      actorId: parsed.userId,
      action: "order.reschedule_window",
      entityType: "order",
      entityId: order.id,
      before: order.deliveryWindow,
      after: snapshot,
    });
    return choice;
  });
}
