// Integração do serviço de precificação com banco real (PGlite + migrações).
// Referência com as fixtures padrão (custo 1000, taxa 4,98%, margem 30%,
// arredondamento to_90 para cima): preço 1690, margem efetiva 0.3586.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import * as schema from "@/db/schema";
import {
  approvePriceVersion,
  createPriceVersion,
  getActivePrice,
  getPricingContext,
  listPendingApprovals,
  listPricesOverview,
  listPriceVersions,
  previewPrice,
  rejectPriceVersion,
  ServiceError,
  setVariantCost,
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

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await createTestFeeRuleAndPolicy(db);
});

afterAll(async () => {
  await close();
});

async function newVariant(costCents = 1000): Promise<string> {
  const { variantId } = await createTestVariant(db, { costCents });
  return variantId;
}

async function auditActions(entityId: string): Promise<string[]> {
  const rows = await db
    .select({ action: schema.auditLog.action })
    .from(schema.auditLog)
    .where(eq(schema.auditLog.entityId, entityId));
  return rows.map((r) => r.action);
}

describe("getPricingContext / previewPrice", () => {
  it("converte numeric string -> Number com 4 casas e resolve o contexto", async () => {
    const variantId = await newVariant();
    const ctx = await getPricingContext(db, variantId);

    expect(ctx.feeRule.percentRate).toBe(0.0498);
    expect(ctx.policy.targetMarginRate).toBe(0.3);
    expect(ctx.policy.minMarginRate).toBe(0.15);
    expect(ctx.policy.otherCostsRate).toBe(0);
    expect(ctx.settings.priceChangePctThreshold).toBe(0.1);
    expect(ctx.settings.firstPriceRequiresApproval).toBe(true);
    expect(ctx.variant.costCents).toBe(1000);
    expect(ctx.previousActive).toBeNull();

    const preview = await previewPrice(db, { variantId });
    // custo 1000 / (1 - 0.0498 - 0.30) = 1538 -> to_90 up -> 1690
    expect(preview.result.priceCents).toBe(1690);
    // margem efetiva com 4 casas: (1690 - 1000 - 84) / 1690 = 0.3586
    expect(preview.result.effectiveMarginRate).toBe(0.3586);
    expect(preview.context.costCents).toBe(1000);
    expect(preview.context.previousActivePriceCents).toBeNull();
    expect(preview.context.feeRuleId).toBeTruthy();
    expect(preview.context.policyId).toBeTruthy();
  });
});

describe("createPriceVersion", () => {
  it("primeira precificação exige aprovação (setting first_price_requires_approval)", async () => {
    const variantId = await newVariant();
    const version = await createPriceVersion(db, {
      variantId,
      userId: FIXED_USER_ID,
      origin: "initial",
    });

    expect(version.status).toBe("pending_approval");
    expect(version.requiresApproval).toBe(true);
    expect(version.approvalReasons).toContain("first_price");
    expect(version.versionNumber).toBe(1);
    expect(version.priceCents).toBe(1690);
    expect(version.computedMarginRate).toBe("0.3586");
    expect(version.costSnapshotCents).toBe(1000);
    expect(version.activatedAt).toBeNull();

    expect(await getActivePrice(db, variantId)).toBeNull();
    expect(await auditActions(version.id)).toContain("price.submit");

    // Nenhum evento de ativação enquanto pendente.
    const outbox = await db
      .select()
      .from(schema.outboxEvents)
      .where(eq(schema.outboxEvents.dedupeKey, `price.activated:${version.id}`));
    expect(outbox).toHaveLength(0);
  });

  it("aumento <= 10% com margem saudável ativa sozinho e supersede a anterior", async () => {
    const variantId = await newVariant();
    const v1 = await createPriceVersion(db, {
      variantId,
      userId: FIXED_USER_ID,
      origin: "initial",
    });
    await approvePriceVersion(db, { versionId: v1.id, userId: FIXED_USER_ID });

    // margem alvo 35% -> 1790 (+5,9% sobre 1690, margem 0.3916 >= 0.15)
    const v2 = await createPriceVersion(db, {
      variantId,
      userId: FIXED_USER_ID,
      origin: "manual",
      overrides: { targetMarginRate: 0.35 },
    });

    expect(v2.status).toBe("active");
    expect(v2.requiresApproval).toBe(false);
    expect(v2.approvalReasons).toEqual([]);
    expect(v2.priceCents).toBe(1790);
    expect(v2.previousPriceCents).toBe(1690);
    expect(v2.activatedAt).not.toBeNull();
    expect(v2.approvedBy).toBe(FIXED_USER_ID);

    const [v1After] = await db
      .select()
      .from(schema.priceVersions)
      .where(eq(schema.priceVersions.id, v1.id));
    expect(v1After.status).toBe("superseded");
    expect(v1After.supersededAt).not.toBeNull();

    expect((await getActivePrice(db, variantId))?.id).toBe(v2.id);
    expect(await auditActions(v2.id)).toContain("price.auto_activate");

    const outbox = await db
      .select()
      .from(schema.outboxEvents)
      .where(eq(schema.outboxEvents.dedupeKey, `price.activated:${v2.id}`));
    expect(outbox).toHaveLength(1);
    expect(outbox[0].payload).toMatchObject({ variantId, priceCents: 1790 });
  });

  it("redução de preço fica pendente e não muda o preço ativo", async () => {
    const variantId = await newVariant();
    const v1 = await createPriceVersion(db, {
      variantId,
      userId: FIXED_USER_ID,
      origin: "initial",
    });
    await approvePriceVersion(db, { versionId: v1.id, userId: FIXED_USER_ID });

    // margem alvo 20% -> 1490 (queda de 1690)
    const v2 = await createPriceVersion(db, {
      variantId,
      userId: FIXED_USER_ID,
      origin: "manual",
      overrides: { targetMarginRate: 0.2 },
    });

    expect(v2.status).toBe("pending_approval");
    expect(v2.priceCents).toBe(1490);
    expect(v2.approvalReasons).toContain("price_drop");
    expect(v2.approvalReasons).toContain("change_above_threshold");
    expect((await getActivePrice(db, variantId))?.priceCents).toBe(1690);

    const pending = await listPendingApprovals(db);
    const item = pending.find((p) => p.versionId === v2.id);
    expect(item).toBeDefined();
    expect(item?.sku).toBeTruthy();
    expect(item?.productName).toBeTruthy();
    expect(item?.priceCents).toBe(1490);
    expect(item?.currentActivePriceCents).toBe(1690);
    expect(item?.computedMarginRate).toBeCloseTo(0.2792, 10);
  });

  it("preço manual abaixo do custo -> requires_approval com reason below_cost", async () => {
    const variantId = await newVariant();
    const version = await createPriceVersion(db, {
      variantId,
      userId: FIXED_USER_ID,
      origin: "manual",
      priceCentsManual: 900,
    });

    expect(version.status).toBe("pending_approval");
    expect(version.requiresApproval).toBe(true);
    expect(version.approvalReasons).toContain("below_cost");
    expect(version.approvalReasons).toContain("below_min_margin");
    expect(version.priceCents).toBe(900);
    // margem via suggestMarginForPrice: (900 - 1000 - 45) / 900 = -0.1611
    expect(version.computedMarginRate).toBe("-0.1611");
    expect(version.breakdown).toMatchObject({ manualPriceCents: 900 });
    expect((version.breakdown as { note?: string }).note).toMatch(/manual/i);
  });
});

describe("aprovação / ativação", () => {
  it("aprovar ativa a versão, audita e enfileira price.activated", async () => {
    const variantId = await newVariant();
    const v1 = await createPriceVersion(db, {
      variantId,
      userId: FIXED_USER_ID,
      origin: "initial",
    });

    const approved = await approvePriceVersion(db, {
      versionId: v1.id,
      userId: FIXED_USER_ID,
    });

    expect(approved.status).toBe("active");
    expect(approved.approvedBy).toBe(FIXED_USER_ID);
    expect(approved.approvedAt).not.toBeNull();
    expect(approved.activatedAt).not.toBeNull();
    expect((await getActivePrice(db, variantId))?.id).toBe(v1.id);
    expect(await auditActions(v1.id)).toContain("price.approve");

    const outbox = await db
      .select()
      .from(schema.outboxEvents)
      .where(eq(schema.outboxEvents.dedupeKey, `price.activated:${v1.id}`));
    expect(outbox).toHaveLength(1);
  });

  it("segunda ativação da mesma versão falha; UNIQUE parcial é a rede final", async () => {
    const variantId = await newVariant();
    const v1 = await createPriceVersion(db, {
      variantId,
      userId: FIXED_USER_ID,
      origin: "initial",
    });
    await approvePriceVersion(db, { versionId: v1.id, userId: FIXED_USER_ID });

    // Reaprovar a mesma versão (já ativa) falha com erro de negócio claro.
    await expect(
      approvePriceVersion(db, { versionId: v1.id, userId: FIXED_USER_ID }),
    ).rejects.toThrow(ServiceError);
    await expect(
      approvePriceVersion(db, { versionId: v1.id, userId: FIXED_USER_ID }),
    ).rejects.toThrow(/pendentes de aprovação/);

    // Nova versão ativa; a anterior vira superseded.
    const v2 = await createPriceVersion(db, {
      variantId,
      userId: FIXED_USER_ID,
      origin: "manual",
      overrides: { targetMarginRate: 0.35 },
    });
    expect(v2.status).toBe("active");

    // Forçar um segundo 'active' direto no banco viola o índice único parcial
    // (drizzle embrulha o erro do driver; a violação fica no cause).
    const forcedActivation = await db
      .update(schema.priceVersions)
      .set({ status: "active" })
      .where(eq(schema.priceVersions.id, v1.id))
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(forcedActivation).not.toBeNull();
    const causeMessage = String(
      (forcedActivation as { cause?: { message?: string } }).cause?.message ??
        (forcedActivation as Error).message,
    );
    expect(causeMessage).toMatch(/unique|duplicate/i);
  });

  it("rejeitar exige motivo e mantém o preço ativo anterior", async () => {
    const variantId = await newVariant();
    const v1 = await createPriceVersion(db, {
      variantId,
      userId: FIXED_USER_ID,
      origin: "initial",
    });
    await approvePriceVersion(db, { versionId: v1.id, userId: FIXED_USER_ID });

    const v2 = await createPriceVersion(db, {
      variantId,
      userId: FIXED_USER_ID,
      origin: "manual",
      overrides: { targetMarginRate: 0.2 },
    });
    expect(v2.status).toBe("pending_approval");

    // Sem motivo (vazio ou ausente) -> erro de validação.
    await expect(
      rejectPriceVersion(db, {
        versionId: v2.id,
        userId: FIXED_USER_ID,
        reason: "",
      }),
    ).rejects.toThrow(/[Mm]otivo/);
    await expect(
      // @ts-expect-error reason é obrigatório
      rejectPriceVersion(db, { versionId: v2.id, userId: FIXED_USER_ID }),
    ).rejects.toThrow();

    const rejected = await rejectPriceVersion(db, {
      versionId: v2.id,
      userId: FIXED_USER_ID,
      reason: "Preço abaixo da estratégia da coleção",
    });
    expect(rejected.status).toBe("rejected");
    expect(rejected.rejectionReason).toBe("Preço abaixo da estratégia da coleção");
    expect(rejected.rejectedAt).not.toBeNull();

    expect((await getActivePrice(db, variantId))?.priceCents).toBe(1690);
    expect(await auditActions(v2.id)).toContain("price.reject");
  });
});

describe("setVariantCost", () => {
  it("aumento de custo com versão ativa gera nova versão automática", async () => {
    const variantId = await newVariant();
    const v1 = await createPriceVersion(db, {
      variantId,
      userId: FIXED_USER_ID,
      origin: "initial",
    });
    await approvePriceVersion(db, { versionId: v1.id, userId: FIXED_USER_ID });

    const result = await setVariantCost(db, {
      variantId,
      costCents: 1200,
      note: "Reajuste do fornecedor",
      userId: FIXED_USER_ID,
    });

    expect(result.previousCostCents).toBe(1000);
    expect(result.costCents).toBe(1200);
    expect(result.priceVersion).not.toBeNull();
    expect(result.priceVersion?.origin).toBe("auto_cost_change");
    expect(result.priceVersion?.costSnapshotCents).toBe(1200);
    // custo 1200 -> 1990 (+17,8% sobre 1690): acima do limiar, fica pendente.
    expect(result.priceVersion?.priceCents).toBe(1990);
    expect(result.priceVersion?.status).toBe("pending_approval");
    expect(result.priceVersion?.approvalReasons).toContain(
      "change_above_threshold",
    );
    expect((await getActivePrice(db, variantId))?.priceCents).toBe(1690);

    // Ledger de custos + denormalização na variante + auditoria.
    const costRows = await db
      .select()
      .from(schema.variantCosts)
      .where(eq(schema.variantCosts.productVariantId, variantId));
    expect(costRows).toHaveLength(1);
    expect(costRows[0].costCents).toBe(1200);
    expect(costRows[0].source).toBe("manual");

    const [variant] = await db
      .select()
      .from(schema.productVariants)
      .where(eq(schema.productVariants.id, variantId));
    expect(variant.costCents).toBe(1200);
    expect(await auditActions(variantId)).toContain("cost.set");
  });

  it("sem versão ativa, só registra o custo (nenhuma versão automática)", async () => {
    const variantId = await newVariant();
    const result = await setVariantCost(db, {
      variantId,
      costCents: 1500,
      userId: FIXED_USER_ID,
    });

    expect(result.priceVersion).toBeNull();
    expect(await listPriceVersions(db, variantId)).toHaveLength(0);
  });
});

describe("consultas", () => {
  it("listPriceVersions e listPricesOverview refletem estado e margens numéricas", async () => {
    const variantId = await newVariant();
    const v1 = await createPriceVersion(db, {
      variantId,
      userId: FIXED_USER_ID,
      origin: "initial",
    });
    await approvePriceVersion(db, { versionId: v1.id, userId: FIXED_USER_ID });
    const v2 = await createPriceVersion(db, {
      variantId,
      userId: FIXED_USER_ID,
      origin: "manual",
      overrides: { targetMarginRate: 0.2 },
    });

    const versions = await listPriceVersions(db, variantId);
    expect(versions.map((v) => v.versionNumber)).toEqual([2, 1]);
    expect(versions.map((v) => v.id)).toEqual([v2.id, v1.id]);

    const overview = await listPricesOverview(db);
    const row = overview.find((r) => r.variantId === variantId);
    expect(row).toBeDefined();
    expect(row?.costCents).toBe(1000);
    expect(row?.activePriceCents).toBe(1690);
    expect(row?.activeMarginRate).toBe(0.3586);
    expect(row?.pendingCount).toBe(1);
  });

  it("erros claros quando falta regra de taxa ou política", async () => {
    const isolated = await createTestDb();
    try {
      const { variantId } = await createTestVariant(isolated.db, {
        costCents: 1000,
      });
      await expect(
        getPricingContext(isolated.db, variantId),
      ).rejects.toThrow(/taxa de pagamento/i);
    } finally {
      await isolated.close();
    }
  });
});
