// Integração das operações em lote de precificação (recálculo geral +
// aprovação/rejeição por lote). Banco NOVO por teste: recalculateAllPrices
// varre TODAS as variantes ativas, então isolamento total evita interferência.
// Referência das fixtures (custo 1000, taxa 4,98%, margem 30%, to_90 up):
// preço 1690. Custo 1050 -> 1790 (+5,9%: ativa sozinho); custo 1400 -> 2290
// (+35,5%: pendente); custo 700 -> 1190 (queda: pendente).
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import * as schema from "@/db/schema";
import {
  applyPriceToProduct,
  approveBatch,
  approvePriceVersion,
  createPriceVersion,
  getActivePrice,
  listBatchSummary,
  listPriceVersions,
  recalculateAllPrices,
  rejectBatch,
  ServiceError,
} from "@/services/pricing";
import {
  createTestDb,
  createTestFeeRuleAndPolicy,
  createTestVariant,
  FIXED_USER_ID,
  type TestDb,
} from "../helpers/db";

let db: TestDb;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  await createTestFeeRuleAndPolicy(db);
});

afterEach(async () => {
  await close();
});

/** Variante com preço inicial já aprovado e ativo (1690 com custo 1000). */
async function activeVariant(sku: string, costCents = 1000): Promise<string> {
  const { variantId } = await createTestVariant(db, { sku, costCents });
  const v1 = await createPriceVersion(db, {
    variantId,
    userId: FIXED_USER_ID,
    origin: "initial",
  });
  await approvePriceVersion(db, { versionId: v1.id, userId: FIXED_USER_ID });
  return variantId;
}

/**
 * Muda o custo DIRETO no banco, de propósito: setVariantCost dispararia a
 * reprecificação automática e aqui queremos exercitar o recálculo em lote.
 */
async function setCostRaw(variantId: string, costCents: number): Promise<void> {
  await db
    .update(schema.productVariants)
    .set({ costCents })
    .where(eq(schema.productVariants.id, variantId));
}

async function auditActions(entityId: string): Promise<string[]> {
  const rows = await db
    .select({ action: schema.auditLog.action })
    .from(schema.auditLog)
    .where(eq(schema.auditLog.entityId, entityId));
  return rows.map((r) => r.action);
}

describe("recalculateAllPrices", () => {
  it("ativa mudança não crítica, pendura a crítica e pula variante sem mudança", async () => {
    const a = await activeVariant("BULK-A");
    const b = await activeVariant("BULK-B");
    const c = await activeVariant("BULK-C");
    await setCostRaw(a, 1050); // -> 1790 (+5,9%, margem saudável): auto
    await setCostRaw(b, 1400); // -> 2290 (+35,5% > limiar de 10%): pendente

    const result = await recalculateAllPrices(db, { userId: FIXED_USER_ID });

    expect(result.batchId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.created).toBe(2);
    expect(result.autoActivated).toBe(1);
    expect(result.pendingApproval).toBe(1);
    expect(result.unchanged).toBe(1);

    // A ativou sozinha com o batchId do lote e origem bulk_update.
    const aActive = await getActivePrice(db, a);
    expect(aActive?.priceCents).toBe(1790);
    expect(aActive?.batchId).toBe(result.batchId);
    expect(aActive?.origin).toBe("bulk_update");

    // B continua com o preço antigo; a nova versão aguarda aprovação.
    expect((await getActivePrice(db, b))?.priceCents).toBe(1690);
    const [bLatest] = await listPriceVersions(db, b);
    expect(bLatest.status).toBe("pending_approval");
    expect(bLatest.batchId).toBe(result.batchId);
    expect(bLatest.approvalReasons).toContain("change_above_threshold");
    // O lote não força aprovação por si só: sem reason bulk_change.
    expect(bLatest.approvalReasons).not.toContain("bulk_change");

    // C não mudou de preço: NENHUMA versão nova criada.
    expect(await listPriceVersions(db, c)).toHaveLength(1);

    expect(await auditActions(result.batchId)).toContain(
      "price.bulk_recalculate",
    );
  });
});

describe("listBatchSummary", () => {
  it("resume apenas os itens pendentes do lote, com variação e agregado", async () => {
    await activeVariant("SUM-A"); // sem mudança: fora do lote
    const b = await activeVariant("SUM-B");
    await setCostRaw(b, 1400); // pendente: 1690 -> 2290

    const { batchId, created } = await recalculateAllPrices(db, {
      userId: FIXED_USER_ID,
    });
    expect(created).toBe(1);

    const summary = await listBatchSummary(db, batchId);
    expect(summary.batchId).toBe(batchId);
    expect(summary.items).toHaveLength(1);

    const [item] = summary.items;
    expect(item.sku).toBe("SUM-B");
    expect(item.productName).toBeTruthy();
    expect(item.currentPriceCents).toBe(1690);
    expect(item.newPriceCents).toBe(2290);
    expect(item.changePct).toBeCloseTo(600 / 1690, 10);
    expect(item.minMarginRate).toBe(0.15);

    expect(summary.aggregate.count).toBe(1);
    expect(summary.aggregate.avgChangePct).toBeCloseTo(600 / 1690, 10);
    // margem de 2290 com custo 1400: (2290 - 1400 - 114) / 2290 = 0.3389 >= 0.15
    expect(summary.aggregate.marginPreserved).toBe(true);
  });
});

describe("approveBatch", () => {
  it("aprova e ativa TODOS os pendentes do lote; lote vazio dá erro claro", async () => {
    const b = await activeVariant("APR-B");
    const d = await activeVariant("APR-D");
    await setCostRaw(b, 1400); // -> 2290 pendente (variação acima do limiar)
    await setCostRaw(d, 700); // -> 1190 pendente (queda de preço)

    const result = await recalculateAllPrices(db, { userId: FIXED_USER_ID });
    expect(result.pendingApproval).toBe(2);
    expect(result.autoActivated).toBe(0);

    const outcome = await approveBatch(db, {
      batchId: result.batchId,
      userId: FIXED_USER_ID,
    });
    expect(outcome.approvedCount).toBe(2);

    const bActive = await getActivePrice(db, b);
    expect(bActive?.priceCents).toBe(2290);
    expect(bActive?.batchId).toBe(result.batchId);
    expect(bActive?.approvedBy).toBe(FIXED_USER_ID);
    expect(bActive?.activatedAt).not.toBeNull();
    expect((await getActivePrice(db, d))?.priceCents).toBe(1190);

    // Anteriores viraram superseded (uma ativa por variante).
    const bVersions = await listPriceVersions(db, b);
    expect(bVersions.map((v) => v.status).sort()).toEqual([
      "active",
      "superseded",
    ]);

    expect(await auditActions(result.batchId)).toContain("price.approve_batch");
    expect(await listBatchSummary(db, result.batchId)).toMatchObject({
      items: [],
      aggregate: { count: 0, avgChangePct: null, marginPreserved: true },
    });

    // Nada mais pendente no lote: segunda aprovação falha com ServiceError.
    await expect(
      approveBatch(db, { batchId: result.batchId, userId: FIXED_USER_ID }),
    ).rejects.toThrow(ServiceError);
    await expect(
      approveBatch(db, { batchId: result.batchId, userId: FIXED_USER_ID }),
    ).rejects.toThrow(/lote/i);
  });
});

describe("rejectBatch", () => {
  it("exige motivo, rejeita os pendentes e mantém os preços ativos", async () => {
    const b = await activeVariant("REJ-B");
    await setCostRaw(b, 1400); // -> 2290 pendente

    const { batchId } = await recalculateAllPrices(db, {
      userId: FIXED_USER_ID,
    });

    await expect(
      rejectBatch(db, { batchId, userId: FIXED_USER_ID, reason: "" }),
    ).rejects.toThrow(/[Mm]otivo/);

    const outcome = await rejectBatch(db, {
      batchId,
      userId: FIXED_USER_ID,
      reason: "Aguardar a campanha do mês que vem",
    });
    expect(outcome.rejectedCount).toBe(1);

    expect((await getActivePrice(db, b))?.priceCents).toBe(1690);
    const [latest] = await listPriceVersions(db, b);
    expect(latest.status).toBe("rejected");
    expect(latest.rejectionReason).toBe("Aguardar a campanha do mês que vem");
    expect(latest.rejectedAt).not.toBeNull();

    expect(await auditActions(batchId)).toContain("price.reject_batch");
    expect((await listBatchSummary(db, batchId)).items).toHaveLength(0);

    // Lote já resolvido: nova rejeição falha.
    await expect(
      rejectBatch(db, { batchId, userId: FIXED_USER_ID, reason: "de novo" }),
    ).rejects.toThrow(/lote/i);
  });
});

describe("applyPriceToProduct", () => {
  /** Variante extra no MESMO produto (createTestVariant cria um por chamada). */
  async function addVariant(
    productId: string,
    sku: string,
    attributes: Record<string, string>,
    opts: { isActive?: boolean } = {},
  ): Promise<string> {
    const [variant] = await db
      .insert(schema.productVariants)
      .values({
        productId,
        sku,
        costCents: 1000,
        attributes,
        isActive: opts.isActive ?? true,
      })
      .returning({ id: schema.productVariants.id });
    return variant.id;
  }

  /** Grade de 3 variantes ativas em 1690 + 1 inativa, nunca precificada. */
  async function gridWithActivePrices(): Promise<{
    productId: string;
    active: string[];
    inactive: string;
  }> {
    const { productId, variantId: p } = await createTestVariant(db, {
      sku: "GRADE-P",
    });
    const m = await addVariant(productId, "GRADE-M", { tamanho: "M" });
    const g = await addVariant(productId, "GRADE-G", { tamanho: "G" });
    const inactive = await addVariant(
      productId,
      "GRADE-GG",
      { tamanho: "GG" },
      { isActive: false },
    );

    for (const variantId of [p, m, g]) {
      const version = await createPriceVersion(db, {
        variantId,
        userId: FIXED_USER_ID,
        origin: "initial",
      });
      await approvePriceVersion(db, {
        versionId: version.id,
        userId: FIXED_USER_ID,
      });
    }
    return { productId, active: [p, m, g], inactive };
  }

  it("aplica a todas as ativas, ignora a inativa e roda de novo sem empilhar", async () => {
    const { productId, active, inactive } = await gridWithActivePrices();

    // 1690 -> 1790: +5,9% (abaixo do limiar) e margem saudável, ativa sozinho.
    const first = await applyPriceToProduct(db, {
      productId,
      priceCents: 1790,
      userId: FIXED_USER_ID,
    });

    expect(first).toMatchObject({
      productId,
      priceCents: 1790,
      created: 3,
      autoActivated: 3,
      pendingApproval: 0,
      skipped: 0,
    });

    for (const variantId of active) {
      const price = await getActivePrice(db, variantId);
      expect(price?.priceCents).toBe(1790);
      expect(price?.origin).toBe("bulk_update");
      expect(price?.batchId).toBe(first.batchId);
      // Uma ativa por variante: a de 1690 virou superseded.
      expect(await listPriceVersions(db, variantId)).toHaveLength(2);
    }

    // Variante inativa fica de fora: nem versão de preço ela ganha.
    expect(await listPriceVersions(db, inactive)).toHaveLength(0);
    expect(await auditActions(productId)).toContain("price.apply_to_product");

    const second = await applyPriceToProduct(db, {
      productId,
      priceCents: 1790,
      userId: FIXED_USER_ID,
    });
    expect(second).toMatchObject({
      created: 0,
      autoActivated: 0,
      pendingApproval: 0,
      skipped: 3,
    });
    for (const variantId of active) {
      expect(await listPriceVersions(db, variantId)).toHaveLength(2);
      expect((await getActivePrice(db, variantId))?.priceCents).toBe(1790);
    }
  });

  it("queda de preço fica pendente e o lote inteiro aprova de uma vez", async () => {
    const { productId, active } = await gridWithActivePrices();

    // 1690 -> 1190: queda de preço e margem abaixo do mínimo, vai a aprovação.
    const first = await applyPriceToProduct(db, {
      productId,
      priceCents: 1190,
      userId: FIXED_USER_ID,
    });
    expect(first).toMatchObject({
      created: 3,
      autoActivated: 0,
      pendingApproval: 3,
      skipped: 0,
    });
    // Enquanto ninguém aprova, o preço que vale segue sendo o antigo.
    for (const variantId of active) {
      expect((await getActivePrice(db, variantId))?.priceCents).toBe(1690);
    }

    const second = await applyPriceToProduct(db, {
      productId,
      priceCents: 1190,
      userId: FIXED_USER_ID,
    });
    expect(second).toMatchObject({ created: 0, skipped: 3 });

    expect((await listBatchSummary(db, first.batchId)).items).toHaveLength(3);
    const approved = await approveBatch(db, {
      batchId: first.batchId,
      userId: FIXED_USER_ID,
    });
    expect(approved.approvedCount).toBe(3);
    for (const variantId of active) {
      expect((await getActivePrice(db, variantId))?.priceCents).toBe(1190);
    }
  });

  it("recusa produto inexistente e produto sem variante ativa", async () => {
    await expect(
      applyPriceToProduct(db, {
        productId: randomUUID(),
        priceCents: 1990,
        userId: FIXED_USER_ID,
      }),
    ).rejects.toThrow(ServiceError);

    const { productId, variantId } = await createTestVariant(db, {
      sku: "SO-INATIVA",
    });
    await db
      .update(schema.productVariants)
      .set({ isActive: false })
      .where(eq(schema.productVariants.id, variantId));

    await expect(
      applyPriceToProduct(db, {
        productId,
        priceCents: 1990,
        userId: FIXED_USER_ID,
      }),
    ).rejects.toThrow(/variante ativa/i);
  });
});
