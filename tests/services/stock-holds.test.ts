// Reserva gentil: sobe o reservado no ledger (mesmo saldo), derruba o
// disponível, uma reserva ativa por telefone, liberação idempotente,
// expiração pelo cron, conversão quando o pedido leva a peça, lembrete único.
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeMessagingProvider } from "@/adapters/zapi/fake";
import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import {
  createStockHold,
  expireOverdueHolds,
  getActiveHoldByPhone,
  HoldError,
  listHoldsByVariant,
  releaseStockHold,
  remindExpiringHolds,
} from "@/services/stock-holds";
import { createStoreOrder } from "@/services/store-orders";
import { createTestDb, createTestVariant, type TestDb } from "../helpers/db";

let db: TestDb;
let sdb: DbOrTx;
let close: () => Promise<void>;

const PHONE = "+5511999990000";

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  sdb = db as unknown as DbOrTx;
});

afterEach(async () => {
  await close();
});

async function level(variantId: string) {
  const [row] = await db.select().from(schema.stockLevels).where(eq(schema.stockLevels.productVariantId, variantId));
  return { onHand: row.onHand, reserved: row.reserved };
}

async function variant(sku = "DUNAS-PRET-M", onHand = 2) {
  const created = await createTestVariant(db, { sku, name: "Vestido Dunas", onHand });
  await db
    .update(schema.productVariants)
    .set({ attributes: { cor: "Preto", tamanho: "M" } })
    .where(eq(schema.productVariants.id, created.variantId));
  await db
    .update(schema.products)
    .set({ attributesSchema: ["cor", "tamanho"] })
    .where(eq(schema.products.id, created.productId));
  return created;
}

describe("createStockHold", () => {
  it("reserva no ledger (reference hold), vence em 24 h e descreve a peça", async () => {
    const { variantId } = await variant();
    const hold = await createStockHold(sdb, { variantId, phoneE164: PHONE, conversationId: null });
    expect(hold.status).toBe("active");
    expect(hold.quantity).toBe(1);
    expect(hold.description).toMatch(/^1× Vestido Dunas \(Preto · M\) — guardada até \d{2}\/\d{2} às \d{2}:\d{2}$/);
    expect(hold.expiresAt.getTime() - Date.now()).toBeGreaterThan(23 * 3_600_000);
    expect(await level(variantId)).toEqual({ onHand: 2, reserved: 1 });

    const [movement] = await db.select().from(schema.stockMovements);
    expect(movement).toMatchObject({ type: "reservation", quantityDelta: 1, referenceType: "hold", referenceId: hold.id });
    expect(await getActiveHoldByPhone(sdb, PHONE)).toMatchObject({ id: hold.id });
  });

  it("segunda reserva ativa do mesmo telefone é recusada (HOLD_ATIVA); sem estoque, SEM_ESTOQUE e nada gravado", async () => {
    const { variantId } = await variant();
    await createStockHold(sdb, { variantId, phoneE164: PHONE });
    await expect(createStockHold(sdb, { variantId, phoneE164: PHONE })).rejects.toMatchObject({ code: "HOLD_ATIVA" });

    const { variantId: empty } = await variant("DUNAS-PRET-P", 0);
    const error = await createStockHold(sdb, { variantId: empty, phoneE164: "+5511999990001" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HoldError);
    expect((error as HoldError).code).toBe("SEM_ESTOQUE");
    expect(await listHoldsByVariant(sdb, empty)).toEqual([]);
    expect(await level(empty)).toEqual({ onHand: 0, reserved: 0 });
  });

  it("respeita o setting hold_ttl_hours e o máximo de 2 peças", async () => {
    await db.insert(schema.settings).values({ key: "hold_ttl_hours", value: 48 });
    const { variantId } = await variant("X", 5);
    const hold = await createStockHold(sdb, { variantId, phoneE164: PHONE, quantity: 2 });
    expect(hold.expiresAt.getTime() - Date.now()).toBeGreaterThan(47 * 3_600_000);
    expect(await level(variantId)).toEqual({ onHand: 5, reserved: 2 });
    await expect(createStockHold(sdb, { variantId, phoneE164: "+5511999990002", quantity: 3 })).rejects.toThrow();
  });
});

describe("releaseStockHold / expireOverdueHolds", () => {
  it("libera uma vez só (idempotente) e devolve o reservado", async () => {
    const { variantId } = await variant();
    const hold = await createStockHold(sdb, { variantId, phoneE164: PHONE });
    expect(await releaseStockHold(sdb, { holdId: hold.id, reason: "released" })).toEqual({ released: true, status: "released" });
    expect(await releaseStockHold(sdb, { holdId: hold.id, reason: "released" })).toEqual({ released: false, status: "released" });
    expect(await level(variantId)).toEqual({ onHand: 2, reserved: 0 });
    expect(await getActiveHoldByPhone(sdb, PHONE)).toBeNull();
    // Liberada, o telefone pode reservar de novo.
    await createStockHold(sdb, { variantId, phoneE164: PHONE });
  });

  it("o cron expira só as vencidas", async () => {
    const { variantId } = await variant("A", 5);
    const { variantId: other } = await variant("B", 5);
    const old = await createStockHold(sdb, { variantId, phoneE164: PHONE, ttlHours: 1 });
    await createStockHold(sdb, { variantId: other, phoneE164: "+5511999990003", ttlHours: 48 });
    await db
      .update(schema.stockHolds)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(schema.stockHolds.id, old.id));
    expect(await expireOverdueHolds(sdb)).toEqual({ expired: 1 });
    expect(await expireOverdueHolds(sdb)).toEqual({ expired: 0 });
    const [row] = await db.select().from(schema.stockHolds).where(eq(schema.stockHolds.id, old.id));
    expect(row.status).toBe("expired");
    expect(await level(variantId)).toEqual({ onHand: 5, reserved: 0 });
    expect(await level(other)).toEqual({ onHand: 5, reserved: 1 });
  });
});

describe("conversão no pedido", () => {
  it("o pedido da cliente com a peça reservada converte a reserva (sem reservar duas vezes)", async () => {
    const { variantId } = await variant("DUNAS", 2);
    await db.insert(schema.priceVersions).values({
      productVariantId: variantId,
      versionNumber: 1,
      status: "active",
      priceCents: 28900,
      origin: "initial",
      breakdown: {},
      costSnapshotCents: 9000,
      computedMarginRate: "0.3000",
      activatedAt: new Date(),
    });
    const [rate] = await db.insert(schema.shippingRates).values({ name: "PAC", priceCents: 1990 }).returning({ id: schema.shippingRates.id });
    const hold = await createStockHold(sdb, { variantId, phoneE164: PHONE });
    expect(await level(variantId)).toEqual({ onHand: 2, reserved: 1 });

    const created = await createStoreOrder(sdb, {
      customer: { fullName: "Maria da Silva", document: "52998224725", phone: "(11) 99999-0000", marketingOptIn: true },
      address: { postalCode: "01310-100", street: "Avenida Paulista", number: "1000", district: "Bela Vista", city: "São Paulo", state: "SP" },
      items: [{ variantId, quantity: 1, expectedUnitPriceCents: 28900 }],
      shippingRateId: rate.id,
      expectedShippingCents: 1990,
    });
    // A reserva da vendedora foi liberada e o pedido reservou a sua.
    expect(await level(variantId)).toEqual({ onHand: 2, reserved: 1 });
    const [row] = await db.select().from(schema.stockHolds).where(eq(schema.stockHolds.id, hold.id));
    expect(row.status).toBe("converted");
    expect(row.orderId).toBe(created.orderId);
    const movements = await db
      .select({ type: schema.stockMovements.type, referenceType: schema.stockMovements.referenceType })
      .from(schema.stockMovements)
      .where(eq(schema.stockMovements.productVariantId, variantId));
    expect(movements.map((m) => `${m.type}:${m.referenceType}`).sort()).toEqual(
      ["reservation:hold", "reservation:order", "reservation_release:hold"].sort(),
    );
  });
});

describe("remindExpiringHolds", () => {
  it("lembra uma vez, só nas 2 h finais e só com opt-in; marca mesmo quando pula", async () => {
    await db.insert(schema.settings).values({ key: "wa_enabled", value: true });
    await db.insert(schema.waTemplates).values({
      key: "hold_reminder",
      label: "Lembrete",
      bodyTemplate: "{{nome}}, {{produto}} guardada até {{prazo}}: {{link}}",
      variables: ["nome", "produto", "prazo", "link"],
      isActive: true,
    });
    await db.insert(schema.customers).values({ fullName: "Ana Souza", phoneE164: PHONE, marketingOptIn: true });
    await db.insert(schema.customers).values({ fullName: "Bia Lima", phoneE164: "+5511999990009", marketingOptIn: false });
    const { variantId } = await variant("A", 5);
    const { variantId: other } = await variant("B", 5);
    const soon = await createStockHold(sdb, { variantId, phoneE164: PHONE, ttlHours: 1 });
    const noOptIn = await createStockHold(sdb, { variantId: other, phoneE164: "+5511999990009", ttlHours: 1 });
    const provider = new FakeMessagingProvider();

    const first = await remindExpiringHolds(sdb, provider, {});
    expect(first).toEqual({ reminded: 1, skipped: 1 });
    expect(provider.sentMessages).toHaveLength(1);
    expect(provider.sentMessages[0]?.body).toContain("Ana, Vestido Dunas (Preto · M) guardada até");
    const [message] = await db.select().from(schema.waMessages);
    expect(message.dedupeKey).toBe(`wa.hold_reminder:${soon.id}`);

    const rows = await db.select().from(schema.stockHolds).where(and(eq(schema.stockHolds.status, "active")));
    expect(rows.every((row) => row.reminderSentAt !== null)).toBe(true);
    expect(rows.map((r) => r.id).sort()).toEqual([soon.id, noOptIn.id].sort());

    const second = await remindExpiringHolds(sdb, provider, {});
    expect(second).toEqual({ reminded: 0, skipped: 0 });
    expect(provider.sentMessages).toHaveLength(1);
  });
});
