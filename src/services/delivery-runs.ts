// A saída do motoboy com GPS: a dona monta a saída (vários pedidos, um
// motoboy) e cada pedido recebe o "Saiu" de sempre; o motoboy abre o link,
// manda a posição enquanto roda e fecha as paradas ("Entregue" com quem
// recebeu e o ponto do GPS, ou "Não consegui"); a cliente e o painel leem a
// mesma posição. O status do pedido continua passando pela máquina de
// estados (dispatchOrder / completeDispatchedOrder); a saída guarda só a
// prova e o caminho.
import { and, asc, count, desc, eq, inArray, lt, ne, sql } from "drizzle-orm";
import { z } from "zod";

import type { Geocoder } from "@/adapters/geocoding";
import {
  acceptPosition,
  isValidPoint,
  type PositionRejectReason,
  type PositionSample,
} from "@/core/delivery/positions";
import { googleMapsDirectionsUrl, wazeUrl } from "@/core/delivery/navigation";
import {
  assertRunTransition,
  canCloseStop,
  FAILURE_NOTE_MAX_CHARS,
  FAILURE_REASON_LABELS,
  FAILURE_REASONS,
  isRunOpen,
  RUN_MAX_STOPS,
  runCanFinish,
  type FailureReason,
  type RunStatus,
  type StopStatus,
} from "@/core/delivery/state";
import { buildTrackingView, type TrackingView } from "@/core/delivery/tracking";
import { normalizeReceivedBy, RECEIVED_BY_MAX_CHARS } from "@/core/orders/delivery";
import type { OrderStatus } from "@/core/orders/state-machine";
import type { PaymentMethod } from "@/core/orders/payment-methods";
import { windowDateLabel } from "@/core/shipping/delivery-windows";
import { auditLog, couriers, customers, deliveryPositions, deliveryRuns, deliveryStops, orders } from "@/db/schema";
import { spDayKey } from "@/lib/sp-day";
import { enqueueOutboxEvent, type DbOrTx } from "@/queue/enqueue";
import { findActiveCourierByPhone } from "@/services/couriers";
import { addressLineOf, completeDispatchedOrder, dispatchOrder, listRouteOrders, summarizeOrderItems, type RouteOrder } from "@/services/delivery-routes";
import { ServiceError } from "@/services/orders";
import { getStoreName } from "@/services/settings";
import { firstNameOf, siteBaseUrl } from "@/services/wa-messaging";

export { findActiveCourierByPhone };

export function courierRunUrl(courierToken: string): string {
  return `${siteBaseUrl()}/entrega/${courierToken}`;
}

// ---------------------------------------------------------------------------
// Elegíveis e montagem da saída
// ---------------------------------------------------------------------------

export interface RunEligibleOrder extends RouteOrder {
  /** Já está numa saída aberta: não pode entrar em outra. */
  openRunId: string | null;
  openRunCourier: string | null;
}

/** Um "Saiu" mais velho que isso já não é "na rua": a dona esqueceu de fechar; não entra em saída nova. */
export const ELIGIBLE_DISPATCH_MAX_MS = 48 * 3_600_000;

/**
 * Pedidos com parada ENTREGUE pelo motoboy cujo pedido ainda não fechou
 * (dinheiro na entrega aguardando a dona baixar): já foram entregues — não
 * podem sair de novo, nem ser cobrados de novo.
 */
async function deliveredAwaitingClose(db: DbOrTx, orderIds: readonly string[]): Promise<Set<string>> {
  if (orderIds.length === 0) return new Set();
  const rows = await db
    .select({ orderId: deliveryStops.orderId })
    .from(deliveryStops)
    .innerJoin(orders, eq(orders.id, deliveryStops.orderId))
    .where(and(inArray(deliveryStops.orderId, [...orderIds]), eq(deliveryStops.status, "delivered"), ne(orders.status, "delivered")));
  return new Set(rows.map((row) => row.orderId));
}

/**
 * Os pedidos de motoboy que podem sair: pagos, em separação, já na rua (o
 * "Saiu" das últimas 48 h) ou dinheiro na entrega; sem parada aberta nem
 * entrega já feita pelo motoboy; janela de hoje ou futura (a passada precisa
 * de reagendamento — dispatchOrder recusa).
 */
export async function listRunEligibleOrders(db: DbOrTx, input: { now?: Date } = {}): Promise<RunEligibleOrder[]> {
  const now = input.now ?? new Date();
  const todayKey = spDayKey(now);
  const all = await listRouteOrders(db, { includeShipped: true });
  if (all.length === 0) return [];
  const ids = all.map((o) => o.id);
  const [open, alreadyDelivered] = await Promise.all([
    db
      .select({ orderId: deliveryStops.orderId, runId: deliveryStops.runId, courierName: couriers.name })
      .from(deliveryStops)
      .innerJoin(deliveryRuns, eq(deliveryRuns.id, deliveryStops.runId))
      .innerJoin(couriers, eq(couriers.id, deliveryRuns.courierId))
      .where(and(inArray(deliveryStops.orderId, ids), eq(deliveryStops.status, "pending"))),
    deliveredAwaitingClose(db, ids),
  ]);
  const openByOrder = new Map(open.map((row) => [row.orderId, row]));
  return all
    .filter((order) => !alreadyDelivered.has(order.id))
    .filter((order) =>
      order.dispatchedAt !== null ? now.getTime() - order.dispatchedAt.getTime() <= ELIGIBLE_DISPATCH_MAX_MS : order.window.dayKey >= todayKey,
    )
    .map((order) => ({
      ...order,
      openRunId: openByOrder.get(order.id)?.runId ?? null,
      openRunCourier: openByOrder.get(order.id)?.courierName ?? null,
    }));
}

/** Violação de UNIQUE do Postgres/PGlite (corrida entre duas transações). */
function isUniqueViolation(error: unknown, constraint?: string): boolean {
  if (!error || typeof error !== "object") return false;
  const candidates = [error, (error as { cause?: unknown }).cause];
  return candidates.some((e) => {
    if (!e || typeof e !== "object") return false;
    const code = (e as { code?: unknown }).code;
    const name = (e as { constraint?: unknown }).constraint;
    return code === "23505" && (!constraint || name === constraint || name === undefined);
  });
}

const createRunSchema = z.object({
  courierId: z.uuid(),
  orderIds: z.array(z.uuid()).min(1, "Marque pelo menos um pedido.").max(RUN_MAX_STOPS, `Uma saída leva até ${RUN_MAX_STOPS} pedidos.`),
  userId: z.uuid(),
  now: z.date().optional(),
});

export type CreateDeliveryRunInput = z.input<typeof createRunSchema>;

export interface CreatedDeliveryRun {
  runId: string;
  courierToken: string;
  courierUrl: string;
  stops: { orderId: string; orderNumber: number; sequence: number; alreadyDispatched: boolean }[];
}

function courierLinkBody(input: { courierName: string; storeName: string; stops: number; url: string }): string {
  const plural = input.stops === 1 ? "1 entrega" : `${input.stops} entregas`;
  return [
    `Oi, ${firstNameOf(input.courierName)}! Saída da ${input.storeName} com ${plural}. 🛵`,
    `Abra o link, veja as paradas e toque em "Comecei a rota" ao sair:`,
    input.url,
    ``,
    `Deixe a página aberta durante as entregas: ela compartilha sua localização com a loja e com as clientes só enquanto a saída estiver aberta.`,
  ].join("\n");
}

/**
 * Monta a saída: um motoboy, os pedidos na ordem marcada. Cada pedido recebe
 * o "Saiu" (dispatchOrder — idempotente para quem já saiu, sem segundo aviso
 * à cliente), vira uma parada, e o motoboy recebe o link pela fila. A
 * geocodificação dos endereços vai pela fila também (Nominatim pede 1
 * pedido por segundo — ninguém espera por isso na tela).
 */
export async function createDeliveryRun(db: DbOrTx, input: CreateDeliveryRunInput): Promise<CreatedDeliveryRun> {
  const parsed = createRunSchema.parse(input);
  const now = parsed.now ?? new Date();
  const uniqueIds = [...new Set(parsed.orderIds)];
  return db.transaction(async (tx) => {
    const [courier] = await tx.select().from(couriers).where(eq(couriers.id, parsed.courierId)).limit(1);
    if (!courier) throw new ServiceError("COURIER_NOT_FOUND", "Motoboy não encontrado.");
    if (!courier.isActive) throw new ServiceError("COURIER_INACTIVE", "Este motoboy está desativado.");

    const busy = await tx
      .select({ orderId: deliveryStops.orderId })
      .from(deliveryStops)
      .where(and(inArray(deliveryStops.orderId, uniqueIds), eq(deliveryStops.status, "pending")));
    if (busy.length > 0) {
      throw new ServiceError("ORDER_IN_RUN", "Um dos pedidos já está numa saída aberta.");
    }
    if ((await deliveredAwaitingClose(tx, uniqueIds)).size > 0) {
      throw new ServiceError("ORDER_ALREADY_DELIVERED", "Um dos pedidos já foi entregue pelo motoboy — registre o pagamento e feche na ficha.");
    }

    const [run] = await tx
      .insert(deliveryRuns)
      .values({ courierId: courier.id, createdBy: parsed.userId, status: "ready", createdAt: now, updatedAt: now })
      .returning({ id: deliveryRuns.id, courierToken: deliveryRuns.courierToken });

    const stops: CreatedDeliveryRun["stops"] = [];
    for (const [index, orderId] of uniqueIds.entries()) {
      const dispatched = await dispatchOrder(tx, { orderId, userId: parsed.userId, now });
      const [order] = await tx.select({ shippingAddress: orders.shippingAddress }).from(orders).where(eq(orders.id, orderId)).limit(1);
      try {
        await tx.insert(deliveryStops).values({
          runId: run.id,
          orderId,
          sequence: index + 1,
          destAddress: addressLineOf(order?.shippingAddress).line,
          createdAt: now,
          updatedAt: now,
        });
      } catch (error) {
        // Duas pessoas montando saídas com o mesmo pedido ao mesmo tempo: o
        // índice parcial (um pedido por saída aberta) é o árbitro.
        if (isUniqueViolation(error, "delivery_stops_open_order_idx")) {
          throw new ServiceError("ORDER_IN_RUN", "Um dos pedidos acabou de entrar em outra saída.");
        }
        throw error;
      }
      stops.push({ orderId, orderNumber: dispatched.orderNumber, sequence: index + 1, alreadyDispatched: dispatched.idempotent });
    }

    const url = courierRunUrl(run.courierToken);
    const storeName = await getStoreName(tx);
    await enqueueOutboxEvent(tx, {
      eventType: "wa.send",
      dedupeKey: `wa.courier_link:${run.id}`,
      aggregateType: "delivery_run",
      aggregateId: run.id,
      payload: {
        phoneE164: courier.phoneE164,
        body: courierLinkBody({ courierName: courier.name, storeName, stops: stops.length, url }),
        dedupeKey: `wa.courier_link:${run.id}`,
      },
    });
    await enqueueOutboxEvent(tx, {
      eventType: "delivery_run.geocode",
      dedupeKey: `delivery_run.geocode:${run.id}`,
      aggregateType: "delivery_run",
      aggregateId: run.id,
      payload: { runId: run.id },
    });
    await tx.insert(auditLog).values({
      actorType: "user",
      actorId: parsed.userId,
      action: "delivery_run.create",
      entityType: "delivery_run",
      entityId: run.id,
      after: { courierId: courier.id, orderIds: uniqueIds },
    });
    return { runId: run.id, courierToken: run.courierToken, courierUrl: url, stops };
  });
}

/** Reenvia o link ao motoboy (perdeu a mensagem, trocou de celular). */
export async function resendCourierLink(db: DbOrTx, input: { runId: string; userId: string; now?: Date }): Promise<void> {
  const parsed = z.object({ runId: z.uuid(), userId: z.uuid(), now: z.date().optional() }).parse(input);
  const now = parsed.now ?? new Date();
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: deliveryRuns.id, status: deliveryRuns.status, courierToken: deliveryRuns.courierToken, courierName: couriers.name, phoneE164: couriers.phoneE164, courierActive: couriers.isActive })
      .from(deliveryRuns)
      .innerJoin(couriers, eq(couriers.id, deliveryRuns.courierId))
      .where(eq(deliveryRuns.id, parsed.runId))
      .limit(1);
    if (!row) throw new ServiceError("RUN_NOT_FOUND", "Saída não encontrada.");
    if (!isRunOpen(row.status as RunStatus)) throw new ServiceError("RUN_CLOSED", "Esta saída já foi encerrada.");
    if (!row.courierActive) throw new ServiceError("COURIER_INACTIVE", "Este motoboy foi desativado — cancele a saída e monte outra.");
    const [{ total }] = await tx
      .select({ total: count() })
      .from(deliveryStops)
      .where(and(eq(deliveryStops.runId, row.id), eq(deliveryStops.status, "pending")));
    const storeName = await getStoreName(tx);
    await enqueueOutboxEvent(tx, {
      eventType: "wa.send",
      dedupeKey: `wa.courier_link:${row.id}:${now.getTime()}`,
      aggregateType: "delivery_run",
      aggregateId: row.id,
      payload: {
        phoneE164: row.phoneE164,
        body: courierLinkBody({ courierName: row.courierName, storeName, stops: total, url: courierRunUrl(row.courierToken) }),
        dedupeKey: `wa.courier_link:${row.id}:${now.getTime()}`,
      },
    });
    await tx.insert(auditLog).values({
      actorType: "user",
      actorId: parsed.userId,
      action: "delivery_run.resend_link",
      entityType: "delivery_run",
      entityId: row.id,
    });
  });
}

// ---------------------------------------------------------------------------
// O motoboy na rua (tudo pelo token do link)
// ---------------------------------------------------------------------------

async function lockRunByToken(tx: DbOrTx, courierToken: string, options: { requireOpen?: boolean } = {}) {
  const parsedToken = z.uuid().safeParse(courierToken);
  if (!parsedToken.success) throw new ServiceError("RUN_NOT_FOUND", "Saída não encontrada.");
  const [run] = await tx.select().from(deliveryRuns).where(eq(deliveryRuns.courierToken, parsedToken.data)).for("update");
  if (!run) throw new ServiceError("RUN_NOT_FOUND", "Saída não encontrada.");
  if (options.requireOpen && !isRunOpen(run.status as RunStatus)) {
    throw new ServiceError("RUN_CLOSED", run.status === "canceled" ? "Esta saída foi cancelada pela loja." : "Esta saída já foi encerrada.");
  }
  return run;
}

export async function startDeliveryRun(db: DbOrTx, input: { courierToken: string; now?: Date }): Promise<{ runId: string; idempotent: boolean }> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const run = await lockRunByToken(tx, input.courierToken, { requireOpen: true });
    const status = run.status as RunStatus;
    if (status === "en_route") return { runId: run.id, idempotent: true };
    assertRunTransition(status, "en_route");
    await tx.update(deliveryRuns).set({ status: "en_route", startedAt: now, updatedAt: now }).where(eq(deliveryRuns.id, run.id));
    await tx.insert(auditLog).values({ actorType: "courier", actorId: null, action: "delivery_run.start", entityType: "delivery_run", entityId: run.id });
    return { runId: run.id, idempotent: false };
  });
}

const positionSchema = z.object({
  courierToken: z.string(),
  lat: z.number(),
  lng: z.number(),
  accuracyM: z.number().nullable().optional(),
  speedMps: z.number().nullable().optional(),
  recordedAt: z.date(),
  now: z.date().optional(),
});

export type RecordPositionInput = z.input<typeof positionSchema>;
export type RecordPositionResult = { accepted: true; trail: boolean } | { accepted: false; reason: PositionRejectReason | "not_en_route" };

/** Uma amostra do GPS do motoboy: a última posição da saída sempre; a trilha, com espaçamento. */
export async function recordRunPosition(db: DbOrTx, input: RecordPositionInput): Promise<RecordPositionResult> {
  const parsed = positionSchema.parse(input);
  const now = parsed.now ?? new Date();
  return db.transaction(async (tx) => {
    const run = await lockRunByToken(tx, parsed.courierToken);
    if (run.status !== "en_route") return { accepted: false, reason: "not_en_route" };
    const [lastTrailRow] = await tx
      .select({ lat: deliveryPositions.lat, lng: deliveryPositions.lng, accuracyM: deliveryPositions.accuracyM, recordedAt: deliveryPositions.recordedAt })
      .from(deliveryPositions)
      .where(eq(deliveryPositions.runId, run.id))
      .orderBy(desc(deliveryPositions.recordedAt))
      .limit(1);
    const sample: PositionSample = { lat: parsed.lat, lng: parsed.lng, accuracyM: parsed.accuracyM ?? null, recordedAt: parsed.recordedAt };
    const decision = acceptPosition({
      lastTrail: lastTrailRow ? { ...lastTrailRow, accuracyM: lastTrailRow.accuracyM ?? null } : null,
      sample,
      now,
    });
    if (decision.kind === "reject") return { accepted: false, reason: decision.reason };
    // last_position_at é a hora de CHEGADA (relógio do servidor): é o que o
    // sinal e o "há N min" leem — o relógio do celular pode estar torto.
    await tx
      .update(deliveryRuns)
      .set({ lastLat: sample.lat, lastLng: sample.lng, lastAccuracyM: sample.accuracyM, lastPositionAt: now, updatedAt: now })
      .where(eq(deliveryRuns.id, run.id));
    if (decision.trail) {
      await tx.insert(deliveryPositions).values({
        runId: run.id,
        lat: sample.lat,
        lng: sample.lng,
        accuracyM: sample.accuracyM,
        speedMps: parsed.speedMps ?? null,
        recordedAt: decision.recordedAt,
        createdAt: now,
      });
    }
    return { accepted: true, trail: decision.trail };
  });
}

const stopPositionSchema = z
  .object({ lat: z.number(), lng: z.number(), accuracyM: z.number().nullable().optional() })
  .nullable()
  .optional();

const completeStopSchema = z.object({
  courierToken: z.string(),
  stopId: z.uuid(),
  receivedBy: z.string().max(RECEIVED_BY_MAX_CHARS * 3).nullable().optional(),
  position: stopPositionSchema,
  now: z.date().optional(),
});

export type CompleteStopInput = z.input<typeof completeStopSchema>;

export interface CompleteStopResult {
  stopId: string;
  orderId: string;
  orderNumber: number;
  /** O pedido virou 'delivered' agora (pago). Dinheiro na entrega fica para a dona baixar. */
  orderDelivered: boolean;
  awaitingCash: boolean;
  receivedBy: string | null;
  idempotent: boolean;
}

/**
 * "Entregue" pelo motoboy: a prova (hora, quem recebeu, ponto do GPS) fica
 * na parada e no pedido, e o pedido pago vira 'delivered' pelo caminho de
 * sempre (order.delivered → "entregue, recebido por X" à cliente). Dinheiro
 * na entrega não transiciona: a dona registra o pagamento e fecha.
 */
export async function completeStop(db: DbOrTx, input: CompleteStopInput): Promise<CompleteStopResult> {
  const parsed = completeStopSchema.parse(input);
  const now = parsed.now ?? new Date();
  return db.transaction(async (tx) => {
    const run = await lockRunByToken(tx, parsed.courierToken, { requireOpen: true });
    const [stop] = await tx
      .select()
      .from(deliveryStops)
      .where(and(eq(deliveryStops.id, parsed.stopId), eq(deliveryStops.runId, run.id)))
      .for("update");
    if (!stop) throw new ServiceError("STOP_NOT_FOUND", "Parada não encontrada nesta saída.");
    const [order] = await tx
      .select({ id: orders.id, orderNumber: orders.orderNumber, status: orders.status, paymentMethod: orders.paymentMethod, receivedBy: orders.receivedBy, deliveryConfirmedBy: orders.deliveryConfirmedBy })
      .from(orders)
      .where(eq(orders.id, stop.orderId))
      .for("update");
    if (!order) throw new ServiceError("ORDER_NOT_FOUND", "Pedido não encontrado.");
    const base = { stopId: stop.id, orderId: order.id, orderNumber: order.orderNumber };
    if (stop.status === "delivered") {
      return { ...base, orderDelivered: order.status === "delivered", awaitingCash: order.status === "pending_payment", receivedBy: stop.receivedBy, idempotent: true };
    }
    if (!canCloseStop(run.status as RunStatus, stop.status as StopStatus)) {
      throw new ServiceError("STOP_NOT_OPEN", run.status !== "en_route" ? 'Toque em "Comecei a rota" antes de entregar.' : "Esta parada já foi fechada.");
    }
    if (order.status === "canceled" || order.status === "refunded") {
      throw new ServiceError("ORDER_CANCELED", 'Este pedido foi cancelado pela loja: não entregue — toque em "Não consegui" e traga a peça de volta.');
    }
    const [courier] = await tx.select({ name: couriers.name }).from(couriers).where(eq(couriers.id, run.courierId)).limit(1);
    const receivedBy = normalizeReceivedBy(parsed.receivedBy);
    const point = parsed.position && isValidPoint(parsed.position) ? parsed.position : null;

    await tx
      .update(deliveryStops)
      .set({
        status: "delivered",
        deliveredAt: now,
        receivedBy,
        deliveredLat: point?.lat ?? null,
        deliveredLng: point?.lng ?? null,
        deliveredAccuracyM: point?.accuracyM ?? null,
        updatedAt: now,
      })
      .where(eq(deliveryStops.id, stop.id));
    // A prova entra ANTES da transição: o evento order.delivered (mesma
    // transação) já encontra quem recebeu. Não sobrescreve o que a dona
    // (foto) ou a cliente ("Chegou!") já tinham registrado.
    await tx
      .update(orders)
      .set({
        receivedBy: order.receivedBy ?? receivedBy,
        deliveryConfirmedBy: order.deliveryConfirmedBy ?? "courier",
        updatedAt: now,
      })
      .where(eq(orders.id, order.id));

    const status = order.status as OrderStatus;
    const awaitingCash = status === "pending_payment" && order.paymentMethod === "cash";
    let orderDelivered = status === "delivered";
    if (!awaitingCash && !orderDelivered) {
      await completeDispatchedOrder(tx, {
        orderId: order.id,
        userId: null,
        reason: courier ? `Entregue pelo motoboy ${courier.name}.` : "Entregue pelo motoboy.",
      });
      orderDelivered = true;
    }
    await tx.insert(auditLog).values({
      actorType: "courier",
      actorId: null,
      action: "delivery_stop.deliver",
      entityType: "order",
      entityId: order.id,
      after: { runId: run.id, stopId: stop.id, receivedBy, point, awaitingCash },
    });
    return { ...base, orderDelivered, awaitingCash, receivedBy, idempotent: false };
  });
}

const failStopSchema = z.object({
  courierToken: z.string(),
  stopId: z.uuid(),
  reason: z.enum(FAILURE_REASONS),
  note: z.string().trim().max(FAILURE_NOTE_MAX_CHARS).nullable().optional(),
  now: z.date().optional(),
});

export type FailStopInput = z.input<typeof failStopSchema>;

/** "Não consegui entregar": a parada fecha como falha e a dona é avisada; o pedido fica como está. */
export async function failStop(db: DbOrTx, input: FailStopInput): Promise<{ stopId: string; orderNumber: number; idempotent: boolean }> {
  const parsed = failStopSchema.parse(input);
  const now = parsed.now ?? new Date();
  return db.transaction(async (tx) => {
    const run = await lockRunByToken(tx, parsed.courierToken, { requireOpen: true });
    const [stop] = await tx
      .select({ id: deliveryStops.id, status: deliveryStops.status, orderId: deliveryStops.orderId, orderNumber: orders.orderNumber, customerName: customers.fullName })
      .from(deliveryStops)
      .innerJoin(orders, eq(orders.id, deliveryStops.orderId))
      .innerJoin(customers, eq(customers.id, orders.customerId))
      .where(and(eq(deliveryStops.id, parsed.stopId), eq(deliveryStops.runId, run.id)))
      .for("update", { of: deliveryStops });
    if (!stop) throw new ServiceError("STOP_NOT_FOUND", "Parada não encontrada nesta saída.");
    if (stop.status === "failed") return { stopId: stop.id, orderNumber: stop.orderNumber, idempotent: true };
    if (!canCloseStop(run.status as RunStatus, stop.status as StopStatus)) {
      throw new ServiceError("STOP_NOT_OPEN", run.status !== "en_route" ? 'Toque em "Comecei a rota" antes.' : "Esta parada já foi fechada.");
    }
    const [courier] = await tx.select({ name: couriers.name }).from(couriers).where(eq(couriers.id, run.courierId)).limit(1);
    const note = parsed.note?.trim() || null;
    await tx
      .update(deliveryStops)
      .set({ status: "failed", failureReason: parsed.reason, failureNote: note, updatedAt: now })
      .where(eq(deliveryStops.id, stop.id));
    const body = [
      `🛵 ${courier?.name ?? "O motoboy"} não conseguiu entregar o pedido #${stop.orderNumber} (${firstNameOf(stop.customerName)}): ${FAILURE_REASON_LABELS[parsed.reason]}.`,
      note ? `Nota: ${note}` : null,
      `O pedido continua como está — combine com a cliente e reagende na Rota do dia.`,
    ]
      .filter(Boolean)
      .join("\n");
    await enqueueOutboxEvent(tx, {
      eventType: "wa.owner_forward",
      dedupeKey: `wa.stop_failed:${stop.id}`,
      aggregateType: "delivery_run",
      aggregateId: run.id,
      payload: { body, raw: true, dedupeKey: `wa.stop_failed:${stop.id}` },
    });
    await tx.insert(auditLog).values({
      actorType: "courier",
      actorId: null,
      action: "delivery_stop.fail",
      entityType: "order",
      entityId: stop.orderId,
      after: { runId: run.id, stopId: stop.id, reason: parsed.reason, note },
    });
    return { stopId: stop.id, orderNumber: stop.orderNumber, idempotent: false };
  });
}

/** O motoboy encerra a saída (só sem parada por entregar); a dona pode encerrar pelo painel. */
export async function finishDeliveryRun(
  db: DbOrTx,
  input: { courierToken: string; now?: Date } | { runId: string; userId: string; now?: Date },
): Promise<{ runId: string; idempotent: boolean }> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const run =
      "courierToken" in input
        ? await lockRunByToken(tx, input.courierToken)
        : (await tx.select().from(deliveryRuns).where(eq(deliveryRuns.id, z.uuid().parse(input.runId))).for("update"))[0];
    if (!run) throw new ServiceError("RUN_NOT_FOUND", "Saída não encontrada.");
    const status = run.status as RunStatus;
    if (status === "finished") return { runId: run.id, idempotent: true };
    assertRunTransition(status, "finished");
    const stops = await tx.select({ status: deliveryStops.status }).from(deliveryStops).where(eq(deliveryStops.runId, run.id));
    if (!runCanFinish(stops.map((s) => ({ status: s.status as StopStatus })))) {
      throw new ServiceError("STOPS_PENDING", "Ainda há parada por entregar — marque cada uma como entregue ou não entregue.");
    }
    await tx.update(deliveryRuns).set({ status: "finished", finishedAt: now, updatedAt: now }).where(eq(deliveryRuns.id, run.id));
    await tx.insert(auditLog).values({
      actorType: "courierToken" in input ? "courier" : "user",
      actorId: "courierToken" in input ? null : input.userId,
      action: "delivery_run.finish",
      entityType: "delivery_run",
      entityId: run.id,
    });
    return { runId: run.id, idempotent: false };
  });
}

/**
 * Cancela a saída pelo painel: as paradas por entregar fecham como
 * canceladas e o link do motoboy morre. O "Saiu" dos pedidos NÃO volta (a
 * máquina não tem shipped → preparing): eles seguem no fluxo manual.
 */
export async function cancelDeliveryRun(db: DbOrTx, input: { runId: string; userId: string; now?: Date }): Promise<{ runId: string; idempotent: boolean }> {
  const parsed = z.object({ runId: z.uuid(), userId: z.uuid(), now: z.date().optional() }).parse(input);
  const now = parsed.now ?? new Date();
  return db.transaction(async (tx) => {
    const [run] = await tx.select().from(deliveryRuns).where(eq(deliveryRuns.id, parsed.runId)).for("update");
    if (!run) throw new ServiceError("RUN_NOT_FOUND", "Saída não encontrada.");
    const status = run.status as RunStatus;
    if (status === "canceled") return { runId: run.id, idempotent: true };
    assertRunTransition(status, "canceled");
    await tx.update(deliveryRuns).set({ status: "canceled", canceledAt: now, updatedAt: now }).where(eq(deliveryRuns.id, run.id));
    await tx
      .update(deliveryStops)
      .set({ status: "canceled", updatedAt: now })
      .where(and(eq(deliveryStops.runId, run.id), eq(deliveryStops.status, "pending")));
    await tx.insert(auditLog).values({
      actorType: "user",
      actorId: parsed.userId,
      action: "delivery_run.cancel",
      entityType: "delivery_run",
      entityId: run.id,
      before: { status },
    });
    return { runId: run.id, idempotent: false };
  });
}

// ---------------------------------------------------------------------------
// Leituras
// ---------------------------------------------------------------------------

export interface CourierStop {
  id: string;
  sequence: number;
  status: StopStatus;
  orderNumber: number;
  customerName: string;
  phoneE164: string | null;
  addressLine: string | null;
  postalCode: string | null;
  windowLabel: string | null;
  itemsCount: number;
  itemsSummary: string[];
  collectCashCents: number | null;
  isGift: boolean;
  navigation: { googleMaps: string; waze: string } | null;
  deliveredAt: Date | null;
  receivedBy: string | null;
  failureReason: FailureReason | null;
}

export interface CourierRunView {
  runId: string;
  status: RunStatus;
  courierName: string;
  storeName: string;
  startedAt: Date | null;
  stops: CourierStop[];
  /** Nenhuma parada por entregar: pode encerrar. */
  canFinish: boolean;
}

/** A página do motoboy: tudo que ele precisa para entregar; nada depois de encerrada. */
export async function getRunForCourier(db: DbOrTx, courierToken: string): Promise<CourierRunView | null> {
  const parsedToken = z.uuid().safeParse(courierToken);
  if (!parsedToken.success) return null;
  const [run] = await db
    .select({ id: deliveryRuns.id, status: deliveryRuns.status, startedAt: deliveryRuns.startedAt, courierName: couriers.name })
    .from(deliveryRuns)
    .innerJoin(couriers, eq(couriers.id, deliveryRuns.courierId))
    .where(eq(deliveryRuns.courierToken, parsedToken.data))
    .limit(1);
  if (!run) return null;
  const storeName = await getStoreName(db);
  const status = run.status as RunStatus;
  if (!isRunOpen(status)) return { runId: run.id, status, courierName: run.courierName, storeName, startedAt: run.startedAt, stops: [], canFinish: false };

  const rows = await db
    .select({
      id: deliveryStops.id,
      sequence: deliveryStops.sequence,
      status: deliveryStops.status,
      destAddress: deliveryStops.destAddress,
      destLat: deliveryStops.destLat,
      destLng: deliveryStops.destLng,
      deliveredAt: deliveryStops.deliveredAt,
      receivedBy: deliveryStops.receivedBy,
      failureReason: deliveryStops.failureReason,
      orderId: orders.id,
      orderNumber: orders.orderNumber,
      orderStatus: orders.status,
      paymentMethod: orders.paymentMethod,
      totalCents: orders.totalCents,
      isGift: orders.isGift,
      deliveryWindow: orders.deliveryWindow,
      shippingAddress: orders.shippingAddress,
      customerName: customers.fullName,
      phoneE164: customers.phoneE164,
    })
    .from(deliveryStops)
    .innerJoin(orders, eq(orders.id, deliveryStops.orderId))
    .innerJoin(customers, eq(customers.id, orders.customerId))
    .where(eq(deliveryStops.runId, run.id))
    .orderBy(asc(deliveryStops.sequence));
  const items = await summarizeOrderItems(db, rows.map((row) => row.orderId));
  const stops: CourierStop[] = rows.map((row) => {
    const address = addressLineOf(row.shippingAddress);
    const addressLine = row.destAddress ?? address.line;
    const point = row.destLat !== null && row.destLng !== null ? { lat: row.destLat, lng: row.destLng } : null;
    const paymentMethod = (row.paymentMethod ?? null) as PaymentMethod | null;
    return {
      id: row.id,
      sequence: row.sequence,
      status: row.status as StopStatus,
      orderNumber: row.orderNumber,
      customerName: row.customerName,
      phoneE164: row.phoneE164,
      addressLine,
      postalCode: address.postalCode,
      windowLabel: row.deliveryWindow ? (row.deliveryWindow.label ?? windowDateLabel(row.deliveryWindow)) : null,
      itemsCount: items.get(row.orderId)?.count ?? 0,
      itemsSummary: items.get(row.orderId)?.lines ?? [],
      collectCashCents: paymentMethod === "cash" && row.orderStatus === "pending_payment" ? row.totalCents : null,
      isGift: row.isGift,
      navigation: addressLine ? { googleMaps: googleMapsDirectionsUrl({ address: addressLine, point }), waze: wazeUrl({ address: addressLine, point }) } : null,
      deliveredAt: row.deliveredAt,
      receivedBy: row.receivedBy,
      failureReason: (row.failureReason ?? null) as FailureReason | null,
    };
  });
  return {
    runId: run.id,
    status,
    courierName: run.courierName,
    storeName,
    startedAt: run.startedAt,
    stops,
    canFinish: status === "en_route" && runCanFinish(stops),
  };
}

/** A leitura pública da entrega pelo token do pedido (null = o pedido não está numa saída). */
export async function getTrackingForOrder(db: DbOrTx, publicToken: string, now = new Date()): Promise<TrackingView | null> {
  const parsedToken = z.uuid().safeParse(publicToken);
  if (!parsedToken.success) return null;
  const [row] = await db
    .select({
      stopId: deliveryStops.id,
      stopStatus: deliveryStops.status,
      destLat: deliveryStops.destLat,
      destLng: deliveryStops.destLng,
      deliveredAt: deliveryStops.deliveredAt,
      receivedBy: deliveryStops.receivedBy,
      runId: deliveryRuns.id,
      runStatus: deliveryRuns.status,
      lastLat: deliveryRuns.lastLat,
      lastLng: deliveryRuns.lastLng,
      lastAccuracyM: deliveryRuns.lastAccuracyM,
      lastPositionAt: deliveryRuns.lastPositionAt,
      courierName: couriers.name,
    })
    .from(deliveryStops)
    .innerJoin(orders, eq(orders.id, deliveryStops.orderId))
    .innerJoin(deliveryRuns, eq(deliveryRuns.id, deliveryStops.runId))
    .innerJoin(couriers, eq(couriers.id, deliveryRuns.courierId))
    .where(and(eq(orders.publicToken, parsedToken.data), ne(deliveryStops.status, "canceled")))
    .orderBy(desc(deliveryStops.createdAt))
    .limit(1);
  if (!row) return null;
  const [{ pending }] = await db
    .select({ pending: count() })
    .from(deliveryStops)
    .where(and(eq(deliveryStops.runId, row.runId), eq(deliveryStops.status, "pending"), ne(deliveryStops.id, row.stopId)));
  // A última OUTRA parada fechada (entregue ou não): o motoboy ainda está na porta dela.
  const [lastClosed] = await db
    .select({ at: deliveryStops.updatedAt })
    .from(deliveryStops)
    .where(and(eq(deliveryStops.runId, row.runId), inArray(deliveryStops.status, ["delivered", "failed"]), ne(deliveryStops.id, row.stopId)))
    .orderBy(desc(deliveryStops.updatedAt))
    .limit(1);
  return buildTrackingView({
    run: {
      status: row.runStatus as RunStatus,
      courierFirstName: firstNameOf(row.courierName),
      lastPosition:
        row.lastLat !== null && row.lastLng !== null && row.lastPositionAt
          ? { lat: row.lastLat, lng: row.lastLng, accuracyM: row.lastAccuracyM ?? null, seenAt: row.lastPositionAt }
          : null,
    },
    stop: {
      status: row.stopStatus as StopStatus,
      destination: row.destLat !== null && row.destLng !== null ? { lat: row.destLat, lng: row.destLng } : null,
      deliveredAt: row.deliveredAt,
      receivedBy: row.receivedBy,
    },
    otherStopsPending: pending,
    otherStopClosedAgoMs: lastClosed ? Math.max(0, now.getTime() - lastClosed.at.getTime()) : null,
    coarseSeed: row.runId,
    now,
  });
}

export interface DeliveryRunSummary {
  id: string;
  status: RunStatus;
  courierName: string;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  stopsTotal: number;
  stopsDelivered: number;
  stopsFailed: number;
  lastPositionAt: Date | null;
}

export async function listDeliveryRuns(db: DbOrTx, input: { limit?: number } = {}): Promise<DeliveryRunSummary[]> {
  const limit = Math.min(200, Math.max(1, input.limit ?? 50));
  const runs = await db
    .select({
      id: deliveryRuns.id,
      status: deliveryRuns.status,
      createdAt: deliveryRuns.createdAt,
      startedAt: deliveryRuns.startedAt,
      finishedAt: deliveryRuns.finishedAt,
      lastPositionAt: deliveryRuns.lastPositionAt,
      courierName: couriers.name,
    })
    .from(deliveryRuns)
    .innerJoin(couriers, eq(couriers.id, deliveryRuns.courierId))
    .orderBy(desc(deliveryRuns.createdAt))
    .limit(limit);
  if (runs.length === 0) return [];
  const stops = await db
    .select({ runId: deliveryStops.runId, status: deliveryStops.status })
    .from(deliveryStops)
    .where(inArray(deliveryStops.runId, runs.map((r) => r.id)));
  return runs.map((run) => {
    const own = stops.filter((s) => s.runId === run.id);
    return {
      id: run.id,
      status: run.status as RunStatus,
      courierName: run.courierName,
      createdAt: run.createdAt,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      stopsTotal: own.length,
      stopsDelivered: own.filter((s) => s.status === "delivered").length,
      stopsFailed: own.filter((s) => s.status === "failed").length,
      lastPositionAt: run.lastPositionAt,
    };
  });
}

export interface DeliveryRunDetail {
  id: string;
  status: RunStatus;
  courier: { id: string; name: string; phoneE164: string };
  courierToken: string;
  courierUrl: string;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  canceledAt: Date | null;
  lastPosition: { lat: number; lng: number; accuracyM: number | null; recordedAt: Date } | null;
  stops: (CourierStop & { orderId: string; destination: { lat: number; lng: number } | null; deliveredPoint: { lat: number; lng: number; accuracyM: number | null } | null; failureNote: string | null })[];
  /** Os últimos pontos da trilha, do mais antigo ao mais novo. */
  trail: { lat: number; lng: number; recordedAt: Date }[];
}

const TRAIL_LIMIT = 500;

/** A saída para o painel: paradas com a prova, o motoboy e a trilha. */
export async function getDeliveryRun(db: DbOrTx, runId: string): Promise<DeliveryRunDetail | null> {
  const parsedId = z.uuid().safeParse(runId);
  if (!parsedId.success) return null;
  const [run] = await db
    .select({
      id: deliveryRuns.id,
      status: deliveryRuns.status,
      courierToken: deliveryRuns.courierToken,
      createdAt: deliveryRuns.createdAt,
      startedAt: deliveryRuns.startedAt,
      finishedAt: deliveryRuns.finishedAt,
      canceledAt: deliveryRuns.canceledAt,
      lastLat: deliveryRuns.lastLat,
      lastLng: deliveryRuns.lastLng,
      lastAccuracyM: deliveryRuns.lastAccuracyM,
      lastPositionAt: deliveryRuns.lastPositionAt,
      courierId: couriers.id,
      courierName: couriers.name,
      courierPhone: couriers.phoneE164,
    })
    .from(deliveryRuns)
    .innerJoin(couriers, eq(couriers.id, deliveryRuns.courierId))
    .where(eq(deliveryRuns.id, parsedId.data))
    .limit(1);
  if (!run) return null;
  const view = await getRunForCourier(db, run.courierToken);
  const extra = await db
    .select({
      id: deliveryStops.id,
      orderId: deliveryStops.orderId,
      destLat: deliveryStops.destLat,
      destLng: deliveryStops.destLng,
      deliveredLat: deliveryStops.deliveredLat,
      deliveredLng: deliveryStops.deliveredLng,
      deliveredAccuracyM: deliveryStops.deliveredAccuracyM,
      failureNote: deliveryStops.failureNote,
    })
    .from(deliveryStops)
    .where(eq(deliveryStops.runId, run.id));
  const extraById = new Map(extra.map((row) => [row.id, row]));
  // Saída encerrada: a leitura do motoboy vem vazia, mas o painel ainda mostra as paradas.
  const stops = (view && view.stops.length > 0 ? view.stops : await closedRunStops(db, run.id)).map((stop) => {
    const e = extraById.get(stop.id);
    return {
      ...stop,
      orderId: e?.orderId ?? "",
      destination: e && e.destLat !== null && e.destLng !== null ? { lat: e.destLat, lng: e.destLng } : null,
      deliveredPoint: e && e.deliveredLat !== null && e.deliveredLng !== null ? { lat: e.deliveredLat, lng: e.deliveredLng, accuracyM: e.deliveredAccuracyM ?? null } : null,
      failureNote: e?.failureNote ?? null,
    };
  });
  const trailRows = await db
    .select({ lat: deliveryPositions.lat, lng: deliveryPositions.lng, recordedAt: deliveryPositions.recordedAt })
    .from(deliveryPositions)
    .where(eq(deliveryPositions.runId, run.id))
    .orderBy(desc(deliveryPositions.recordedAt))
    .limit(TRAIL_LIMIT);
  return {
    id: run.id,
    status: run.status as RunStatus,
    courier: { id: run.courierId, name: run.courierName, phoneE164: run.courierPhone },
    courierToken: run.courierToken,
    courierUrl: courierRunUrl(run.courierToken),
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    canceledAt: run.canceledAt,
    lastPosition:
      run.lastLat !== null && run.lastLng !== null && run.lastPositionAt
        ? { lat: run.lastLat, lng: run.lastLng, accuracyM: run.lastAccuracyM ?? null, recordedAt: run.lastPositionAt }
        : null,
    stops,
    trail: trailRows.reverse(),
  };
}

/** As paradas de uma saída já encerrada (a leitura do motoboy não as devolve). */
async function closedRunStops(db: DbOrTx, runId: string): Promise<CourierStop[]> {
  const rows = await db
    .select({
      id: deliveryStops.id,
      sequence: deliveryStops.sequence,
      status: deliveryStops.status,
      destAddress: deliveryStops.destAddress,
      deliveredAt: deliveryStops.deliveredAt,
      receivedBy: deliveryStops.receivedBy,
      failureReason: deliveryStops.failureReason,
      orderId: orders.id,
      orderNumber: orders.orderNumber,
      isGift: orders.isGift,
      deliveryWindow: orders.deliveryWindow,
      customerName: customers.fullName,
      phoneE164: customers.phoneE164,
    })
    .from(deliveryStops)
    .innerJoin(orders, eq(orders.id, deliveryStops.orderId))
    .innerJoin(customers, eq(customers.id, orders.customerId))
    .where(eq(deliveryStops.runId, runId))
    .orderBy(asc(deliveryStops.sequence));
  const items = await summarizeOrderItems(db, rows.map((row) => row.orderId));
  return rows.map((row) => ({
    id: row.id,
    sequence: row.sequence,
    status: row.status as StopStatus,
    orderNumber: row.orderNumber,
    customerName: row.customerName,
    phoneE164: row.phoneE164,
    addressLine: row.destAddress,
    postalCode: null,
    windowLabel: row.deliveryWindow ? (row.deliveryWindow.label ?? windowDateLabel(row.deliveryWindow)) : null,
    itemsCount: items.get(row.orderId)?.count ?? 0,
    itemsSummary: items.get(row.orderId)?.lines ?? [],
    collectCashCents: null,
    isGift: row.isGift,
    navigation: null,
    deliveredAt: row.deliveredAt,
    receivedBy: row.receivedBy,
    failureReason: (row.failureReason ?? null) as FailureReason | null,
  }));
}

export interface OrderStopProof {
  runId: string;
  stopId: string;
  runStatus: RunStatus;
  stopStatus: StopStatus;
  courierName: string;
  deliveredAt: Date | null;
  receivedBy: string | null;
  deliveredPoint: { lat: number; lng: number; accuracyM: number | null } | null;
  failureReason: FailureReason | null;
  failureNote: string | null;
}

/** A última saída em que o pedido esteve (ficha do pedido no painel). */
export async function getStopForOrder(db: DbOrTx, orderId: string): Promise<OrderStopProof | null> {
  const parsedId = z.uuid().safeParse(orderId);
  if (!parsedId.success) return null;
  const [row] = await db
    .select({
      runId: deliveryRuns.id,
      stopId: deliveryStops.id,
      runStatus: deliveryRuns.status,
      stopStatus: deliveryStops.status,
      courierName: couriers.name,
      deliveredAt: deliveryStops.deliveredAt,
      receivedBy: deliveryStops.receivedBy,
      deliveredLat: deliveryStops.deliveredLat,
      deliveredLng: deliveryStops.deliveredLng,
      deliveredAccuracyM: deliveryStops.deliveredAccuracyM,
      failureReason: deliveryStops.failureReason,
      failureNote: deliveryStops.failureNote,
    })
    .from(deliveryStops)
    .innerJoin(deliveryRuns, eq(deliveryRuns.id, deliveryStops.runId))
    .innerJoin(couriers, eq(couriers.id, deliveryRuns.courierId))
    .where(eq(deliveryStops.orderId, parsedId.data))
    // A parada cancelada só aparece se não houver outra: a prova (entregue /
    // não entregue) de uma saída anterior vale mais.
    .orderBy(sql`case when ${deliveryStops.status} = 'canceled' then 1 else 0 end`, desc(deliveryStops.createdAt))
    .limit(1);
  if (!row) return null;
  return {
    runId: row.runId,
    stopId: row.stopId,
    runStatus: row.runStatus as RunStatus,
    stopStatus: row.stopStatus as StopStatus,
    courierName: row.courierName,
    deliveredAt: row.deliveredAt,
    receivedBy: row.receivedBy,
    deliveredPoint: row.deliveredLat !== null && row.deliveredLng !== null ? { lat: row.deliveredLat, lng: row.deliveredLng, accuracyM: row.deliveredAccuracyM ?? null } : null,
    failureReason: (row.failureReason ?? null) as FailureReason | null,
    failureNote: row.failureNote,
  };
}

// ---------------------------------------------------------------------------
// Fila: geocodificação e retenção
// ---------------------------------------------------------------------------

const storedAddressSchema = z
  .object({
    postalCode: z.string().optional(),
    street: z.string().optional(),
    number: z.string().optional(),
    district: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
  })
  .partial();

/** Nominatim: ≤ 1 pedido por segundo. */
export const GEOCODE_SPACING_MS = 1_100;
/** Paradas por execução do handler: cabe no orçamento da varredura (~8 × 3 s). */
export const GEOCODE_MAX_STOPS_PER_RUN = 8;
/** Com menos que isso até o prazo, não começa outra parada (pausa + 2 consultas de 5 s + pausa entre elas). */
const GEOCODE_STOP_BUDGET_MS = 13_000;
/** Rodadas do geocode por saída: ceil(30 paradas / 8) com folga. */
export const GEOCODE_MAX_ROUNDS = 6;

/**
 * Geocodifica as paradas sem coordenada, uma por vez, com pausa entre elas,
 * até `maxStops` ou até o prazo do worker chegar perto. Devolve quantas
 * ficaram para a próxima rodada (o handler re-enfileira). Falha de uma parada
 * não derruba as outras; o que não achou fica null (e entra de novo se
 * houver outra rodada — a lista encolhe a cada rodada, então termina).
 */
export async function geocodeRunStops(
  db: DbOrTx,
  geocoder: Geocoder,
  input: {
    runId: string;
    /** Paradas já tentadas em rodadas anteriores: a rodada avança por tentativa, não por pino (senão, endereço sem cobertura vira loop). */
    skipStopIds?: readonly string[];
    sleep?: (ms: number) => Promise<void>;
    deadlineAt?: Date | null;
    maxStops?: number;
    now?: () => Date;
  },
): Promise<{ attempted: number; found: number; remaining: number; attemptedIds: string[]; runOpen: boolean }> {
  const runId = z.uuid().parse(input.runId);
  const skip = new Set(input.skipStopIds ?? []);
  const sleep = input.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const clock = input.now ?? (() => new Date());
  const maxStops = input.maxStops ?? GEOCODE_MAX_STOPS_PER_RUN;
  const [run] = await db.select({ status: deliveryRuns.status }).from(deliveryRuns).where(eq(deliveryRuns.id, runId)).limit(1);
  const runOpen = run ? isRunOpen(run.status as RunStatus) : false;
  if (!runOpen) return { attempted: 0, found: 0, remaining: 0, attemptedIds: [], runOpen };
  const rows = await db
    .select({ id: deliveryStops.id, destLat: deliveryStops.destLat, shippingAddress: orders.shippingAddress })
    .from(deliveryStops)
    .innerJoin(orders, eq(orders.id, deliveryStops.orderId))
    .where(eq(deliveryStops.runId, runId))
    .orderBy(asc(deliveryStops.sequence));
  const pending = rows.flatMap((row) => {
    if (row.destLat !== null || skip.has(row.id)) return [];
    const address = storedAddressSchema.safeParse(row.shippingAddress);
    if (!address.success || !address.data.street || !address.data.city) return [];
    return [{ id: row.id, address: address.data }];
  });
  let attempted = 0;
  let found = 0;
  const attemptedIds: string[] = [];
  for (const row of pending) {
    if (attempted >= maxStops) break;
    if (input.deadlineAt && input.deadlineAt.getTime() - clock().getTime() < GEOCODE_STOP_BUDGET_MS) break;
    if (attempted > 0) await sleep(GEOCODE_SPACING_MS);
    attempted += 1;
    attemptedIds.push(row.id);
    const point = await geocoder.geocode({
      street: row.address.street ?? "",
      number: row.address.number ?? "",
      district: row.address.district ?? "",
      city: row.address.city ?? "",
      state: row.address.state ?? "",
      postalCode: row.address.postalCode ?? null,
    });
    if (!point || !isValidPoint(point)) continue;
    found += 1;
    await db.update(deliveryStops).set({ destLat: point.lat, destLng: point.lng, updatedAt: clock() }).where(eq(deliveryStops.id, row.id));
  }
  return { attempted, found, remaining: pending.length - attempted, attemptedIds, runOpen };
}

export const POSITIONS_RETENTION_DAYS = 30;

/**
 * A trilha some depois de 30 dias (pela hora de chegada ao servidor — o
 * relógio do celular não manda aqui) e a última posição das saídas fechadas
 * há mais de 30 dias também: ela é onde o motoboy tocou "Encerrar", não a
 * prova. A prova (ponto da entrega) fica na parada.
 */
export async function purgeOldDeliveryPositions(db: DbOrTx, input: { now?: Date; days?: number } = {}): Promise<{ deleted: number; runsCleared: number }> {
  const now = input.now ?? new Date();
  const days = input.days ?? POSITIONS_RETENTION_DAYS;
  const cutoff = new Date(now.getTime() - days * 86_400_000);
  const deleted = await db.delete(deliveryPositions).where(lt(deliveryPositions.createdAt, cutoff)).returning({ id: deliveryPositions.id });
  const cleared = await db
    .update(deliveryRuns)
    .set({ lastLat: null, lastLng: null, lastAccuracyM: null })
    .where(and(inArray(deliveryRuns.status, ["finished", "canceled"]), lt(deliveryRuns.updatedAt, cutoff), sql`${deliveryRuns.lastLat} IS NOT NULL`))
    .returning({ id: deliveryRuns.id });
  return { deleted: deleted.length, runsCleared: cleared.length };
}

export const STALE_RUN_HOURS = 24;
/** Saída velha mas com posição/parada nas últimas 2 h ainda está em uso: não fecha. */
export const STALE_RUN_IDLE_HOURS = 2;

/**
 * Saída esquecida aberta (ninguém encerrou nem cancelou): criada há mais de
 * 24 h E parada há mais de 2 h (updated_at muda com posição, "Comecei" e
 * cada parada fechada) fecha sozinha — encerra se não sobrou parada, cancela
 * as pendentes se sobrou — e avisa a dona. Sem isso, o link do motoboy e a
 * posição dele ficariam vivos indefinidamente.
 */
export async function closeStaleDeliveryRuns(db: DbOrTx, input: { now?: Date; hours?: number } = {}): Promise<{ closed: number }> {
  const now = input.now ?? new Date();
  const cutoff = new Date(now.getTime() - (input.hours ?? STALE_RUN_HOURS) * 3_600_000);
  const idleCutoff = new Date(now.getTime() - STALE_RUN_IDLE_HOURS * 3_600_000);
  const stale = await db
    .select({ id: deliveryRuns.id })
    .from(deliveryRuns)
    .where(and(inArray(deliveryRuns.status, ["ready", "en_route"]), lt(deliveryRuns.createdAt, cutoff), lt(deliveryRuns.updatedAt, idleCutoff)))
    .limit(50);
  let closed = 0;
  for (const candidate of stale) {
    const done = await db.transaction(async (tx) => {
      const [run] = await tx
        .select({ id: deliveryRuns.id, status: deliveryRuns.status, courierName: couriers.name, updatedAt: deliveryRuns.updatedAt })
        .from(deliveryRuns)
        .innerJoin(couriers, eq(couriers.id, deliveryRuns.courierId))
        .where(eq(deliveryRuns.id, candidate.id))
        .for("update", { of: deliveryRuns });
      if (!run || !isRunOpen(run.status as RunStatus) || run.updatedAt.getTime() >= idleCutoff.getTime()) return false;
      const stops = await tx.select({ status: deliveryStops.status }).from(deliveryStops).where(eq(deliveryStops.runId, run.id));
      const pending = stops.filter((s) => s.status === "pending").length;
      const finish = run.status === "en_route" && pending === 0;
      assertRunTransition(run.status as RunStatus, finish ? "finished" : "canceled");
      if (finish) {
        await tx.update(deliveryRuns).set({ status: "finished", finishedAt: now, updatedAt: now }).where(eq(deliveryRuns.id, run.id));
      } else {
        await tx.update(deliveryRuns).set({ status: "canceled", canceledAt: now, updatedAt: now }).where(eq(deliveryRuns.id, run.id));
        await tx.update(deliveryStops).set({ status: "canceled", updatedAt: now }).where(and(eq(deliveryStops.runId, run.id), eq(deliveryStops.status, "pending")));
      }
      await enqueueOutboxEvent(tx, {
        eventType: "wa.owner_forward",
        dedupeKey: `wa.run_stale:${run.id}`,
        aggregateType: "delivery_run",
        aggregateId: run.id,
        payload: {
          raw: true,
          dedupeKey: `wa.run_stale:${run.id}`,
          body: finish
            ? `🛵 A saída de ${run.courierName} ficou aberta mais de 24 h sem "Encerrar" — encerrei por você.`
            : `🛵 A saída de ${run.courierName} ficou aberta mais de 24 h com ${pending} parada${pending === 1 ? "" : "s"} por entregar — cancelei a saída; os pedidos continuam como saídos. Veja a Rota do dia.`,
        },
      });
      await tx.insert(auditLog).values({
        actorType: "system",
        actorId: null,
        action: finish ? "delivery_run.finish" : "delivery_run.cancel",
        entityType: "delivery_run",
        entityId: run.id,
        reason: "Saída aberta há mais de 24 h e parada há mais de 2 h.",
      });
      return true;
    });
    if (done) closed += 1;
  }
  return { closed };
}
