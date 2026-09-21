// O dashboard numa leitura só: dias de São Paulo, régua de "pago" dos
// relatórios, corte por papel na carga e cada bloco falhando sozinho.
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import { spDayKey, spPreviousDayKey } from "@/lib/sp-day";
import type { DbOrTx } from "@/queue/enqueue";
import { getAdminDashboard } from "@/services/dashboard";
import {
  createTestCustomer,
  createTestDb,
  createTestVariant,
  type TestDb,
} from "../helpers/db";

let db: TestDb;
let close: () => Promise<void>;
let sdb: DbOrTx;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  sdb = db as unknown as DbOrTx;
});

afterEach(async () => {
  await close();
});

// salesSeries e o resumo da Lia usam o relógio real: a semente é relativa a hoje.
const NOW = new Date();
const TODAY = spDayKey(NOW);
const YESTERDAY = spPreviousDayKey(TODAY);
const at = (dayKey: string, time: string) => new Date(`${dayKey}T${time}-03:00`);

async function createOrder(opts: {
  customerId: string;
  variantId: string;
  status?: string;
  createdAt?: Date;
  paidAt?: Date | null;
  totalCents?: number;
}): Promise<string> {
  const totalCents = opts.totalCents ?? 10000;
  const [order] = await db
    .insert(schema.orders)
    .values({
      customerId: opts.customerId,
      status: opts.status ?? "paid",
      createdAt: opts.createdAt ?? NOW,
      paidAt: opts.paidAt ?? null,
      subtotalCents: totalCents,
      discountCents: 0,
      shippingCents: 0,
      totalCents,
    })
    .returning({ id: schema.orders.id });
  await db.insert(schema.orderItems).values({
    orderId: order.id,
    productVariantId: opts.variantId,
    skuSnapshot: "SKU-1",
    nameSnapshot: "Peça",
    quantity: 1,
    unitPriceCents: totalCents,
    unitCostCents: 4000,
    totalCents,
  });
  return order.id;
}

describe("getAdminDashboard", () => {
  it("equipe: recebe a operação do dia e owner é null", async () => {
    const dashboard = await getAdminDashboard(sdb, { role: "staff", now: NOW });

    expect(dashboard.owner).toBeNull();
    expect(dashboard.shared.todayKey).toBe(TODAY);
    expect(dashboard.shared.ordersCreated).toEqual({ today: 0, yesterday: 0 });
    expect(dashboard.shared.toPackCount).toBe(0);
    expect(dashboard.shared.lowStockCount).toBe(0);
    expect(dashboard.shared.attention).toEqual({
      conversationsAwaiting: 0,
      conversationsWithNewMessages: 0,
      emailThreadsAwaiting: 0,
      pendingSuggestions: 0,
    });
    expect(dashboard.shared.recentOrders).toEqual([]);
  });

  it("conta pedidos criados hoje e ontem pelo dia de São Paulo", async () => {
    const customerId = await createTestCustomer(db);
    const { variantId } = await createTestVariant(db);
    await createOrder({ customerId, variantId, createdAt: at(TODAY, "09:00:00"), status: "pending_payment" });
    await createOrder({ customerId, variantId, createdAt: at(TODAY, "10:00:00"), status: "pending_payment" });
    // 23:30 de ontem em SP é 02:30Z de hoje — conta como ontem.
    await createOrder({ customerId, variantId, createdAt: at(YESTERDAY, "23:30:00"), status: "pending_payment" });
    await createOrder({ customerId, variantId, createdAt: at(spPreviousDayKey(YESTERDAY), "12:00:00"), status: "pending_payment" });

    const { shared } = await getAdminDashboard(sdb, { role: "staff", now: at(TODAY, "12:00:00") });

    expect(shared.ordersCreated).toEqual({ today: 2, yesterday: 1 });
    expect(shared.recentOrders).toHaveLength(4);
  });

  it("dono: vendas pagas usam paid_at, excluem cancelado/reembolsado e calculam o ticket médio", async () => {
    const customerId = await createTestCustomer(db);
    const { variantId } = await createTestVariant(db);
    await createOrder({ customerId, variantId, paidAt: at(TODAY, "08:00:00"), totalCents: 10000 });
    await createOrder({ customerId, variantId, paidAt: at(TODAY, "09:00:00"), totalCents: 20000 });
    // Pago hoje mas reembolsado: fora da régua.
    await createOrder({ customerId, variantId, status: "refunded", paidAt: at(TODAY, "10:00:00"), totalCents: 99900 });
    // Criado hoje, ainda não pago: conta em "criados", não em "vendas".
    await createOrder({ customerId, variantId, status: "pending_payment", createdAt: at(TODAY, "11:00:00") });

    const dashboard = await getAdminDashboard(sdb, { role: "owner", now: at(TODAY, "12:00:00") });
    const owner = dashboard.owner!;

    expect(owner.paidSales).toEqual({
      today: { count: 2, revenueCents: 30000, averageTicketCents: 15000 },
      yesterday: { count: 0, revenueCents: 0, averageTicketCents: null },
    });
    expect(dashboard.shared.ordersCreated?.today).toBe(4);
  });

  it("dono: a série tem 14 pontos e o último bate com as vendas de hoje", async () => {
    const customerId = await createTestCustomer(db);
    const { variantId } = await createTestVariant(db);
    await createOrder({ customerId, variantId, paidAt: at(TODAY, "08:00:00"), totalCents: 12300 });
    await createOrder({ customerId, variantId, paidAt: at(YESTERDAY, "08:00:00"), totalCents: 5000 });

    const { owner } = await getAdminDashboard(sdb, { role: "owner", now: at(TODAY, "12:00:00") });

    expect(owner?.series).toHaveLength(14);
    const last = owner?.series?.at(-1);
    expect(last).toEqual({ date: TODAY, ordersCount: 1, revenueCents: 12300 });
    expect(last?.revenueCents).toBe(owner?.paidSales?.today.revenueCents);
    expect(owner?.series?.at(-2)).toEqual({ date: YESTERDAY, ordersCount: 1, revenueCents: 5000 });
    expect(owner?.topProducts?.[0]).toMatchObject({ quantity: 2, revenueCents: 17300 });
  });

  it("dono: aprovações de preço pendentes e fila morta", async () => {
    const { variantId } = await createTestVariant(db);
    await db.insert(schema.priceVersions).values([
      {
        productVariantId: variantId,
        versionNumber: 1,
        status: "pending_approval",
        priceCents: 19900,
        breakdown: {},
        costSnapshotCents: 8000,
        computedMarginRate: "0.3000",
      },
      {
        productVariantId: variantId,
        versionNumber: 2,
        status: "active",
        priceCents: 19900,
        breakdown: {},
        costSnapshotCents: 8000,
        computedMarginRate: "0.3000",
      },
    ]);
    await db.insert(schema.outboxEvents).values([
      { eventType: "email.send", status: "dead", dedupeKey: "d1" },
      { eventType: "email.send", status: "dead", dedupeKey: "d2" },
      { eventType: "email.send", status: "pending", dedupeKey: "p1" },
    ]);

    const { owner } = await getAdminDashboard(sdb, { role: "owner", now: NOW });

    expect(owner?.pendingApprovals).toBe(1);
    expect(owner?.deadOutbox).toBe(2);
  });

  it("clientes novos: últimos 7 dias contra os 7 anteriores", async () => {
    const day = 86_400_000;
    for (const daysAgo of [1, 3, 10]) {
      await db.insert(schema.customers).values({
        fullName: `Cliente ${daysAgo}`,
        createdAt: new Date(NOW.getTime() - daysAgo * day),
      });
    }
    await db.insert(schema.customers).values({
      fullName: "Antiga",
      createdAt: new Date(NOW.getTime() - 20 * day),
    });

    const { shared } = await getAdminDashboard(sdb, { role: "staff", now: NOW });

    expect(shared.newCustomers).toEqual({ current: 2, previous: 1 });
  });

  it("uma seção com erro vira null sem derrubar as outras", async () => {
    await db.execute(sql`drop table outbox_events`);

    const dashboard = await getAdminDashboard(sdb, { role: "owner", now: NOW });

    expect(dashboard.owner?.deadOutbox).toBeNull();
    expect(dashboard.owner?.pendingApprovals).toBe(0);
    expect(dashboard.shared.ordersCreated).toEqual({ today: 0, yesterday: 0 });
    expect(dashboard.shared.todayKey).toBe(TODAY);
  });
});
