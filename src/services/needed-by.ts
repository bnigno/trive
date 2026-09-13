// Data marcada no painel: os pedidos que precisam sair até um dia, com
// semáforo (vermelho = sai hoje ou atrasou; âmbar = amanhã; verde = no
// prazo), o contador do dashboard/Bom dia e as Datas da cidade com o selo
// da vitrine. A régua é pura (core/shipping/needed-by).
import { and, asc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";

import type { OrderStatus } from "@/core/orders/state-machine";
import {
  citySealFor,
  cityDatesSchema,
  neededByLabel,
  shipByLabel,
  trafficLight,
  type CityDate,
  type CitySeal,
  type TrafficLight,
} from "@/core/shipping/needed-by";
import { customers, orders, shippingRates } from "@/db/schema";
import { spDayKey } from "@/lib/sp-day";
import type { DbOrTx } from "@/queue/enqueue";
import { getSettingsMap } from "@/services/settings";

export interface NeededByOrder {
  id: string;
  orderNumber: number;
  status: OrderStatus;
  customerName: string;
  neededBy: string;
  occasion: string | null;
  /** "Para o dia 16/10 — aniversário da mãe" */
  neededByLabel: string;
  shipBy: string;
  shipByLabel: string;
  light: TrafficLight;
  isGift: boolean;
  isMotoboy: boolean;
  /** Já saiu (motoboy) ou já foi enviado. */
  dispatched: boolean;
  totalCents: number;
}

/** Pedidos por sair: pagos, em separação e dinheiro na entrega (ainda aguardando). */
const openStatusFilter = () =>
  or(inArray(orders.status, ["paid", "preparing"]), and(eq(orders.status, "pending_payment"), eq(orders.paymentMethod, "cash")))!;

/** Os pedidos com data marcada ainda por sair, do mais urgente ao mais folgado. */
export async function listOrdersWithNeededBy(db: DbOrTx, input: { now?: Date } = {}): Promise<NeededByOrder[]> {
  const todayKey = spDayKey(input.now ?? new Date());
  const rows = await db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      status: orders.status,
      neededBy: orders.neededBy,
      occasion: orders.occasion,
      shipBy: orders.shipBy,
      isGift: orders.isGift,
      deliveryWindow: orders.deliveryWindow,
      totalCents: orders.totalCents,
      customerName: customers.fullName,
    })
    .from(orders)
    .innerJoin(customers, eq(customers.id, orders.customerId))
    .where(and(openStatusFilter(), isNotNull(orders.neededBy)))
    .orderBy(asc(orders.shipBy), asc(orders.neededBy), asc(orders.orderNumber));
  return rows
    .filter((row): row is typeof row & { neededBy: string } => row.neededBy !== null)
    .map((row) => {
      const shipBy = row.shipBy ?? row.neededBy;
      return {
        id: row.id,
        orderNumber: row.orderNumber,
        status: row.status as OrderStatus,
        customerName: row.customerName,
        neededBy: row.neededBy,
        occasion: row.occasion,
        neededByLabel: neededByLabel(row.neededBy, row.occasion),
        shipBy,
        shipByLabel: shipByLabel(shipBy, todayKey),
        light: trafficLight(shipBy, todayKey),
        isGift: row.isGift,
        isMotoboy: row.deliveryWindow !== null,
        dispatched: Boolean(row.deliveryWindow?.dispatchedAt),
        totalCents: row.totalCents,
      };
    });
}

/** Quantos precisam sair hoje (ou já atrasaram) e ainda não saíram. */
export async function countOrdersMustShipToday(db: DbOrTx, input: { now?: Date } = {}): Promise<number> {
  const todayKey = spDayKey(input.now ?? new Date());
  const [row] = await db
    .select({ value: sql<string>`count(*)` })
    .from(orders)
    .where(
      and(
        openStatusFilter(),
        isNotNull(orders.neededBy),
        isNotNull(orders.shipBy),
        sql`${orders.shipBy} <= ${todayKey}::date`,
        sql`coalesce(${orders.deliveryWindow}->>'dispatchedAt', '') = ''`,
      ),
    );
  return Number(row?.value ?? 0);
}

// ---------------------------------------------------------------------------
// Datas da cidade e o selo
// ---------------------------------------------------------------------------

export async function getCityDates(db: DbOrTx): Promise<CityDate[]> {
  const map = await getSettingsMap(db, ["city_dates"]);
  const parsed = cityDatesSchema.safeParse(map.city_dates);
  return parsed.success ? parsed.data : [];
}

/** Maior prazo (dias úteis) entre as faixas de Correios ativas — a régua do selo. 0 sem faixas. */
export async function getDeliveryHorizonDays(db: DbOrTx): Promise<number> {
  const [row] = await db
    .select({ value: sql<string>`coalesce(max(${shippingRates.deliveryDaysMax}), 0)` })
    .from(shippingRates)
    .where(and(eq(shippingRates.isActive, true), eq(shippingRates.kind, "correios")));
  return Number(row?.value ?? 0);
}

/** O selo da vitrine: "Círio em 28 dias · peça até 29/09 para chegar pelos Correios". */
export async function getCitySeal(db: DbOrTx, input: { now?: Date } = {}): Promise<CitySeal | null> {
  const [dates, horizon] = await Promise.all([getCityDates(db), getDeliveryHorizonDays(db)]);
  return citySealFor(dates, input.now ?? new Date(), horizon);
}
