import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { createCoupon, redeemCouponInTx } from "@/services/coupons";
import {
  createManualOrder,
  getOrderDetail,
  listOrders,
  shipOrder,
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

describe("shipOrder (Correios: 'Marcar como enviado')", () => {
  async function paidOrder() {
    const { customerId, variantId } = await setupOrder({ onHand: 10 });
    const { orderId, orderNumber } = await createManualOrder(sdb, { customerId, items: [{ variantId, quantity: 1 }], shippingCents: 1500, userId: FIXED_USER_ID });
    await transitionOrder(sdb, { orderId, to: "pending_payment", userId: FIXED_USER_ID });
    await transitionOrder(sdb, { orderId, to: "paid", userId: FIXED_USER_ID });
    return { orderId, orderNumber, customerId, variantId };
  }
  const packed = (orderId: string) =>
    db.update(schema.orders).set({ packagePhotoPath: `packages/${orderId}/embalagem.jpg`, packedAt: new Date() }).where(eq(schema.orders.id, orderId));
  const status = async (orderId: string) => (await db.select({ s: schema.orders.status }).from(schema.orders).where(eq(schema.orders.id, orderId)))[0].s;

  it("embalar antes de enviar: sem a foto recusa (NOT_PACKED) e não grava o rastreio; com a foto, paid → preparing → shipped com o rastreio na mesma transação", async () => {
    const { orderId, orderNumber } = await paidOrder();
    await expect(shipOrder(sdb, { orderId, trackingCode: "BR123", userId: FIXED_USER_ID })).rejects.toMatchObject({
      code: "NOT_PACKED",
      message: `O pedido #${orderNumber} ainda não foi embalado: registre a foto do pacote (Mesa de embalagem ou card Embalagem da ficha) antes de marcar como enviado.`,
    });
    expect(await status(orderId)).toBe("paid");
    expect((await db.select({ t: schema.orders.shippingTrackingCode }).from(schema.orders).where(eq(schema.orders.id, orderId)))[0].t).toBeNull();

    await packed(orderId);
    const shipped = await shipOrder(sdb, { orderId, trackingCode: "BR123", userId: FIXED_USER_ID });
    expect(shipped).toMatchObject({ from: "paid", to: "shipped", idempotent: false });
    expect(await status(orderId)).toBe("shipped");
    expect((await db.select({ t: schema.orders.shippingTrackingCode }).from(schema.orders).where(eq(schema.orders.id, orderId)))[0].t).toBe("BR123");
    const history = await db.select({ to: schema.orderStatusHistory.toStatus }).from(schema.orderStatusHistory).where(eq(schema.orderStatusHistory.orderId, orderId)).orderBy(schema.orderStatusHistory.createdAt);
    expect(history.map((h) => h.to).slice(-2)).toEqual(["preparing", "shipped"]);
    expect(await getOutboxEvents("order.shipped")).toHaveLength(1);

    // Segunda vez: idempotente, sem novo aviso.
    expect((await shipOrder(sdb, { orderId, userId: FIXED_USER_ID })).idempotent).toBe(true);
    expect(await getOutboxEvents("order.shipped")).toHaveLength(1);
  });

  it("pedido de motoboy não passa por aqui; pedido não pago é recusado", async () => {
    const { orderId, customerId, variantId } = await paidOrder();
    await packed(orderId);
    await db.update(schema.orders).set({ deliveryWindow: { dayKey: "2026-09-18", start: "16:00", end: "19:00", cutoff: "13:00", rateName: "Motoboy Belém", label: "hoje" } }).where(eq(schema.orders.id, orderId));
    await expect(shipOrder(sdb, { orderId, userId: FIXED_USER_ID })).rejects.toMatchObject({ code: "MOTOBOY_ORDER" });

    // Não pago (rascunho): recusado mesmo com foto.
    const draft = await createManualOrder(sdb, { customerId, items: [{ variantId, quantity: 1 }], shippingCents: 0, userId: FIXED_USER_ID });
    await packed(draft.orderId);
    await expect(shipOrder(sdb, { orderId: draft.orderId, userId: FIXED_USER_ID })).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
  });
});

describe("transitionOrder — financeiro (settle-or-skip-or-insert)", () => {
  /** Receivable sale pré-existente do pedido (como o checkout cash cria). */
  async function insertPendingSale(orderId: string, amountCents: number) {
    const [entry] = await db
      .insert(schema.financialEntries)
      .values({
        direction: "receivable",
        category: "sale",
        description: "Pedido cash",
        amountCents,
        status: "pending",
        orderId,
        createdBy: null,
      })
      .returning({ id: schema.financialEntries.id });
    return entry.id;
  }

  it("paid com sale PENDENTE pré-existente liquida a MESMA entry (não insere outra)", async () => {
    const { customerId, variantId } = await setupOrder({ onHand: 10 });
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
    const entryId = await insertPendingSale(orderId, 4990);

    await transitionOrder(sdb, { orderId, to: "paid", userId: FIXED_USER_ID });

    const entries = await getEntries(orderId);
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe(entryId);
    expect(entries[0].status).toBe("settled");
    expect(entries[0].settledAt).not.toBeNull();
  });

  it("paid com sale já SETTLED (dono liquidou antes) é no-op: nada duplica", async () => {
    const { customerId, variantId } = await setupOrder({ onHand: 10 });
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
    const entryId = await insertPendingSale(orderId, 4990);
    const settledAt = new Date();
    await db
      .update(schema.financialEntries)
      .set({ status: "settled", settledAt })
      .where(eq(schema.financialEntries.id, entryId));

    await transitionOrder(sdb, { orderId, to: "paid", userId: FIXED_USER_ID });

    const entries = await getEntries(orderId);
    expect(entries).toHaveLength(1);
    expect(entries[0].settledAt?.getTime()).toBe(settledAt.getTime());
  });

  it("paid com sale CANCELADA ignora a cancelada e insere settled nova", async () => {
    const { customerId, variantId } = await setupOrder({ onHand: 10 });
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
    const canceledId = await insertPendingSale(orderId, 4990);
    await db
      .update(schema.financialEntries)
      .set({ status: "canceled" })
      .where(eq(schema.financialEntries.id, canceledId));

    await transitionOrder(sdb, { orderId, to: "paid", userId: FIXED_USER_ID });

    const entries = await getEntries(orderId);
    expect(entries).toHaveLength(2);
    const settled = entries.find((e) => e.status === "settled");
    expect(settled).toMatchObject({
      direction: "receivable",
      category: "sale",
      amountCents: 4990,
    });
  });

  it("canceled cancela os receivables sale PENDENTES do pedido", async () => {
    const { customerId, variantId } = await setupOrder({ onHand: 10 });
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
    await insertPendingSale(orderId, 4990);

    await transitionOrder(sdb, {
      orderId,
      to: "canceled",
      userId: FIXED_USER_ID,
      reason: "Cliente desistiu",
    });

    const entries = await getEntries(orderId);
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe("canceled");
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

  it("cupom: cancelar sem pagar devolve o uso; pago e depois cancelado NÃO devolve", async () => {
    const { customerId, variantId } = await setupOrder({ onHand: 10 });
    const coupon = await createCoupon(sdb, { code: "DEZ", type: "percent", value: 10, userId: FIXED_USER_ID });
    const usedCount = async () =>
      (await db.select({ usedCount: schema.coupons.usedCount }).from(schema.coupons).where(eq(schema.coupons.id, coupon.id)))[0].usedCount;
    const redeem = async (orderId: string) => {
      await db.update(schema.orders).set({ couponId: coupon.id, couponCode: "DEZ" }).where(eq(schema.orders.id, orderId));
      await redeemCouponInTx(sdb, { couponId: coupon.id, orderId, customerId, phoneE164: null, code: "DEZ", discountCents: 100, shippingDiscountCents: 0, appliedValue: 10 });
    };

    // Nunca pago → cancelado: o uso volta.
    const unpaid = await createManualOrder(sdb, { customerId, items: [{ variantId, quantity: 1 }], userId: FIXED_USER_ID });
    await redeem(unpaid.orderId);
    await transitionOrder(sdb, { orderId: unpaid.orderId, to: "pending_payment", userId: FIXED_USER_ID });
    expect(await usedCount()).toBe(1);
    await transitionOrder(sdb, { orderId: unpaid.orderId, to: "canceled", userId: FIXED_USER_ID });
    expect(await usedCount()).toBe(0);
    const [released] = await db.select().from(schema.couponRedemptions).where(eq(schema.couponRedemptions.orderId, unpaid.orderId));
    expect(released.releasedAt).not.toBeNull();

    // Pago → cancelado: a cliente gastou o cupom de verdade.
    const paid = await createManualOrder(sdb, { customerId, items: [{ variantId, quantity: 1 }], userId: FIXED_USER_ID });
    await redeem(paid.orderId);
    await transitionOrder(sdb, { orderId: paid.orderId, to: "pending_payment", userId: FIXED_USER_ID });
    await transitionOrder(sdb, { orderId: paid.orderId, to: "paid", userId: FIXED_USER_ID });
    await transitionOrder(sdb, { orderId: paid.orderId, to: "canceled", userId: FIXED_USER_ID, reason: "Desistiu" });
    expect(await usedCount()).toBe(1);
    const [kept] = await db.select().from(schema.couponRedemptions).where(eq(schema.couponRedemptions.orderId, paid.orderId));
    expect(kept.releasedAt).toBeNull();
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
    // O código atual da variação viaja junto do snapshot da venda.
    expect(detail?.items[0].currentSku).toBe(detail?.items[0].skuSnapshot);
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
