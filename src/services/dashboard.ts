// O dashboard do painel numa leitura só. Cada bloco falha isolado (vira
// null e o erro vai para o log): sem banco a tela mostra "—", nunca quebra.
// O corte por papel é na carga — a equipe nunca carrega dinheiro.
//
// "Hoje" e "ontem" são dias de São Paulo (lib/sp-day). "Vendas" segue a
// régua dos relatórios: paid_at preenchido e pedido não cancelado/reembolsado,
// então a última barra da série bate com o card.
import { and, count, eq, gte, lt, sql } from "drizzle-orm";
import { z } from "zod";

import type { AdminRole } from "@/core/auth/access";
import type { ReadinessSummary } from "@/core/catalog/readiness";
import { customers, orders, outboxEvents, priceVersions } from "@/db/schema";
import { spDayKey, spDayStart, spPreviousDayKey } from "@/lib/sp-day";
import type { DbOrTx } from "@/queue/enqueue";
import { countAtelierIntakesFailed } from "./atelier";
import { getReadinessSummary } from "./catalog-readiness";
import { countPendingLooks } from "./customer-looks";
import { countOrdersAwaitingDelivery, listStaleShipments } from "./delivery";
import { countRouteOfDay } from "./delivery-routes";
import { countThreadsAwaiting } from "./email-inbox";
import { monthOverview, type MonthOverview } from "./financial";
import { countOrdersMustShipToday } from "./needed-by";
import { listOrders } from "./orders";
import { countOrdersAwaitingPacking } from "./packing";
import {
  marginSummary,
  paidCondition,
  recoveryStats,
  salesSeries,
  topProducts,
  type MarginSummary,
  type RecoveryStats,
  type SalesSeriesPoint,
  type TopProductRow,
} from "./reports";
import { siteBridgeFunnel } from "./site-carts";
import { getStockOverview } from "./stock";
import { countConversationsAwaitingOwner } from "./wa-conversations";
import { getBotActivitySummary, type BotActivitySummary } from "./wa-insights";
import { countPendingSuggestions } from "./wa-suggestions";

export type DayComparison = { today: number; yesterday: number };
export type WindowComparison = { current: number; previous: number };

export type PaidDay = {
  count: number;
  revenueCents: number;
  /** Nulo quando não houve venda no dia. */
  averageTicketCents: number | null;
};

export type RecentOrder = Awaited<ReturnType<typeof listOrders>>[number];

export type DashboardAttention = {
  conversationsAwaiting: number;
  emailThreadsAwaiting: number;
  pendingSuggestions: number;
};

/** O que a equipe também vê: a operação do dia, sem valor de faturamento. */
export type DashboardShared = {
  /** 'YYYY-MM-DD' em São Paulo. */
  todayKey: string;
  /** Pedidos criados (qualquer situação), por created_at no dia SP. */
  ordersCreated: DayComparison | null;
  toPackCount: number | null;
  mustShipToday: number | null;
  route: { today: number; late: number } | null;
  toDeliverCount: number | null;
  staleShipmentsCount: number | null;
  lowStockCount: number | null;
  readiness: ReadinessSummary | null;
  attention: DashboardAttention | null;
  /** Clientes novos: últimos 7 dias vs. os 7 anteriores. */
  newCustomers: WindowComparison | null;
  recentOrders: RecentOrder[] | null;
};

export type SiteBridgeTotals = {
  taps: number;
  conversations: number;
  orders: number;
  paidOrders: number;
  paidCents: number;
};

/** Só o dono: dinheiro, margem, fila e as pendências que só ele resolve. */
export type DashboardOwner = {
  paidSales: { today: PaidDay; yesterday: PaidDay } | null;
  month: MonthOverview | null;
  pendingApprovals: number | null;
  deadOutbox: number | null;
  /** 14 pontos, dias sem venda zerados — pronto para o gráfico. */
  series: SalesSeriesPoint[] | null;
  topProducts: TopProductRow[] | null;
  margin: MarginSummary | null;
  recovery: RecoveryStats | null;
  atelierFailed: number | null;
  pendingLooks: number | null;
  bot: BotActivitySummary | null;
  /** Funil das pontes do site nos últimos 30 dias (toque → conversa → pedido → pago). */
  siteBridge30d: SiteBridgeTotals | null;
};

export type AdminDashboard = {
  shared: DashboardShared;
  owner: DashboardOwner | null;
};

const ROLES: readonly AdminRole[] = ["owner", "staff"];

const inputSchema = z.object({
  role: z.enum(ROLES as [AdminRole, ...AdminRole[]]),
  now: z.date().optional(),
});

export type AdminDashboardInput = z.input<typeof inputSchema>;

const DAY_MS = 86_400_000;

async function safe<T>(name: string, load: () => Promise<T>): Promise<T | null> {
  try {
    return await load();
  } catch (error) {
    console.error(`[dashboard] seção falhou: ${name}`, error);
    return null;
  }
}

// Datas entram como ISO string no SQL cru: o driver não serializa Date aí.
const iso = (date: Date) => date.toISOString();

async function countOrdersCreatedByDay(
  db: DbOrTx,
  todayStart: Date,
  yesterdayStart: Date,
): Promise<DayComparison> {
  const [row] = await db
    .select({
      today: sql<number>`count(*) filter (where ${orders.createdAt} >= ${iso(todayStart)})`,
      yesterday: sql<number>`count(*) filter (where ${orders.createdAt} < ${iso(todayStart)})`,
    })
    .from(orders)
    .where(gte(orders.createdAt, yesterdayStart));
  return { today: Number(row?.today ?? 0), yesterday: Number(row?.yesterday ?? 0) };
}

async function paidSalesByDay(
  db: DbOrTx,
  todayStart: Date,
  yesterdayStart: Date,
): Promise<{ today: PaidDay; yesterday: PaidDay }> {
  const todayFilter = sql`${orders.paidAt} >= ${iso(todayStart)}`;
  const yesterdayFilter = sql`${orders.paidAt} < ${iso(todayStart)}`;
  const [row] = await db
    .select({
      todayCount: sql<number>`count(*) filter (where ${todayFilter})`,
      todayCents: sql<number>`coalesce(sum(${orders.totalCents}) filter (where ${todayFilter}), 0)`,
      yesterdayCount: sql<number>`count(*) filter (where ${yesterdayFilter})`,
      yesterdayCents: sql<number>`coalesce(sum(${orders.totalCents}) filter (where ${yesterdayFilter}), 0)`,
    })
    .from(orders)
    .where(and(paidCondition(), gte(orders.paidAt, yesterdayStart)));

  const day = (countValue: unknown, centsValue: unknown): PaidDay => {
    const total = Number(countValue ?? 0);
    const revenueCents = Number(centsValue ?? 0);
    return {
      count: total,
      revenueCents,
      averageTicketCents: total > 0 ? Math.round(revenueCents / total) : null,
    };
  };
  return {
    today: day(row?.todayCount, row?.todayCents),
    yesterday: day(row?.yesterdayCount, row?.yesterdayCents),
  };
}

async function countPendingPriceApprovals(db: DbOrTx): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(priceVersions)
    .where(eq(priceVersions.status, "pending_approval"));
  return Number(row?.total ?? 0);
}

export async function countDeadOutboxEvents(db: DbOrTx): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(outboxEvents)
    .where(eq(outboxEvents.status, "dead"));
  return Number(row?.total ?? 0);
}

async function countNewCustomers(db: DbOrTx, now: Date): Promise<WindowComparison> {
  const weekAgo = new Date(now.getTime() - 7 * DAY_MS);
  const twoWeeksAgo = new Date(now.getTime() - 14 * DAY_MS);
  const [row] = await db
    .select({
      current: sql<number>`count(*) filter (where ${customers.createdAt} >= ${iso(weekAgo)})`,
      previous: sql<number>`count(*) filter (where ${customers.createdAt} < ${iso(weekAgo)})`,
    })
    .from(customers)
    .where(and(gte(customers.createdAt, twoWeeksAgo), lt(customers.createdAt, now), sql`${customers.deletedAt} is null`));
  return { current: Number(row?.current ?? 0), previous: Number(row?.previous ?? 0) };
}

async function loadShared(db: DbOrTx, now: Date): Promise<DashboardShared> {
  const todayKey = spDayKey(now);
  const todayStart = spDayStart(todayKey);
  const yesterdayStart = spDayStart(spPreviousDayKey(todayKey));

  const [
    ordersCreated,
    toPackCount,
    mustShipToday,
    route,
    toDeliverCount,
    staleShipmentsCount,
    lowStockCount,
    readiness,
    attention,
    newCustomers,
    recentOrders,
  ] = await Promise.all([
    safe("ordersCreated", () => countOrdersCreatedByDay(db, todayStart, yesterdayStart)),
    safe("toPack", () => countOrdersAwaitingPacking(db)),
    safe("mustShipToday", () => countOrdersMustShipToday(db, { now })),
    safe("route", () => countRouteOfDay(db, { now })),
    safe("toDeliver", () => countOrdersAwaitingDelivery(db)),
    safe("staleShipments", async () => (await listStaleShipments(db, { now })).length),
    safe("lowStock", async () => (await getStockOverview(db)).filter((row) => row.low).length),
    safe("readiness", () => getReadinessSummary(db)),
    safe("attention", async () => {
      const [conversationsAwaiting, emailThreadsAwaiting, pendingSuggestions] =
        await Promise.all([
          countConversationsAwaitingOwner(db),
          countThreadsAwaiting(db),
          countPendingSuggestions(db),
        ]);
      return { conversationsAwaiting, emailThreadsAwaiting, pendingSuggestions };
    }),
    safe("newCustomers", () => countNewCustomers(db, now)),
    safe("recentOrders", () => listOrders(db, { limit: 5 })),
  ]);

  return {
    todayKey,
    ordersCreated,
    toPackCount,
    mustShipToday,
    route,
    toDeliverCount,
    staleShipmentsCount,
    lowStockCount,
    readiness,
    attention,
    newCustomers,
    recentOrders,
  };
}

async function loadOwner(db: DbOrTx, now: Date): Promise<DashboardOwner> {
  const todayKey = spDayKey(now);
  const todayStart = spDayStart(todayKey);
  const yesterdayStart = spDayStart(spPreviousDayKey(todayKey));
  const [year, month] = todayKey.split("-").map(Number);

  const [
    paidSales,
    monthData,
    pendingApprovals,
    deadOutbox,
    series,
    top,
    margin,
    recovery,
    atelierFailed,
    pendingLooks,
    bot,
    siteBridge30d,
  ] = await Promise.all([
    safe("paidSales", () => paidSalesByDay(db, todayStart, yesterdayStart)),
    safe("month", () => monthOverview(db, { year, month })),
    safe("pendingApprovals", () => countPendingPriceApprovals(db)),
    safe("deadOutbox", () => countDeadOutboxEvents(db)),
    safe("series", () => salesSeries(db, { days: 14 })),
    safe("topProducts", () => topProducts(db, { days: 30, limit: 5 })),
    safe("margin", () => marginSummary(db, { days: 30 })),
    safe("recovery", () => recoveryStats(db)),
    safe("atelierFailed", () => countAtelierIntakesFailed(db)),
    safe("pendingLooks", () => countPendingLooks(db)),
    safe("bot", () => getBotActivitySummary(db)),
    safe("siteBridge30d", async () => {
      const funnel = await siteBridgeFunnel(db, {
        from: new Date(now.getTime() - 30 * DAY_MS),
        to: now,
      });
      return funnel.totals;
    }),
  ]);

  return {
    paidSales,
    month: monthData,
    pendingApprovals,
    deadOutbox,
    series,
    topProducts: top,
    margin,
    recovery,
    atelierFailed,
    pendingLooks,
    bot,
    siteBridge30d,
  };
}

export async function getAdminDashboard(
  db: DbOrTx,
  input: AdminDashboardInput,
): Promise<AdminDashboard> {
  const { role, now = new Date() } = inputSchema.parse(input);
  const [shared, owner] = await Promise.all([
    loadShared(db, now),
    role === "owner" ? loadOwner(db, now) : Promise.resolve(null),
  ]);
  return { shared, owner };
}
