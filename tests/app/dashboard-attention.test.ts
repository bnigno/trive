import { describe, expect, it } from "vitest";

import { buildAttentionRows } from "@/app/admin/(protected)/dashboard-attention";
import type { AdminDashboard, DashboardOwner, DashboardShared } from "@/services/dashboard";

function shared(overrides: Partial<DashboardShared> = {}): DashboardShared {
  return {
    todayKey: "2026-09-21",
    ordersCreated: { today: 0, yesterday: 0 },
    toPackCount: 0,
    mustShipToday: 0,
    route: { today: 0, late: 0 },
    toDeliverCount: 0,
    staleShipmentsCount: 0,
    lowStockCount: 0,
    readiness: { ready: 0, total: 0, allReady: false },
    attention: { conversationsAwaiting: 0, emailThreadsAwaiting: 0, pendingSuggestions: 0 },
    newCustomers: { current: 0, previous: 0 },
    recentOrders: [],
    ...overrides,
  };
}

function owner(overrides: Partial<DashboardOwner> = {}): DashboardOwner {
  return {
    paidSales: null,
    month: null,
    pendingApprovals: 0,
    deadOutbox: 0,
    series: null,
    topProducts: null,
    margin: null,
    recovery: null,
    atelierFailed: 0,
    pendingLooks: 0,
    bot: null,
    siteBridge30d: null,
    ...overrides,
  };
}

describe("buildAttentionRows", () => {
  it("sem pendência devolve lista vazia", () => {
    expect(buildAttentionRows({ shared: shared(), owner: owner() })).toEqual([]);
  });

  it("só linhas com contagem, do mais urgente para o mais tranquilo, empates na ordem declarada", () => {
    const dashboard: AdminDashboard = {
      shared: shared({
        lowStockCount: 3,
        toPackCount: 2,
        mustShipToday: 1,
        toDeliverCount: 4,
        staleShipmentsCount: 1,
      }),
      owner: owner({ deadOutbox: 2, pendingLooks: 5 }),
    };

    const rows = buildAttentionRows(dashboard);

    expect(rows.map((row) => row.key)).toEqual([
      "must-ship-today",
      "dead-outbox",
      "to-deliver",
      "to-pack",
      "pending-looks",
      "low-stock",
    ]);
    expect(rows.map((row) => row.severity)).toEqual([
      "danger",
      "danger",
      "warning",
      "warning",
      "neutral",
      "neutral",
    ]);
    expect(rows.find((row) => row.key === "to-deliver")?.hint).toContain("1 enviado há 7+ dias");
  });

  it("linhas do dono não aparecem para a equipe; e-mails só entram para o dono", () => {
    const base = shared({
      attention: { conversationsAwaiting: 1, emailThreadsAwaiting: 2, pendingSuggestions: 0 },
    });

    const staffRows = buildAttentionRows({ shared: base, owner: null });
    expect(staffRows).toEqual([]);

    const ownerRows = buildAttentionRows({
      shared: base,
      owner: owner({ pendingApprovals: 1, atelierFailed: 1 }),
    });
    expect(ownerRows.map((row) => row.key)).toEqual(["pending-approvals", "atelier-failed", "emails"]);
  });

  it("rota do motoboy: só com atraso vira aviso", () => {
    const calm = buildAttentionRows({ shared: shared({ route: { today: 3, late: 0 } }), owner: null });
    expect(calm[0]).toMatchObject({ key: "route", severity: "neutral", count: 3 });

    const late = buildAttentionRows({ shared: shared({ route: { today: 3, late: 2 } }), owner: null });
    expect(late[0]).toMatchObject({ key: "route", severity: "warning" });
    expect(late[0].hint).toContain("2 atrasados");
  });

  it("bloco indisponível (null) não vira linha", () => {
    const rows = buildAttentionRows({
      shared: shared({ toPackCount: null, lowStockCount: null, route: null, attention: null }),
      owner: owner({ deadOutbox: null }),
    });
    expect(rows).toEqual([]);
  });
});
