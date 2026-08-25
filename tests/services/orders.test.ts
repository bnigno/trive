import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import {
  createManualOrder,
  getOrderDetail,
  listOrders,
  transitionOrder,
} from "@/services/orders";
import {
  createTestCustomer,
  createTestDb,
  createTestVariant,
  FIXED_USER_ID,
  type TestDb,
} from "../helpers/db";

let db: TestDb;
let close: () => Promise<void>;
// PGlite (testes) e postgres-js (produção) divergem apenas no tipo de
// retorno de execute(); a API drizzle usada pelos serviços é idêntica.
let sdb: DbOrTx;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  sdb = db as unknown as DbOrTx;
});

afterEach(async () => {
  await close();
});

async function activatePrice(
  variantId: string,
  priceCents: number,
): Promise<string> {
  const [pv] = await db
    .insert(schema.priceVersions)
    .values({
      productVariantId: variantId,
      versionNumber: 1,
      status: "active",
      priceCents,
      origin: "initial",
      breakdown: {},
      costSnapshotCents: 1000,
      computedMarginRate: "0.3000",
      activatedAt: new Date(),
    })
    .returning({ id: schema.priceVersions.id });
  return pv.id;
}

async function getLevel(variantId: string) {
  const [level] = await db
    .select()
    .from(schema.stockLevels)
    .where(eq(schema.stockLevels.productVariantId, variantId));
  return level;
}

async function getMovements(variantId: string) {
  return db
    .select()
    .from(schema.stockMovements)
    .where(eq(schema.stockMovements.productVariantId, variantId));
}

async function getEntries(orderId: string) {
  return db
    .select()
    .from(schema.financialEntries)
    .where(eq(schema.financialEntries.orderId, orderId));
}

async function getOutboxEvents(eventType: string) {
  return db
    .select()
    .from(schema.outboxEvents)
    .where(eq(schema.outboxEvents.eventType, eventType));
}

async function setupOrder(opts: { onHand?: number; priceCents?: number } = {}) {
  const customerId = await createTestCustomer(db);
  const { variantId } = await createTestVariant(db, {
    sku: "CAMISETA-P",
    costCents: 1200,
    onHand: opts.onHand ?? 10,
  });
  const priceVersionId = await activatePrice(
    variantId,
    opts.priceCents ?? 4990,
  );
  return { customerId, variantId, priceVersionId };
}

describe("createManualOrder", () => {
  it("cria rascunho com snapshots, totais do core, history e audit", async () => {
    const { customerId, variantId, priceVersionId } = await setupOrder();

    const result = await createManualOrder(sdb, {
      customerId,
      items: [{ variantId, quantity: 2 }],
      discountCents: 480,
      shippingCents: 1500,
      note: "Entrega combinada",
      userId: FIXED_USER_ID,
    });

    expect(result.orderNumber).toBeGreaterThanOrEqual(1000);

    const [order] = await db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, result.orderId));
    expect(order.status).toBe("draft");
    expect(order.channel).toBe("manual");
    expect(order.subtotalCents).toBe(9980);
    expect(order.discountCents).toBe(480);
    expect(order.shippingCents).toBe(1500);
    expect(order.totalCents).toBe(11000);
    expect(order.createdBy).toBe(FIXED_USER_ID);
    expect(order.note).toBe("Entrega combinada");

    const items = await db
      .select()
      .from(schema.orderItems)
      .where(eq(schema.orderItems.orderId, result.orderId));
    expect(items).toHaveLength(1);
    expect(items[0].skuSnapshot).toBe("CAMISETA-P");
    expect(items[0].nameSnapshot).toBe("Produto CAMISETA-P");
    expect(items[0].quantity).toBe(2);
    expect(items[0].unitPriceCents).toBe(4990);
    expect(items[0].unitCostCents).toBe(1200);
    expect(items[0].priceVersionId).toBe(priceVersionId);
    expect(items[0].totalCents).toBe(9980);

    const history = await db
      .select()
      .from(schema.orderStatusHistory)
      .where(eq(schema.orderStatusHistory.orderId, result.orderId));
    expect(history).toHaveLength(1);
    expect(history[0].fromStatus).toBeNull();
    expect(history[0].toStatus).toBe("draft");

    const audits = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "order.create"));
    expect(audits).toHaveLength(1);
    expect(audits[0].entityId).toBe(result.orderId);

    // Criação não mexe em estoque.
    const level = await getLevel(variantId);
    expect(level.onHand).toBe(10);
    expect(level.reserved).toBe(0);
  });

  it("sem preço ativo e sem override falha com mensagem clara e não cria nada", async () => {
    const customerId = await createTestCustomer(db);
    const { variantId } = await createTestVariant(db, {
      sku: "SEM-PRECO",
      onHand: 5,
    });

    await expect(
      createManualOrder(sdb, {
        customerId,
        items: [{ variantId, quantity: 1 }],
        userId: FIXED_USER_ID,
      }),
    ).rejects.toThrow(/defina um preço para o SKU SEM-PRECO/);

    expect(await db.select().from(schema.orders)).toHaveLength(0);
    expect(await db.select().from(schema.orderItems)).toHaveLength(0);
  });

  it("unitPriceCentsOverride tem precedência sobre o preço ativo", async () => {
    const { customerId, variantId } = await setupOrder({ priceCents: 4990 });

    const result = await createManualOrder(sdb, {
      customerId,
      items: [{ variantId, quantity: 1, unitPriceCentsOverride: 4000 }],
      userId: FIXED_USER_ID,
    });

    const [item] = await db
      .select()
      .from(schema.orderItems)
      .where(eq(schema.orderItems.orderId, result.orderId));
    expect(item.unitPriceCents).toBe(4000);
    expect(item.totalCents).toBe(4000);
  });
});

describe("transitionOrder — fluxo feliz", () => {
  it("draft→pending_payment reserva; →paid consome e liquida entry", async () => {
    const { customerId, variantId } = await setupOrder({ onHand: 10 });
    const { orderId, orderNumber } = await createManualOrder(sdb, {
      customerId,
      items: [{ variantId, quantity: 2 }],
      discountCents: 480,
      shippingCents: 1500,
      userId: FIXED_USER_ID,
    });

    // Passo 1: reserva.
    const step1 = await transitionOrder(sdb, {
      orderId,
      to: "pending_payment",
      userId: FIXED_USER_ID,
    });
    expect(step1).toMatchObject({
      from: "draft",
      to: "pending_payment",
      idempotent: false,
    });

    let level = await getLevel(variantId);
    expect(level.onHand).toBe(10);
    expect(level.reserved).toBe(2);
    expect(await getEntries(orderId)).toHaveLength(0);
    expect(await getOutboxEvents("order.pending_payment")).toHaveLength(1);

    let movements = await getMovements(variantId);
    expect(movements.map((m) => m.type)).toEqual(["reservation"]);
    expect(movements[0].quantityDelta).toBe(2);

    // Passo 2: consumo + financeiro.
    await transitionOrder(sdb, { orderId, to: "paid", userId: FIXED_USER_ID });

    level = await getLevel(variantId);
    expect(level.onHand).toBe(8);
    expect(level.reserved).toBe(0);

    movements = await getMovements(variantId);
    expect(movements.map((m) => m.type).sort()).toEqual([
      "reservation",
      "reservation_release",
      "sale_out",
    ]);

    const entries = await getEntries(orderId);
    expect(entries).toHaveLength(1);
    expect(entries[0].direction).toBe("receivable");
    expect(entries[0].category).toBe("sale");
    expect(entries[0].status).toBe("settled");
    expect(entries[0].amountCents).toBe(11000);
    expect(entries[0].description).toBe(`Pedido #${orderNumber}`);
    expect(entries[0].settledAt).not.toBeNull();

    const [order] = await db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, orderId));
    expect(order.status).toBe("paid");
    expect(order.paidAt).not.toBeNull();

    const outbox = await getOutboxEvents("order.paid");
    expect(outbox).toHaveLength(1);
    expect(outbox[0].payload).toMatchObject({
      orderId,
      orderNumber,
      totalCents: 11000,
      customerId,
    });

    const history = await db
      .select()
      .from(schema.orderStatusHistory)
      .where(eq(schema.orderStatusHistory.orderId, orderId));
    expect(history).toHaveLength(3);
  });

  it("retry da mesma transição é no-op: não duplica movimento nem entry", async () => {
    const { customerId, variantId } = await setupOrder({ onHand: 10 });
    const { orderId } = await createManualOrder(sdb, {
      customerId,
      items: [{ variantId, quantity: 2 }],
      userId: FIXED_USER_ID,
    });
    await transitionOrder(sdb, {
      orderId,
      to: "pending_payment",
      userId: FIXED_USER_ID,
    });
    await transitionOrder(sdb, { orderId, to: "paid", userId: FIXED_USER_ID });

    const retry = await transitionOrder(sdb, {
      orderId,
      to: "paid",
      userId: FIXED_USER_ID,
    });
    expect(retry.idempotent).toBe(true);

    expect(await getMovements(variantId)).toHaveLength(3);
    expect(await getEntries(orderId)).toHaveLength(1);
    expect(await getOutboxEvents("order.paid")).toHaveLength(1);

    const level = await getLevel(variantId);
    expect(level.onHand).toBe(8);
    expect(level.reserved).toBe(0);
  });
});

describe("transitionOrder — falhas e cancelamentos", () => {
  it("transição inválida falha sem nenhum efeito colateral", async () => {
    const { customerId, variantId } = await setupOrder({ onHand: 10 });
    const { orderId } = await createManualOrder(sdb, {
      customerId,
      items: [{ variantId, quantity: 2 }],
      userId: FIXED_USER_ID,
    });

    await expect(
      transitionOrder(sdb, { orderId, to: "shipped", userId: FIXED_USER_ID }),
    ).rejects.toThrow(/inválida/);

    const [order] = await db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, orderId));
    expect(order.status).toBe("draft");
    expect(await getMovements(variantId)).toHaveLength(0);
    expect(await getEntries(orderId)).toHaveLength(0);
    const history = await db
      .select()
      .from(schema.orderStatusHistory)
      .where(eq(schema.orderStatusHistory.orderId, orderId));
    expect(history).toHaveLength(1);
  });

  it("cancelar pending_payment SEMPRE libera a reserva", async () => {
    const { customerId, variantId } = await setupOrder({ onHand: 10 });
    const { orderId } = await createManualOrder(sdb, {
      customerId,
      items: [{ variantId, quantity: 3 }],
      userId: FIXED_USER_ID,
    });
    await transitionOrder(sdb, {
      orderId,
      to: "pending_payment",
      userId: FIXED_USER_ID,
    });
    expect((await getLevel(variantId)).reserved).toBe(3);

    await transitionOrder(sdb, {
      orderId,
      to: "canceled",
      userId: FIXED_USER_ID,
      reason: "Cliente desistiu",
    });

    const level = await getLevel(variantId);
    expect(level.onHand).toBe(10);
    expect(level.reserved).toBe(0);
    const types = (await getMovements(variantId)).map((m) => m.type);
    expect(types).toContain("reservation_release");
    expect(types).not.toContain("sale_out");
    expect(await getEntries(orderId)).toHaveLength(0);

    const [order] = await db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, orderId));
    expect(order.status).toBe("canceled");
    expect(order.canceledAt).not.toBeNull();
  });

  it("cancelar pedido pago exige reason; com restock=true devolve on_hand", async () => {
    const { customerId, variantId } = await setupOrder({ onHand: 10 });
    const { orderId } = await createManualOrder(sdb, {
      customerId,
      items: [{ variantId, quantity: 2 }],
      userId: FIXED_USER_ID,
    });
    await transitionOrder(sdb, {
      orderId,
      to: "pending_payment",
      userId: FIXED_USER_ID,
    });
    await transitionOrder(sdb, { orderId, to: "paid", userId: FIXED_USER_ID });
    expect((await getLevel(variantId)).onHand).toBe(8);

    await expect(
      transitionOrder(sdb, { orderId, to: "canceled", userId: FIXED_USER_ID }),
    ).rejects.toThrow(/motivo/i);
    const [still] = await db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, orderId));
    expect(still.status).toBe("paid");

    await transitionOrder(sdb, {
      orderId,
      to: "canceled",
      userId: FIXED_USER_ID,
      reason: "Pedido duplicado",
      restock: true,
    });

    const level = await getLevel(variantId);
    expect(level.onHand).toBe(10);
    expect(level.reserved).toBe(0);
    expect((await getMovements(variantId)).map((m) => m.type)).toContain(
      "return_in",
    );

    const [order] = await db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, orderId));
    expect(order.status).toBe("canceled");
    expect(order.cancelReason).toBe("Pedido duplicado");
  });

  it("reembolso cria payable pendente e com restock devolve estoque", async () => {
    const { customerId, variantId } = await setupOrder({ onHand: 10 });
    const { orderId, orderNumber } = await createManualOrder(sdb, {
      customerId,
      items: [{ variantId, quantity: 2 }],
      userId: FIXED_USER_ID,
    });
    await transitionOrder(sdb, {
      orderId,
      to: "pending_payment",
      userId: FIXED_USER_ID,
    });
    await transitionOrder(sdb, { orderId, to: "paid", userId: FIXED_USER_ID });

    await transitionOrder(sdb, {
      orderId,
      to: "refunded",
      userId: FIXED_USER_ID,
      reason: "Produto com defeito",
      restock: true,
    });

    const entries = await getEntries(orderId);
    expect(entries).toHaveLength(2);
    const refund = entries.find((e) => e.category === "refund");
    expect(refund).toMatchObject({
      direction: "payable",
      status: "pending",
      amountCents: 9980,
    });
    expect(refund?.description).toContain(`#${orderNumber}`);

    const level = await getLevel(variantId);
    expect(level.onHand).toBe(10);
    expect(level.reserved).toBe(0);
  });
});

describe("consultas", () => {
  it("getOrderDetail retorna pedido, cliente, itens e history", async () => {
    const { customerId, variantId } = await setupOrder();
    const { orderId } = await createManualOrder(sdb, {
      customerId,
      items: [{ variantId, quantity: 1 }],
      userId: FIXED_USER_ID,
    });
    await transitionOrder(sdb, {
      orderId,
      to: "pending_payment",
      userId: FIXED_USER_ID,
    });

    const detail = await getOrderDetail(sdb, orderId);
    expect(detail).not.toBeNull();
    expect(detail?.customer?.fullName).toBe("Cliente Teste");
    expect(detail?.items).toHaveLength(1);
    expect(detail?.history.map((h) => h.toStatus)).toEqual([
      "draft",
      "pending_payment",
    ]);

    expect(
      await getOrderDetail(sdb, "00000000-0000-4000-8000-00000000dead"),
    ).toBeNull();
  });

  it("listOrders filtra por status e busca por cliente/número, decrescente", async () => {
    const { customerId, variantId } = await setupOrder();
    const first = await createManualOrder(sdb, {
      customerId,
      items: [{ variantId, quantity: 1 }],
      userId: FIXED_USER_ID,
    });
    const second = await createManualOrder(sdb, {
      customerId,
      items: [{ variantId, quantity: 2 }],
      userId: FIXED_USER_ID,
    });
    await transitionOrder(sdb, {
      orderId: second.orderId,
      to: "pending_payment",
      userId: FIXED_USER_ID,
    });

    const all = await listOrders(sdb, {});
    expect(all).toHaveLength(2);
    expect(all[0].orderNumber).toBe(second.orderNumber);
    expect(all[0].customerName).toBe("Cliente Teste");

    const drafts = await listOrders(sdb, { status: "draft" });
    expect(drafts).toHaveLength(1);
    expect(drafts[0].id).toBe(first.orderId);

    const byName = await listOrders(sdb, { search: "cliente" });
    expect(byName).toHaveLength(2);

    const byNumber = await listOrders(sdb, {
      search: `#${second.orderNumber}`,
    });
    expect(byNumber).toHaveLength(1);
    expect(byNumber[0].id).toBe(second.orderId);
  });
});
