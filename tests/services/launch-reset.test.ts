// Limpeza pré-inauguração com banco real (PGlite): tudo de teste some, o que
// é da loja fica, o estoque volta a ser o livro de compras/ajustes, os
// gatilhos de proteção voltam ligados e o próximo pedido é o #1001.
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GUARD_TRIGGERS, LaunchResetInvariantError } from "@/core/maintenance/launch-reset";
import type { Db } from "@/db/client";
import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { LAUNCH_RESET_AUDIT_ACTION, applyLaunchReset, assertQueueIdle, planLaunchReset } from "@/services/launch-reset";
import { transitionOrder } from "@/services/orders";
import { adjustStock, receivePurchase } from "@/services/stock";
import { createStockHold } from "@/services/stock-holds";
import { createStoreOrder, type CreateStoreOrderInput } from "@/services/store-orders";
import { createTestDb, createTestFeeRuleAndPolicy, createTestSupplier, createTestVariant, FIXED_USER_ID, type TestDb } from "../helpers/db";

let db: TestDb;
let close: () => Promise<void>;
let sdb: DbOrTx;
let asDb: Db;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  sdb = db as unknown as DbOrTx;
  asDb = db as unknown as Db;
});

afterEach(async () => {
  await close();
});

const NOW = new Date("2026-09-18T13:30:00Z");
const VALID_CPF = "529.982.247-25";
const WINDOWS = [{ start: "16:00", end: "19:00", cutoff: "13:00" }];
const PURGED_PREFIXES = ["receipts/", "packages/", "deliveries/", "gifts/", "editions/", "looks/", "atelier/"];

async function activatePrice(variantId: string, priceCents: number): Promise<void> {
  await db.insert(schema.priceVersions).values({
    productVariantId: variantId,
    versionNumber: 1,
    status: "active",
    priceCents,
    origin: "initial",
    breakdown: {},
    costSnapshotCents: 1000,
    computedMarginRate: "0.3000",
    activatedAt: NOW,
  });
}

function input(variantId: string, rateId: string, over: Partial<CreateStoreOrderInput> = {}): CreateStoreOrderInput {
  return {
    customer: { fullName: "Ana Souza", document: VALID_CPF, phone: "(91) 98888-1234", email: "ana@example.com", marketingOptIn: true },
    address: { postalCode: "66050-000", street: "Av. Nazaré", number: "100", complement: "apto 12", district: "Nazaré", city: "Belém", state: "PA" },
    items: [{ variantId, quantity: 1, expectedUnitPriceCents: 15900 }],
    shippingRateId: rateId,
    expectedShippingCents: 1500,
    deliveryWindow: { dayKey: "2026-09-18", ...WINDOWS[0] },
    ...over,
  };
}


async function rows(name: string): Promise<number> {
  const res = await db.execute(sql.raw(`SELECT count(*)::int AS n FROM "${name}"`));
  return Number((res as unknown as { rows: { n: number }[] }).rows[0].n);
}

async function triggerStates(): Promise<Record<string, string>> {
  const names = sql.join(
    GUARD_TRIGGERS.map((g) => sql`${g.trigger}`),
    sql`, `,
  );
  const res = await db.execute(sql`SELECT tgname, tgenabled FROM pg_trigger WHERE tgname IN (${names})`);
  return Object.fromEntries((res as unknown as { rows: { tgname: string; tgenabled: string }[] }).rows.map((r) => [r.tgname, r.tgenabled]));
}

/** O mundo de teste inteiro: uma peça real com compra + ajuste, peças de teste, um pedido pago, reserva, conversa e tudo que pendura. */
async function seedWorld() {
  await createTestFeeRuleAndPolicy(db);
  const supplierId = await createTestSupplier(db, { name: "Ateliê Dunas" });
  const real = await createTestVariant(db, { sku: "LONGO-DUNAS-P", costCents: 4000, onHand: 0, name: "Longo Dunas" });
  const realM = await createTestVariant(db, { sku: "LONGO-DUNAS-M", costCents: 4000, onHand: 0, name: "Longo Dunas" });
  await activatePrice(real.variantId, 15900);
  await activatePrice(realM.variantId, 15900);
  await receivePurchase(sdb, { variantId: real.variantId, supplierId, quantity: 5, unitCostCents: 4000, userId: FIXED_USER_ID });
  await receivePurchase(sdb, { variantId: realM.variantId, supplierId, quantity: 3, unitCostCents: 4000, userId: FIXED_USER_ID });
  await adjustStock(sdb, { variantId: realM.variantId, quantityDelta: 1, note: "contagem da prateleira", userId: FIXED_USER_ID });
  await db.update(schema.stockLevels).set({ lowStockThreshold: 7 }).where(eq(schema.stockLevels.productVariantId, real.variantId));

  const testProduct = await createTestVariant(db, { sku: "TESTE-PAGAMENTO-1REAL", name: "Pagamento de Teste" });
  // Peça real com uma variante "teste" (caso CROPPED ÍRIS): a peça fica, a variante vira aviso.
  await db.insert(schema.productVariants).values({ productId: real.productId, sku: "LONGO-DUNAS-TESTE-TAUN", costCents: 4000, attributes: { cor: "teste" } });
  const demo = await createTestVariant(db, { sku: "DEMO-01", name: "Vestido Demo" });
  const [drop] = await db
    .insert(schema.drops)
    .values({ name: "Estreia", status: "vip_sent", publishAt: new Date("2026-09-20T12:00:00Z"), vipSentAt: NOW })
    .returning({ id: schema.drops.id });
  await db.insert(schema.dropProducts).values({ dropId: drop.id, productId: demo.productId });

  const [rate] = await db
    .insert(schema.shippingRates)
    .values({ name: "Motoboy Belém", priceCents: 1500, kind: "motoboy", cepStart: "66000000", cepEnd: "66999999", deliveryWindows: WINDOWS, deliveryDaysMin: 0, deliveryDaysMax: 0 })
    .returning({ id: schema.shippingRates.id });
  const [testRate] = await db
    .insert(schema.shippingRates)
    .values({ name: "Frete grátis (teste de pagamento)", priceCents: 0, cepStart: "00000000", cepEnd: "99999999", isActive: false })
    .returning({ id: schema.shippingRates.id });
  const [coupon] = await db
    .insert(schema.coupons)
    .values({ code: "BEMVINDO10", type: "percent", value: 10, usedCount: 2 })
    .returning({ id: schema.coupons.id });

  const created = await createStoreOrder(sdb, input(real.variantId, rate.id), { now: NOW });
  await transitionOrder(sdb, { orderId: created.orderId, to: "paid", userId: FIXED_USER_ID });
  const [order] = await db.select({ id: schema.orders.id, customerId: schema.orders.customerId }).from(schema.orders).where(eq(schema.orders.id, created.orderId));
  await db
    .update(schema.orders)
    .set({
      receiptPath: `receipts/${order.id}/comprovante.jpg`,
      packagePhotoPath: `packages/${order.id}/embalagem.jpg`,
      deliveredPhotoPath: `deliveries/${order.id}/entrega.jpg`,
      giftNotePath: `gifts/${order.id}/bilhete.jpg`,
      editionCardsAt: NOW,
      editionCardsFingerprint: { [real.productId]: "h1", carta: "h2" },
    })
    .where(eq(schema.orders.id, order.id));

  await createStockHold(sdb, { variantId: realM.variantId, phoneE164: "+5591977776666", ttlHours: 2 });

  const [conversation] = await db
    .insert(schema.waConversations)
    .values({ phoneE164: "+5591988881234", lid: "220839349862480@lid", customerId: order.customerId, botState: { displayName: "Ana" }, lastInboundAt: NOW, updatedAt: NOW })
    .returning({ id: schema.waConversations.id });
  const [quiet] = await db
    .insert(schema.waConversations)
    .values({ phoneE164: "+5591900000000", lastInboundAt: new Date("2026-09-10T10:00:00Z"), updatedAt: new Date("2026-09-10T10:00:00Z") })
    .returning({ id: schema.waConversations.id });
  const [inbound] = await db
    .insert(schema.waMessages)
    .values({ conversationId: conversation.id, direction: "inbound", body: "oi", status: "delivered", createdAt: NOW })
    .returning({ id: schema.waMessages.id });
  await db.insert(schema.waMessages).values({ conversationId: conversation.id, direction: "outbound", body: "Pedido #1000 confirmado", status: "sent", orderId: order.id, createdAt: NOW });
  const [followup] = await db
    .insert(schema.waFollowups)
    .values({ conversationId: conversation.id, phoneE164: "+5591988881234", kind: "customer", reason: "combinado", dueAt: NOW })
    .returning({ id: schema.waFollowups.id });
  await db.insert(schema.waSuggestions).values({ conversationId: conversation.id, inboundMessageId: inbound.id, followupId: followup.id, bubbles: ["oi"] });
  const [intake] = await db
    .insert(schema.atelierIntakes)
    .values({ conversationId: quiet.id, triggerWaMessageId: inbound.id, cardPath: "atelier/i1/card-1.jpg", status: "done" })
    .returning({ id: schema.atelierIntakes.id });
  const [look] = await db
    .insert(schema.customerLooks)
    .values({ phoneE164: "+5591988881234", productId: real.productId, displayName: "Ana", photoPath: "looks/l1/photo.jpg", cardPath: "looks/l1/card.jpg", orderId: order.id, photoWaMessageId: inbound.id, customerId: order.customerId })
    .returning({ id: schema.customerLooks.id });
  await db.insert(schema.deliveryFeedback).values({ orderId: order.id, phoneE164: "+5591988881234", customerId: order.customerId });
  await db.insert(schema.stockAlerts).values({ productVariantId: realM.variantId, phoneE164: "+5591988881234", source: "lia", conversationId: conversation.id });
  await db.insert(schema.siteCarts).values({ code: "K7F2", source: "pdp", conversationId: conversation.id, orderId: order.id });
  await db.insert(schema.customerProfiles).values({ phoneE164: "+5591988881234", source: "quiz", customerId: order.customerId });
  await db.insert(schema.dropInvites).values({ dropId: drop.id, customerId: order.customerId!, phoneE164: "+5591988881234" });
  await db.insert(schema.dropWaitlist).values({ dropId: drop.id, phoneE164: "+5591955554444", source: "site" });

  const [courier] = await db.insert(schema.couriers).values({ name: "Carlos", phoneE164: "+5591987654321" }).returning({ id: schema.couriers.id });
  const [run] = await db.insert(schema.deliveryRuns).values({ courierId: courier.id }).returning({ id: schema.deliveryRuns.id });
  await db.insert(schema.deliveryStops).values({ runId: run.id, orderId: order.id, sequence: 1 });
  await db.insert(schema.deliveryPositions).values({ runId: run.id, lat: -1.45, lng: -48.49, recordedAt: NOW });

  await db.insert(schema.outboxEvents).values([
    { eventType: "price.activated", aggregateType: "price_version", status: "failed", dedupeKey: "keep-failed" },
    { eventType: "drop.published", aggregateType: "drop", status: "pending", dedupeKey: "keep-drop" },
    { eventType: "stock.low", aggregateType: "product_variant", status: "pending", dedupeKey: "keep-low" },
    { eventType: "wa.owner_forward", status: "pending", dedupeKey: "keep-forward" },
    { eventType: "wa.drop_invite", aggregateType: "drop", status: "pending", dedupeKey: "drop-invite" },
    { eventType: "mp.payment_event", status: "pending", dedupeKey: "mp-event" },
    { eventType: "wa.send", aggregateType: "wa_conversation", status: "done", dedupeKey: "done-send" },
  ]);
  await db.insert(schema.inboundEvents).values([
    { source: "zapi", externalEventId: "old", payload: { phone: "5591988881234" }, receivedAt: new Date("2026-09-10T10:00:00Z") },
    { source: "zapi", externalEventId: "recent", payload: { phone: "5591988881234" }, receivedAt: new Date("2026-09-18T12:00:00Z") },
    { source: "mercadopago", externalEventId: "mp-1", payload: { id: 1 }, receivedAt: new Date("2026-09-10T10:00:00Z") },
    { source: "email", externalEventId: "mail-1", payload: {}, receivedAt: new Date("2026-09-10T10:00:00Z") },
  ]);
  await db.insert(schema.auditLog).values([
    { actorType: "system", action: "wa.watchdog_alert", entityType: "wa_conversation", entityId: "+5591900000000", after: { lastMessageAt: NOW.toISOString() } },
    { actorType: "system", action: "wa.session_alert", entityType: "wa_session", entityId: "session" },
    { actorType: "user", actorId: FIXED_USER_ID, action: "product.update", entityType: "product", entityId: real.productId },
    { actorType: "customer", action: "drop.waitlist_join", entityType: "drop", entityId: drop.id, after: { phoneE164: "+5591955554444" } },
  ]);

  return { supplierId, real, realM, testProduct, demo, rate: rate.id, testRate: testRate.id, coupon: coupon.id, order, conversation, intake, look, courier, drop };
}

describe("planLaunchReset", () => {
  it("conta, lista e calcula o estoque antes → depois sem gravar nada", async () => {
    const world = await seedWorld();
    const plan = await planLaunchReset(sdb, { now: NOW });

    expect(plan.counts.orders).toBe(1);
    expect(plan.counts.wa_messages).toBe(2);
    expect(plan.counts.wa_conversations).toBe(2);
    expect(plan.counts.customers).toBe(1);
    expect(plan.counts.delivery_runs).toBe(1);
    expect(plan.counts.financial_entries).toBeGreaterThanOrEqual(1);
    // reserva + liberação + venda do pedido, reserva gentil
    expect(plan.counts.stock_movements).toBe(4);
    expect(plan.counts.outbox_events).toBeGreaterThanOrEqual(3);
    expect(plan.counts.inbound_events).toBe(1);
    expect(plan.conversations.map((c) => c.name)).toEqual(["Ana", null]);
    expect(plan.conversations[0].phone).toBe("(91) •••••-1234");
    expect(plan.customers[0]).toMatchObject({ name: "Ana Souza", phone: "(91) •••••-1234", marketingOptIn: true });
    expect(plan.stock.levels).toEqual([
      { sku: "LONGO-DUNAS-M", productName: "Longo Dunas", before: { onHand: 4, reserved: 1 }, after: { onHand: 4, reserved: 0 } },
      { sku: "LONGO-DUNAS-P", productName: "Longo Dunas", before: { onHand: 4, reserved: 0 }, after: { onHand: 5, reserved: 0 } },
    ]);
    expect(plan.stock.preDivergences).toEqual([]);
    expect(plan.stock.invalid).toEqual([]);
    expect(plan.stock.manualMovements).toEqual([expect.objectContaining({ sku: "LONGO-DUNAS-M", type: "adjustment", quantityDelta: 1, note: "contagem da prateleira" })]);
    expect(plan.coupons).toEqual([{ code: "BEMVINDO10", usedCount: 2 }]);
    expect(plan.products.map((p) => p.name).sort()).toEqual(["Pagamento de Teste", "Vestido Demo"]);
    expect(plan.suspiciousVariants).toEqual([{ sku: "LONGO-DUNAS-TESTE-TAUN", productName: "Longo Dunas", isActive: true }]);
    expect(plan.products.find((p) => p.name === "Vestido Demo")?.linkedTo).toEqual(['lançamento "Estreia"']);
    expect(plan.shippingRates.map((r) => r.name)).toEqual(["Frete grátis (teste de pagamento)"]);
    expect(plan.supplierEntries).toHaveLength(2);
    expect(plan.scheduledDropsWithInvites).toEqual([{ name: "Estreia", publishAt: new Date("2026-09-20T12:00:00Z"), invites: 1 }]);
    expect(plan.storagePaths).toEqual(
      [
        `receipts/${world.order.id}/comprovante.jpg`,
        `packages/${world.order.id}/embalagem.jpg`,
        `deliveries/${world.order.id}/entrega.jpg`,
        `gifts/${world.order.id}/bilhete.jpg`,
        `editions/${world.order.id}/${world.real.productId}.jpg`,
        `editions/${world.order.id}/carta-de-estreia.jpg`,
        "looks/l1/photo.jpg",
        "looks/l1/card.jpg",
        "atelier/i1/card-1.jpg",
      ].sort(),
    );
    expect(plan.storagePaths.every((p) => PURGED_PREFIXES.some((prefix) => p.startsWith(prefix)))).toBe(true);
    expect(plan.orderNumbers).toEqual({ maxOrderNumber: 1000, nextAfterReset: 1001 });

    expect(await rows("orders")).toBe(1);
    expect(await rows("customers")).toBe(1);
  });

  it("recusa com a fila no meio de um handler — antes e dentro da transação", async () => {
    await seedWorld();
    await db.insert(schema.outboxEvents).values({ eventType: "wa.send", status: "processing", dedupeKey: "busy" });
    await expect(assertQueueIdle(sdb)).rejects.toMatchObject({ code: "QUEUE_BUSY" });
    await expect(applyLaunchReset(asDb, { userId: FIXED_USER_ID, now: NOW })).rejects.toMatchObject({ code: "QUEUE_BUSY" });
    expect(await rows("customers")).toBe(1);
    expect(Object.values(await triggerStates())).toEqual(["O", "O", "O", "O", "O"]);
  });
});

describe("applyLaunchReset", () => {
  it("apaga o teste, mantém a loja, recalcula o estoque e religa os gatilhos", async () => {
    const world = await seedWorld();
    const report = await applyLaunchReset(asDb, { userId: FIXED_USER_ID, now: NOW });

    for (const table of [
      "wa_conversations", "wa_messages", "wa_followups", "wa_suggestions", "atelier_intakes", "customers", "customer_addresses",
      "orders", "order_items", "order_status_history", "delivery_feedback", "customer_looks", "stock_alerts", "stock_holds",
      "site_carts", "customer_profiles", "drop_invites", "drop_waitlist", "delivery_runs", "delivery_stops", "delivery_positions",
    ]) {
      expect(await rows(table), table).toBe(0);
    }
    expect(report.deleted.orders).toBe(1);
    expect(report.deleted.wa_conversations).toBe(2);
    expect(report.deleted.stock_movements).toBe(4);

    // O que é da loja fica.
    expect(await rows("users")).toBe(1);
    expect(await rows("products")).toBe(4);
    expect(await rows("product_variants")).toBe(5);
    expect(await rows("price_versions")).toBeGreaterThanOrEqual(2);
    expect(await rows("couriers")).toBe(1);
    expect(await rows("drops")).toBe(1);
    // a peça de teste sai do lançamento (ligação apagada), o lançamento fica
    expect(await rows("drop_products")).toBe(0);
    const suppliers = await db.select().from(schema.suppliers);
    expect(suppliers.map((s) => s.id)).toEqual([world.supplierId]);
    const entries = await db.select({ orderId: schema.financialEntries.orderId, supplierId: schema.financialEntries.supplierId }).from(schema.financialEntries);
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.orderId === null && e.supplierId === world.supplierId)).toBe(true);
    const rates = await db.select({ name: schema.shippingRates.name }).from(schema.shippingRates);
    expect(rates.map((r) => r.name)).toEqual(["Motoboy Belém"]);
    const [coupon] = await db.select({ usedCount: schema.coupons.usedCount }).from(schema.coupons);
    expect(coupon.usedCount).toBe(0);
    const products = await db.select({ name: schema.products.name, status: schema.products.status }).from(schema.products);
    expect(products.find((p) => p.name === "Pagamento de Teste")?.status).toBe("archived");
    expect(products.find((p) => p.name === "Vestido Demo")?.status).toBe("archived");
    expect(products.filter((p) => p.name === "Longo Dunas").every((p) => p.status === "active")).toBe(true);
    const variants = await db.select({ sku: schema.productVariants.sku, isActive: schema.productVariants.isActive }).from(schema.productVariants);
    expect(variants.filter((v) => v.sku.startsWith("LONGO")).every((v) => v.isActive)).toBe(true);
    expect(variants.find((v) => v.sku === "LONGO-DUNAS-TESTE-TAUN")?.isActive).toBe(true);
    expect(variants.filter((v) => !v.sku.startsWith("LONGO")).every((v) => !v.isActive)).toBe(true);
    expect(report.variantsDeactivated).toBe(2);

    // Livro: só compra e ajuste; saldo = livro; limiar preservado.
    const movements = await db.select({ type: schema.stockMovements.type, referenceType: schema.stockMovements.referenceType }).from(schema.stockMovements);
    expect(movements.map((m) => m.type).sort()).toEqual(["adjustment", "purchase_in", "purchase_in"]);
    expect(movements.some((m) => m.referenceType === "order" || m.referenceType === "hold")).toBe(false);
    const levels = await db
      .select({ sku: schema.productVariants.sku, onHand: schema.stockLevels.onHand, reserved: schema.stockLevels.reserved, threshold: schema.stockLevels.lowStockThreshold })
      .from(schema.stockLevels)
      .innerJoin(schema.productVariants, eq(schema.productVariants.id, schema.stockLevels.productVariantId));
    expect(levels.find((l) => l.sku === "LONGO-DUNAS-P")).toEqual({ sku: "LONGO-DUNAS-P", onHand: 5, reserved: 0, threshold: 7 });
    expect(levels.find((l) => l.sku === "LONGO-DUNAS-M")).toMatchObject({ onHand: 4, reserved: 0 });
    expect(levels.find((l) => l.sku === "DEMO-01")).toMatchObject({ onHand: 0, reserved: 0 });

    // Fila e eventos recebidos.
    const outbox = await db.select({ dedupeKey: schema.outboxEvents.dedupeKey, eventType: schema.outboxEvents.eventType }).from(schema.outboxEvents);
    const keys = outbox.map((o) => o.dedupeKey ?? "");
    expect(keys.filter((k) => k.startsWith("keep-")).sort()).toEqual(["keep-drop", "keep-failed", "keep-forward", "keep-low"]);
    expect(keys.some((k) => ["drop-invite", "mp-event", "done-send"].includes(k))).toBe(false);
    // Os eventos de estoque da própria semeadura (agregado product_variant, pendentes) sobrevivem de propósito.
    expect(keys.every((k) => k.startsWith("keep-") || k.startsWith("stock.") || k.startsWith("store.revalidate"))).toBe(true);
    expect(report.revalidateEvents).toBe(1);
    expect(outbox.filter((o) => o.eventType === "store.revalidate")).toHaveLength(1);
    const inbound = await db.select({ id: schema.inboundEvents.externalEventId }).from(schema.inboundEvents);
    expect(inbound.map((i) => i.id).sort()).toEqual(["mail-1", "mp-1", "recent"]);

    // Auditoria: histórico de gente sai, o da loja e os dedupes de alerta ficam, e o vigia é silenciado para o chat ativo.
    const audit = await db.select({ action: schema.auditLog.action, entityType: schema.auditLog.entityType, entityId: schema.auditLog.entityId, after: schema.auditLog.after }).from(schema.auditLog);
    expect(audit.some((a) => a.action === "product.update")).toBe(true);
    expect(audit.some((a) => a.action === "wa.session_alert")).toBe(true);
    expect(audit.some((a) => a.action === "stock.receive" || a.action === "stock.purchase" || a.entityType === "stock_level" || a.entityType === "financial_entry")).toBe(true);
    expect(audit.some((a) => a.entityType === "order" || a.entityType === "customer")).toBe(false);
    expect(audit.some((a) => a.action === "drop.waitlist_join")).toBe(false);
    const silenced = audit.filter((a) => a.action === "wa.watchdog_alert").map((a) => a.entityId).sort();
    expect(silenced).toEqual(["+5591900000000", "+5591988881234", "220839349862480@lid"]);
    expect(report.watchdogSilenced).toBe(2);
    const [reset] = audit.filter((a) => a.action === LAUNCH_RESET_AUDIT_ACTION);
    expect((reset.after as { deleted: { orders: number } }).deleted.orders).toBe(1);
    expect(report.auditLogId).toBeGreaterThan(0);
    expect(report.plan.storagePaths).toHaveLength(9);

    // Gatilhos religados de verdade.
    expect(Object.values(await triggerStates())).toEqual(["O", "O", "O", "O", "O"]);
    await expect(db.execute(sql`DELETE FROM stock_movements`)).rejects.toThrow();

    // Numeração: o próximo pedido é o #1001.
    const created = await createStoreOrder(sdb, input(world.real.variantId, world.rate), { now: NOW });
    const [order] = await db.select({ orderNumber: schema.orders.orderNumber }).from(schema.orders).where(eq(schema.orders.id, created.orderId));
    expect(order.orderNumber).toBe(1001);
    await expect(db.execute(sql`DELETE FROM orders`)).rejects.toThrow();
  });

  it("é idempotente: rodar de novo não apaga nada e não falha", async () => {
    await seedWorld();
    await applyLaunchReset(asDb, { userId: FIXED_USER_ID, now: NOW });
    const again = await applyLaunchReset(asDb, { userId: FIXED_USER_ID, now: new Date(NOW.getTime() + 60_000) });
    expect(Object.values(again.deleted).every((n) => n === 0)).toBe(true);
    expect(again.productsArchived).toEqual([]);
    expect(again.ratesDeleted).toEqual([]);
    expect(await rows("products")).toBe(4);
  });

  it("é tudo ou nada: reserva avulsa fora de pedido desfaz a limpeza inteira, gatilhos incluídos", async () => {
    const world = await seedWorld();
    await db.insert(schema.stockMovements).values({
      productVariantId: world.realM.variantId,
      type: "reservation",
      quantityDelta: 1,
      referenceType: "product",
      idempotencyKey: "avulsa",
    });
    const plan = await planLaunchReset(sdb, { now: NOW });
    expect(plan.stock.invalid).toEqual([{ sku: "LONGO-DUNAS-M", onHand: 4, reserved: 1 }]);
    await expect(applyLaunchReset(asDb, { userId: FIXED_USER_ID, now: NOW })).rejects.toBeInstanceOf(LaunchResetInvariantError);
    expect(await rows("customers")).toBe(1);
    expect(await rows("orders")).toBe(1);
    expect(await rows("wa_conversations")).toBe(2);
    expect(Object.values(await triggerStates())).toEqual(["O", "O", "O", "O", "O"]);
    const [coupon] = await db.select({ usedCount: schema.coupons.usedCount }).from(schema.coupons);
    expect(coupon.usedCount).toBe(2);
    const [seq] = ((await db.execute(sql`SELECT last_value, is_called FROM orders_order_number_seq`)) as unknown as { rows: { last_value: unknown; is_called: boolean }[] }).rows;
    expect(Number(seq.last_value)).toBe(1000);
    expect(seq.is_called).toBe(true);
  });
});
