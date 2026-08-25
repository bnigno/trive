// Integração das operações em lote de precificação (recálculo geral +
// aprovação/rejeição por lote). Banco NOVO por teste: recalculateAllPrices
// varre TODAS as variantes ativas, então isolamento total evita interferência.
// Referência das fixtures (custo 1000, taxa 4,98%, margem 30%, to_90 up):
// preço 1690. Custo 1050 -> 1790 (+5,9%: ativa sozinho); custo 1400 -> 2290
// (+35,5%: pendente); custo 700 -> 1190 (queda: pendente).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import * as schema from "@/db/schema";
import {
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
