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
  receivePurchase,
  receiveStock,
} from "@/services/stock";
import {
  createTestDb,
  createTestFeeRuleAndPolicy,
  createTestSupplier,
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

describe("receivePurchase", () => {
  async function insertActivePrice(variantId: string, priceCents: number) {
    await db.insert(schema.priceVersions).values({
      productVariantId: variantId,
      versionNumber: 1,
      status: "active",
      priceCents,
      origin: "initial",
      breakdown: {},
      costSnapshotCents: 1000,
      computedMarginRate: "0.3000",
      activatedAt: new Date(),
    });
  }

  it("movimento com referência do fornecedor + custo + conta a pagar na mesma transação", async () => {
    const { variantId } = await createTestVariant(db, {
      sku: "COMPRA-1",
      onHand: 0,
      costCents: 1000,
    });
    const supplierId = await createTestSupplier(db, {
      name: "Fornecedor Teste",
    });

    const result = await receivePurchase(sdb, {
      variantId,
      supplierId,
      quantity: 4,
      unitCostCents: 2500,
      invoiceNumber: "123",
      dueDate: "2026-09-15",
      note: "Reposição de setembro",
      userId: FIXED_USER_ID,
    });

    expect(result.onHand).toBe(4);
    expect(result.priceVersion).toBeNull();
    expect((await getLevel(variantId)).onHand).toBe(4);

    const movements = await listMovements(sdb, { variantId });
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({
      type: "purchase_in",
      quantityDelta: 4,
      unitCostCents: 2500,
      referenceType: "supplier",
      referenceId: supplierId,
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

    const [entry] = await db
      .select()
      .from(schema.financialEntries)
      .where(eq(schema.financialEntries.id, result.financialEntryId));
    expect(entry).toMatchObject({
      direction: "payable",
      category: "supplier",
      status: "pending",
      amountCents: 10000, // 4 × 2500
      dueDate: "2026-09-15",
      supplierId,
      description: "Compra: 4× COMPRA-1 — Fornecedor Teste (NF 123)",
    });

    const audits = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "purchase.receive"));
    expect(audits).toHaveLength(1);
    expect(audits[0].entityId).toBe(variantId);
  });

  it("gera sugestão de reprecificação quando a variante tem preço ativo", async () => {
    await createTestFeeRuleAndPolicy(db);
    const { variantId } = await createTestVariant(db, {
      sku: "COMPRA-2",
      costCents: 1000,
    });
    await insertActivePrice(variantId, 1690);
    const supplierId = await createTestSupplier(db);

    const result = await receivePurchase(sdb, {
      variantId,
      supplierId,
      quantity: 2,
      unitCostCents: 2500,
      userId: FIXED_USER_ID,
    });

    expect(result.priceVersion).not.toBeNull();
    expect(result.priceVersion?.origin).toBe("auto_cost_change");
    expect(result.priceVersion?.costSnapshotCents).toBe(2500);

    const versions = await db
      .select()
      .from(schema.priceVersions)
      .where(eq(schema.priceVersions.productVariantId, variantId));
    expect(versions).toHaveLength(2);
  });

  it("fornecedor inexistente falha SEM gravar nada", async () => {
    const { variantId } = await createTestVariant(db, {
      onHand: 3,
      costCents: 1000,
    });

    await expect(
      receivePurchase(sdb, {
        variantId,
        supplierId: "00000000-0000-4000-8000-0000000000ff",
        quantity: 2,
        unitCostCents: 500,
        userId: FIXED_USER_ID,
      }),
    ).rejects.toThrow("Fornecedor não encontrado.");

    expect((await getLevel(variantId)).onHand).toBe(3);
    expect(await listMovements(sdb, { variantId })).toHaveLength(0);
    expect(await db.select().from(schema.financialEntries)).toHaveLength(0);
  });

  it("falha no meio da transação desfaz movimento, custo e conta (atomicidade)", async () => {
    // Preço ativo SEM regra de taxa: a reprecificação lança fee_rule_missing
    // DEPOIS do movimento e do custo já gravados — tudo precisa desfazer.
    const { variantId } = await createTestVariant(db, {
      onHand: 1,
      costCents: 1000,
    });
    await insertActivePrice(variantId, 1690);
    const supplierId = await createTestSupplier(db);

    await expect(
      receivePurchase(sdb, {
        variantId,
        supplierId,
        quantity: 5,
        unitCostCents: 2000,
        userId: FIXED_USER_ID,
      }),
    ).rejects.toThrow(/taxa de pagamento/);

    expect((await getLevel(variantId)).onHand).toBe(1);
    expect(await listMovements(sdb, { variantId })).toHaveLength(0);
    expect(
      await db
        .select()
        .from(schema.variantCosts)
        .where(eq(schema.variantCosts.productVariantId, variantId)),
    ).toHaveLength(0);
    expect(await db.select().from(schema.financialEntries)).toHaveLength(0);

    const [variant] = await db
      .select()
      .from(schema.productVariants)
      .where(eq(schema.productVariants.id, variantId));
    expect(variant.costCents).toBe(1000);
  });

  it("rejeita custo unitário zero (a compra exige custo positivo)", async () => {
    const { variantId } = await createTestVariant(db);
    const supplierId = await createTestSupplier(db);

    await expect(
      receivePurchase(sdb, {
        variantId,
        supplierId,
        quantity: 1,
        unitCostCents: 0,
        userId: FIXED_USER_ID,
      }),
    ).rejects.toThrow(/maior que zero/);
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

  it("rotula a variante pelos eixos, na ordem do attributes_schema", async () => {
    const [product] = await db
      .insert(schema.products)
      .values({
        name: "Camisa Polo",
        slug: "camisa-polo",
        status: "active",
        // Ordem deliberadamente diferente da que o jsonb devolve ('cor' antes
        // de 'tamanho'): quem manda no rótulo é o attributes_schema.
        attributesSchema: ["tamanho", "cor"],
      })
      .returning({ id: schema.products.id });
    await db.insert(schema.productVariants).values([
      {
        productId: product.id,
        sku: "POLO-VD-P",
        attributes: { cor: "Verde", tamanho: "P" },
      },
      {
        productId: product.id,
        sku: "POLO-PT-G",
        attributes: { cor: "Preto", tamanho: "G" },
      },
    ]);
    const simples = await createTestVariant(db, { sku: "CANECA-1" });

    const overview = await getStockOverview(sdb);
    const bySku = (sku: string) => overview.find((row) => row.sku === sku);

    expect(bySku("POLO-VD-P")?.variantLabel).toBe("P · Verde");
    expect(bySku("POLO-PT-G")?.variantLabel).toBe("G · Preto");
    expect(bySku("POLO-VD-P")?.productName).toBe("Camisa Polo");

    // Produto sem grade: nada a acrescentar ao nome.
    expect(bySku("CANECA-1")?.variantId).toBe(simples.variantId);
    expect(bySku("CANECA-1")?.variantLabel).toBe("");
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
