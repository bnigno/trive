// Rota do dia do motoboy: os pedidos pagos com janela de entrega, agrupados
// para a manhã da dona (atrasados / hoje por janela / próximos), o botão
// "Saiu" (paid → preparing → shipped numa transação só; o evento
// order.shipped avisa a cliente "saiu da maison") e o reagendamento de uma
// janela que passou. A regra de agrupamento é pura (core/shipping/route).
import { and, asc, desc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { z } from "zod";

import { needsPackingBeforeDispatch, NOT_PACKED_CODE, notPackedMessage } from "@/core/orders/packing";
import type { OrderStatus } from "@/core/orders/state-machine";
import { PAYMENT_METHOD_LABELS_SHORT, type PaymentMethod } from "@/core/orders/payment-methods";
import {
  deliveryWindowSchema,
  windowBelongsToRate,
  windowDateLabel,
  type DeliveryWindow,
  type DeliveryWindowChoice,
} from "@/core/shipping/delivery-windows";
import { isFromEarlierAttempt } from "@/core/delivery/tracking";
import type { StopStatus } from "@/core/delivery/state";
import { groupRouteOrders, isPaidAfterCutoff, isStillOnTheStreet, type RouteOfDay } from "@/core/shipping/route";
import { auditLog, customers, deliveryStops, orderItems, orders, productVariants, shippingRates } from "@/db/schema";
import { isSpDayKey, spDayKey, spMinutesOfDay } from "@/lib/sp-day";
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
  /** Saiu com o motoboy ("Na rua": dinheiro ainda por receber, ou pago nas últimas 48 h). */
  dispatchedAt: Date | null;
}

/** O pedido na Rota do dia. */
export interface RouteOfDayOrder extends RouteOrder {
  /** Saiu e a última parada foi "não consegui": combinar com a cliente e reagendar (ou mandar de novo). */
  cameBack: boolean;
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
const routeStatusFilter = (includeShipped: boolean) =>
  or(
    inArray(orders.status, includeShipped ? [...ROUTE_STATUSES, "shipped"] : ROUTE_STATUSES),
    and(eq(orders.status, "pending_payment"), eq(orders.paymentMethod, "cash")),
    // Enviado mas sem marca de saída: voltou para a loja (reagendado depois
    // de "não consegui entregar") — precisa sair de novo.
    and(eq(orders.status, "shipped"), sql`${orders.deliveryWindow}->>'dispatchedAt' IS NULL`),
  )!;

/** "Longo Dunas · Areia · M ×1" por linha, e a contagem, por pedido. */
export async function summarizeOrderItems(db: DbOrTx, orderIds: readonly string[]): Promise<Map<string, { count: number; lines: string[] }>> {
  const itemsByOrder = new Map<string, { count: number; lines: string[] }>();
  if (orderIds.length === 0) return itemsByOrder;
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
    .where(inArray(orderItems.orderId, [...orderIds]));
  for (const item of items) {
    const entry = itemsByOrder.get(item.orderId) ?? { count: 0, lines: [] };
    entry.count += item.quantity;
    const attrs = item.attributes && typeof item.attributes === "object" ? Object.values(item.attributes as Record<string, string>).filter(Boolean) : [];
    entry.lines.push([item.name, ...attrs].join(" · ") + (item.quantity > 1 ? ` ×${item.quantity}` : ""));
    itemsByOrder.set(item.orderId, entry);
  }
  return itemsByOrder;
}

/**
 * Os pedidos de motoboy por sair. `includeShipped` traz também os que já
 * saíram (pagos viram 'shipped' no "Saiu"): é o que a saída com GPS aceita —
 * o motoboy pode levar um pedido que a dona já marcou como saído.
 */
export async function listRouteOrders(db: DbOrTx, options: { includeShipped?: boolean } = {}): Promise<RouteOrder[]> {
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
    .where(and(routeStatusFilter(options.includeShipped === true), isNotNull(orders.deliveryWindow)))
    .orderBy(asc(orders.paidAt), asc(orders.orderNumber));
  if (rows.length === 0) return [];

  const itemsByOrder = await summarizeOrderItems(db, rows.map((row) => row.id));

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
      collectCashCents: paymentMethod === "cash" && row.status === "pending_payment" ? row.totalCents : null,
      isGift: row.isGift,
      packagePhotoPath: row.packagePhotoPath,
      paidAt: row.paidAt,
      paidAfterCutoff: isPaidAfterCutoff(row.paidAt, window),
      dispatchedAt: dispatchedAt ? new Date(dispatchedAt) : null,
    });
  }
  return result;
}

/**
 * A rota como a tela mostra. `now` injetável (o "hoje" é o de São Paulo).
 * O pago que já saiu fica em "Na rua" pelas mesmas 48 h da saída com GPS:
 * saiu sem escolher o motoboy, ainda dá para mandar o link a ele.
 */
export async function listRouteOfDay(db: DbOrTx, input: { now?: Date } = {}): Promise<RouteOfDay<RouteOfDayOrder> & { todayKey: string }> {
  const now = input.now ?? new Date();
  const todayKey = spDayKey(now);
  const all = await listRouteOrders(db, { includeShipped: true });
  const cameBack = await ordersThatCameBack(db, all.filter((order) => order.dispatchedAt !== null));
  const candidates = all
    .map((order) => ({ ...order, cameBack: order.dispatchedAt !== null && cameBack.has(order.id) }))
    // "Na rua": o pago que saiu há até 48 h; o dinheiro na entrega até a baixa (há dinheiro a
    // receber); o que voltou sem entregar até ser reagendado.
    .filter((order) => order.status !== "shipped" || order.dispatchedAt === null || order.cameBack || isStillOnTheStreet(order.dispatchedAt, now));
  const grouped = groupRouteOrders(candidates, todayKey, spMinutesOfDay(now));
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
 * - Voltou para a loja (a última parada foi "não consegui" depois da saída,
 *   reagendado ou não): sai de novo, com marca de saída nova e aviso novo
 *   pela fila (a chave leva a hora da saída; o "saiu" da primeira vez já foi).
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
        packagePhotoPath: orders.packagePhotoPath,
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
    if (from === "delivered") return { ...base, to: from, idempotent: true };
    const waitingCash = from === "pending_payment" && order.paymentMethod === "cash";
    const dispatchedAt = order.deliveryWindow.dispatchedAt ? new Date(order.deliveryWindow.dispatchedAt) : null;
    // Voltou para a loja: a última parada foi "não consegui" depois da saída
    // (reagendado ou não). O "Saiu" vale de novo — com marca e aviso novos.
    const again = (from === "shipped" || waitingCash || ROUTE_STATUSES.includes(from)) && (await cameBackToStore(tx, { id: order.id, dispatchedAt }));
    // Já saiu (ou foi enviado por outro caminho) e não voltou: nada de novo.
    if (!again && (dispatchedAt || from === "shipped")) return { ...base, to: from, idempotent: true };
    // A janela já passou: primeiro reagendar, senão a cliente recebe "chega sexta 18/09" ontem.
    if (order.deliveryWindow.dayKey < spDayKey(now)) {
      throw new ServiceError("WINDOW_PAST", "A janela deste pedido já passou — reagende antes de marcar que saiu.");
    }
    if (!waitingCash && !again && !ROUTE_STATUSES.includes(from)) {
      throw new ServiceError("INVALID_TRANSITION", "Só um pedido pago (ou em dinheiro na entrega) pode sair para entrega.");
    }
    // Embalar antes de sair: sem a foto do pacote nada sai — nem o dinheiro na entrega.
    if (needsPackingBeforeDispatch({ status: from, packagePhotoPath: order.packagePhotoPath, dispatchedAt: order.deliveryWindow.dispatchedAt ?? null })) {
      throw new ServiceError(NOT_PACKED_CODE, notPackedMessage(order.orderNumber, "sair"));
    }

    const snapshot = { ...order.deliveryWindow, dispatchedAt: now.toISOString() };
    // O "saiu" da segunda vez tem chave própria: o da primeira já usou a de sempre.
    const notice = () =>
      enqueueOutboxEvent(tx, {
        eventType: "order.out_for_delivery",
        dedupeKey: again ? `order.out_for_delivery:${order.id}:${snapshot.dispatchedAt}` : `order.out_for_delivery:${order.id}`,
        aggregateType: "order",
        aggregateId: order.id,
        payload: { orderId: order.id, orderNumber: order.orderNumber, ...(again ? { againAt: snapshot.dispatchedAt } : {}) },
      });
    if (waitingCash || from === "shipped") {
      await tx.update(orders).set({ deliveryWindow: snapshot, updatedAt: now }).where(eq(orders.id, order.id));
      await notice();
      await tx.insert(auditLog).values({
        actorType: "user",
        actorId: parsed.userId,
        action: "order.dispatch",
        entityType: "order",
        entityId: order.id,
        after: { dispatchedAt: snapshot.dispatchedAt, ...(waitingCash ? { paymentMethod: "cash" } : {}), ...(again ? { again: true } : {}) },
      });
      return { ...base, to: from, idempotent: false };
    }
    if (from === "paid") {
      await transitionOrder(tx, { orderId: order.id, to: "preparing", userId: parsed.userId });
    }
    await transitionOrder(tx, { orderId: order.id, to: "shipped", userId: parsed.userId });
    await tx.update(orders).set({ deliveryWindow: snapshot }).where(eq(orders.id, order.id));
    // Dinheiro na entrega que voltou e foi pago antes de sair de novo: o
    // order.shipped cai na chave do "saiu" da primeira vez — o aviso vai por aqui.
    if (again) await notice();
    return { ...base, to: "shipped", idempotent: false };
  });
}

/**
 * O motoboy voltou: pedido que já saiu vira "entregue". Cobre os três
 * pontos em que ele pode estar (a máquina não tem atalho): paid → delivered
 * (dinheiro na entrega recém-baixado), preparing → shipped → delivered
 * (a dona passou pelo "Embalei"), shipped → delivered. O aviso "saiu" não
 * repete: shipped e out_for_delivery dividem a mesma chave de dedupe.
 */
const completeSchema = z.object({
  orderId: z.uuid(),
  /** null = o motoboy, pela página da saída (a máquina registra o motivo). */
  userId: z.uuid().nullable(),
  reason: z.string().min(1).max(2000).optional(),
});

export async function completeDispatchedOrder(
  db: DbOrTx,
  input: z.input<typeof completeSchema>,
): Promise<{ orderId: string; orderNumber: number; from: OrderStatus; idempotent: boolean }> {
  const parsed = completeSchema.parse(input);
  return db.transaction(async (tx) => {
    const [order] = await tx
      .select({ id: orders.id, orderNumber: orders.orderNumber, status: orders.status, deliveryWindow: orders.deliveryWindow })
      .from(orders)
      .where(eq(orders.id, parsed.orderId))
      .for("update");
    if (!order) throw new ServiceError("ORDER_NOT_FOUND", "Pedido não encontrado.");
    if (!order.deliveryWindow) throw new ServiceError("NOT_MOTOBOY", "Este pedido não é de motoboy.");
    const from = order.status as OrderStatus;
    const base = { orderId: order.id, orderNumber: order.orderNumber, from };
    if (from === "delivered") return { ...base, idempotent: true };
    if (!order.deliveryWindow.dispatchedAt && from !== "shipped") {
      throw new ServiceError("NOT_DISPATCHED", "Marque primeiro que o pedido saiu com o motoboy.");
    }
    if (from === "pending_payment") {
      throw new ServiceError("PAYMENT_PENDING", "Registre o pagamento em dinheiro antes de marcar como entregue.");
    }
    if (from === "preparing") {
      await transitionOrder(tx, { orderId: order.id, to: "shipped", userId: parsed.userId, reason: parsed.reason });
    }
    await transitionOrder(tx, { orderId: order.id, to: "delivered", userId: parsed.userId, reason: parsed.reason });
    return { ...base, idempotent: false };
  });
}

// ---------------------------------------------------------------------------
// Reagendar a janela (pagamento caiu depois do limite, ou a janela passou)
// ---------------------------------------------------------------------------

/** 'AAAA-MM-DD' que existe de verdade (31/02 não passa). */
function isRealDay(key: string): boolean {
  if (!isSpDayKey(key)) return false;
  const [y, m, d] = key.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

const rescheduleSchema = z.object({
  orderId: z.uuid(),
  userId: z.uuid(),
  dayKey: z.string().refine(isRealDay, "Dia inválido."),
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
 * combina pelo WhatsApp (o link está na rota). Fica no audit. Pedido que
 * saiu e voltou (a última parada da saída com GPS falhou) também pode — e de
 * novo, se a cliente pedir outro dia outra vez: a marca de saída cai, ele
 * volta para a rota e o "Saiu" seguinte o manda de novo (dispatchOrder).
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
    // Voltou (a última parada foi "não consegui"): vale também depois de já reagendado uma vez.
    const dispatchedAt = order.deliveryWindow.dispatchedAt ? new Date(order.deliveryWindow.dispatchedAt) : null;
    const cameBack = await cameBackToStore(tx, { id: order.id, dispatchedAt });
    const eligibleStatus = ROUTE_STATUSES.includes(order.status as OrderStatus) || waitingCash || (order.status === "shipped" && cameBack);
    if ((order.deliveryWindow.dispatchedAt && !cameBack) || !eligibleStatus) {
      throw new ServiceError("INVALID_TRANSITION", "Só um pedido que ainda não saiu (ou que voltou sem ser entregue) pode ser reagendado.");
    }
    const rates = await listMotoboyWindows(tx);
    const owner = rates.find((r) => r.rateName === order.deliveryWindow?.rateName && windowBelongsToRate(parsed.window, r.windows))
      ?? rates.find((r) => windowBelongsToRate(parsed.window, r.windows));
    if (!owner) throw new ServiceError("WINDOW_UNKNOWN", "Essa janela não existe mais nas faixas de motoboy.");

    const choice: DeliveryWindowChoice = { dayKey: parsed.dayKey, ...parsed.window };
    const { dispatchedAt: _dispatchedAt, ...kept } = order.deliveryWindow;
    const snapshot = { ...kept, ...choice, rateName: owner.rateName, label: windowDateLabel(choice) };
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

/** A última parada (não cancelada) do pedido numa saída com GPS falhou, e ele não saiu de novo depois: a peça está na loja. */
async function cameBackToStore(db: DbOrTx, order: { id: string; dispatchedAt: Date | null }): Promise<boolean> {
  return (await ordersThatCameBack(db, [order])).has(order.id);
}

/**
 * Voltaram para a loja: a última parada (fora as canceladas) foi "não
 * consegui" e o pedido não saiu de novo depois dela (o "Saiu" sem motoboy de
 * quem foi reagendado não cria parada — a que falhou continua a última).
 */
async function ordersThatCameBack(db: DbOrTx, list: readonly { id: string; dispatchedAt: Date | null }[]): Promise<Set<string>> {
  if (list.length === 0) return new Set();
  const rows = await db
    .select({ orderId: deliveryStops.orderId, status: deliveryStops.status, closedAt: deliveryStops.updatedAt })
    .from(deliveryStops)
    .where(and(inArray(deliveryStops.orderId, list.map((order) => order.id)), inArray(deliveryStops.status, ["pending", "delivered", "failed"])))
    .orderBy(desc(deliveryStops.createdAt), desc(deliveryStops.id));
  const last = new Map<string, { status: StopStatus; closedAt: Date }>();
  for (const row of rows) if (!last.has(row.orderId)) last.set(row.orderId, { status: row.status as StopStatus, closedAt: row.closedAt });
  return new Set(
    list
      .filter((order) => {
        const stop = last.get(order.id);
        return stop?.status === "failed" && !isFromEarlierAttempt(stop, order.dispatchedAt);
      })
      .map((order) => order.id),
  );
}
