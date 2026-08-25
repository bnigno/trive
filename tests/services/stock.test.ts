import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { InsufficientStockError } from "@/core/stock/ledger";
import {
  adjustStock,
  applyStockEffectTx,
  getStockOverview,
  listMovements,
  receiveStock,
} from "@/services/stock";
import {
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

async function getLevel(variantId: string) {
  const [level] = await db
    .select()
    .from(schema.stockLevels)
    .where(eq(schema.stockLevels.productVariantId, variantId));
  return level;
}

describe("receiveStock", () => {
  it("soma o saldo, registra movimento e custo (variant_costs + denormalização)", async () => {
    const { variantId } = await createTestVariant(db, { onHand: 0, costCents: 1000 });

    const result = await receiveStock(sdb, {
      variantId,
      quantity: 7,
      unitCostCents: 2500,
      note: "Compra fornecedor X",
      userId: FIXED_USER_ID,
    });

    expect(result.onHand).toBe(7);
    expect((await getLevel(variantId)).onHand).toBe(7);

    const movements = await listMovements(sdb, { variantId });
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({
      type: "purchase_in",
      quantityDelta: 7,
      unitCostCents: 2500,
    });

    const costs = await db
      .select()
      .from(schema.variantCosts)
      .where(eq(schema.variantCosts.productVariantId, variantId));
    expect(costs).toHaveLength(1);
    expect(costs[0]).toMatchObject({ costCents: 2500, source: "purchase" });

    const [variant] = await db
      .select()
      .from(schema.productVariants)
      .where(eq(schema.productVariants.id, variantId));
    expect(variant.costCents).toBe(2500);

    const audits = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "stock.receive"));
    expect(audits).toHaveLength(1);
    expect(audits[0].entityId).toBe(variantId);
  });
});

describe("adjustStock", () => {
  it("falha sem nota (obrigatória)", async () => {
    const { variantId } = await createTestVariant(db, { onHand: 5 });

    await expect(
      // @ts-expect-error nota ausente de propósito
      adjustStock(sdb, { variantId, quantityDelta: -1, userId: FIXED_USER_ID }),
    ).rejects.toThrow();

    expect((await getLevel(variantId)).onHand).toBe(5);
  });

  it("ajuste que negativaria o saldo falha SEM alterar nada (atomicidade)", async () => {
    const { variantId } = await createTestVariant(db, { onHand: 2 });

    await expect(
      adjustStock(sdb, {
        variantId,
        quantityDelta: -5,
        note: "Correção de contagem",
        userId: FIXED_USER_ID,
      }),
    ).rejects.toThrow(InsufficientStockError);

    expect((await getLevel(variantId)).onHand).toBe(2);
    expect(await listMovements(sdb, { variantId })).toHaveLength(0);

    const audits = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "stock.adjust"));
    expect(audits).toHaveLength(0);
  });

  it("ajuste válido grava movimento e audit", async () => {
    const { variantId } = await createTestVariant(db, { onHand: 10 });

    const result = await adjustStock(sdb, {
      variantId,
      quantityDelta: -2,
      note: "Avaria na embalagem",
      asLoss: true,
      userId: FIXED_USER_ID,
    });

    expect(result.onHand).toBe(8);
    const movements = await listMovements(sdb, { variantId });
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({ type: "loss", quantityDelta: -2 });
  });
});

describe("applyStockEffectTx", () => {
  it("reserve→consume conserva o available e repetição é idempotente", async () => {
    const { variantId } = await createTestVariant(db, { onHand: 5 });
    const orderId = randomUUID();

    await applyStockEffectTx(sdb, {
      effect: "reserve",
      variantId,
      quantity: 2,
      referenceType: "order",
      referenceId: orderId,
      createdBy: FIXED_USER_ID,
    });

    let level = await getLevel(variantId);
    expect(level).toMatchObject({ onHand: 5, reserved: 2 });
    expect(level.onHand - level.reserved).toBe(3);

    await applyStockEffectTx(sdb, {
      effect: "consume",
      variantId,
      quantity: 2,
      referenceType: "order",
      referenceId: orderId,
      createdBy: FIXED_USER_ID,
    });

    level = await getLevel(variantId);
    expect(level).toMatchObject({ onHand: 3, reserved: 0 });
    // available conservado: reserva vira saída sem alterar o disponível
    expect(level.onHand - level.reserved).toBe(3);

    // chamada REPETIDA (mesma referenceId): não duplica movimento nem saldo
    const repeat = await applyStockEffectTx(sdb, {
      effect: "consume",
      variantId,
      quantity: 2,
      referenceType: "order",
      referenceId: orderId,
      createdBy: FIXED_USER_ID,
    });
    expect(repeat.applied).toBe(false);

    level = await getLevel(variantId);
    expect(level).toMatchObject({ onHand: 3, reserved: 0 });
    // 1 reservation + 2 do consume (reservation_release + sale_out)
    expect(await listMovements(sdb, { variantId })).toHaveLength(3);
  });

  it("release devolve a reserva sem mexer no on_hand", async () => {
    const { variantId } = await createTestVariant(db, { onHand: 6 });
    const orderId = randomUUID();

    await applyStockEffectTx(sdb, {
      effect: "reserve",
      variantId,
      quantity: 4,
      referenceType: "order",
      referenceId: orderId,
    });
    expect(await getLevel(variantId)).toMatchObject({ onHand: 6, reserved: 4 });

    await applyStockEffectTx(sdb, {
      effect: "release",
      variantId,
      quantity: 4,
      referenceType: "order",
      referenceId: orderId,
    });
    expect(await getLevel(variantId)).toMatchObject({ onHand: 6, reserved: 0 });
  });

  it("enfileira stock.low uma única vez ao cruzar o limiar", async () => {
    // threshold padrão = 3; available 10 → 2 cruza o limiar na reserva
    const { variantId } = await createTestVariant(db, { onHand: 10 });
    const orderId = randomUUID();

    await applyStockEffectTx(sdb, {
      effect: "reserve",
      variantId,
      quantity: 8,
      referenceType: "order",
      referenceId: orderId,
    });
    await applyStockEffectTx(sdb, {
      effect: "consume",
      variantId,
      quantity: 8,
      referenceType: "order",
      referenceId: orderId,
    });
    // já abaixo do limiar: novo decremento NÃO cruza de novo
    await adjustStock(sdb, {
      variantId,
      quantityDelta: -1,
      note: "Contagem física",
      userId: FIXED_USER_ID,
    });

    const events = await db
      .select()
      .from(schema.outboxEvents)
      .where(eq(schema.outboxEvents.eventType, "stock.low"));
    expect(events).toHaveLength(1);
    expect(events[0].dedupeKey).toBe(`stock.low:${variantId}`);
    expect(events[0].payload).toMatchObject({ variantId, available: 2, threshold: 3 });
  });
});

describe("getStockOverview", () => {
  it("ordena variantes com estoque baixo primeiro", async () => {
    // "Produto AAA-1" viria primeiro em ordem alfabética, mas não está baixo
    const high = await createTestVariant(db, { sku: "AAA-1", onHand: 50 });
    const low = await createTestVariant(db, { sku: "ZZZ-9", onHand: 1 });

    const overview = await getStockOverview(sdb);
    expect(overview).toHaveLength(2);

    expect(overview[0].variantId).toBe(low.variantId);
    expect(overview[0]).toMatchObject({
      sku: "ZZZ-9",
      onHand: 1,
      reserved: 0,
      available: 1,
      lowStockThreshold: 3,
      low: true,
    });

    expect(overview[1].variantId).toBe(high.variantId);
    expect(overview[1]).toMatchObject({ sku: "AAA-1", available: 50, low: false });
    expect(overview[1].productName).toBe("Produto AAA-1");
  });
});

describe("listMovements", () => {
  it("retorna histórico decrescente e respeita o limite", async () => {
    const { variantId } = await createTestVariant(db, { onHand: 0 });

    await receiveStock(sdb, { variantId, quantity: 5, userId: FIXED_USER_ID });
    await adjustStock(sdb, {
      variantId,
      quantityDelta: -1,
      note: "Ajuste de contagem",
      userId: FIXED_USER_ID,
    });

    const all = await listMovements(sdb, { variantId });
    expect(all).toHaveLength(2);
    expect(all[0].createdAt.getTime()).toBeGreaterThanOrEqual(all[1].createdAt.getTime());

    const limited = await listMovements(sdb, { variantId, limit: 1 });
    expect(limited).toHaveLength(1);
  });
});
