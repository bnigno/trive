// Integração do serviço de configurações com banco real (PGlite + migrações).
// Referência das fixtures: custo 1000, taxa 4,98%, margem 30%, to_90 up
// => preço 1690. Com taxa 20%: 1000 / (1 - 0.2 - 0.3) = 2000 -> to_90 up = 2090.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import * as schema from "@/db/schema";
import {
  getDefaultPolicy,
  getFeeRules,
  getSettingsMap,
  replaceFeeRule,
  ServiceError,
  updateDefaultPolicy,
  updateSetting,
} from "@/services/settings";
import { previewPrice } from "@/services/pricing";
import {
  createTestDb,
  createTestFeeRuleAndPolicy,
  createTestVariant,
  FIXED_USER_ID,
  type TestDb,
} from "../helpers/db";

let db: TestDb;
let close: () => Promise<void>;
let originalFeeRuleId: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  ({ feeRuleId: originalFeeRuleId } = await createTestFeeRuleAndPolicy(db));
});

afterAll(async () => {
  await close();
});

describe("replaceFeeRule", () => {
  it("encerra a vigência da regra atual e o novo cálculo usa a nova taxa", async () => {
    const { variantId } = await createTestVariant(db, { costCents: 1000 });

    const before = await previewPrice(db, { variantId });
    expect(before.result.priceCents).toBe(1690);
    expect(before.context.feeRuleId).toBe(originalFeeRuleId);

    const created = await replaceFeeRule(db, {
      paymentMethod: "credit_card",
      percentRate: 0.2,
      fixedFeeCents: 50,
      settlementDays: 14,
      userId: FIXED_USER_ID,
    });

    // Nova regra vigente, herdando a marcação de referência da substituída.
    expect(created.id).not.toBe(originalFeeRuleId);
    expect(created.percentRate).toBe(0.2);
    expect(created.fixedFeeCents).toBe(50);
    expect(created.settlementDays).toBe(14);
    expect(created.isReferenceForPricing).toBe(true);
    expect(created.effectiveTo).toBeNull();

    // Regra antiga: vigência encerrada (effective_to preenchido), não editada.
    const [old] = await db
      .select()
      .from(schema.paymentFeeRules)
      .where(eq(schema.paymentFeeRules.id, originalFeeRuleId));
    expect(old.effectiveTo).not.toBeNull();
    expect(Number(old.percentRate)).toBe(0.0498);

    const { current, history } = await getFeeRules(db);
    expect(current.map((r) => r.id)).toContain(created.id);
    expect(current.map((r) => r.id)).not.toContain(originalFeeRuleId);
    expect(history.map((r) => r.id)).toContain(originalFeeRuleId);

    // Novo cálculo usa a nova taxa: (1000 + 50) / (1 - 0.2 - 0.3) = 2100
    // -> to_90 up = 2190.
    const after = await previewPrice(db, { variantId });
    expect(after.context.feeRuleId).toBe(created.id);
    expect(after.result.priceCents).toBe(2190);

    // Audit da substituição.
    const audits = await db
      .select({ action: schema.auditLog.action })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.entityId, created.id));
    expect(audits.map((a) => a.action)).toContain("feerule.replace");
  });

  it("marcar outra regra como referência desmarca a anterior", async () => {
    const pixRule = await replaceFeeRule(db, {
      paymentMethod: "pix",
      percentRate: 0.0099,
      fixedFeeCents: 0,
      settlementDays: 0,
      isReferenceForPricing: true,
      userId: FIXED_USER_ID,
    });

    const { current } = await getFeeRules(db);
    const references = current.filter((r) => r.isReferenceForPricing);
    expect(references).toHaveLength(1);
    expect(references[0].id).toBe(pixRule.id);
  });
});

describe("getDefaultPolicy / updateDefaultPolicy", () => {
  it("atualiza a política global e valida margem mínima <= alvo", async () => {
    const updated = await updateDefaultPolicy(db, {
      targetMarginRate: 0.35,
      minMarginRate: 0.1,
      roundingMode: "to_99",
      roundingDirection: "nearest",
      otherCostsFixedCents: 250,
      userId: FIXED_USER_ID,
    });
    expect(updated.targetMarginRate).toBe(0.35);
    expect(updated.otherCostsFixedCents).toBe(250);

    const fetched = await getDefaultPolicy(db);
    expect(fetched?.id).toBe(updated.id);
    expect(fetched?.minMarginRate).toBe(0.1);
    expect(fetched?.roundingMode).toBe("to_99");
    expect(fetched?.roundingDirection).toBe("nearest");

    await expect(
      updateDefaultPolicy(db, {
        targetMarginRate: 0.2,
        minMarginRate: 0.3,
        roundingMode: "to_90",
        roundingDirection: "up",
        otherCostsFixedCents: 0,
        userId: FIXED_USER_ID,
      }),
    ).rejects.toThrow("A margem mínima não pode ser maior que a margem alvo.");
  });
});

describe("updateSetting / getSettingsMap", () => {
  it("rejeita key desconhecida com ServiceError", async () => {
    await expect(
      updateSetting(db, {
        key: "chave_que_nao_existe",
        value: 1,
        userId: FIXED_USER_ID,
      }),
    ).rejects.toThrow(ServiceError);
    await expect(
      updateSetting(db, {
        key: "chave_que_nao_existe",
        value: 1,
        userId: FIXED_USER_ID,
      }),
    ).rejects.toThrow(/desconhecida/i);
  });

  it("rejeita valor com tipo errado para uma key permitida", async () => {
    await expect(
      updateSetting(db, {
        key: "first_price_requires_approval",
        value: "sim",
        userId: FIXED_USER_ID,
      }),
    ).rejects.toThrow(ServiceError);
  });

  it("atualiza key permitida e reflete no getSettingsMap", async () => {
    await updateSetting(db, {
      key: "price_change_pct_threshold",
      value: 0.25,
      userId: FIXED_USER_ID,
    });
    await updateSetting(db, {
      key: "default_low_stock_threshold",
      value: 7,
      userId: FIXED_USER_ID,
    });

    const map = await getSettingsMap(db, [
      "price_change_pct_threshold",
      "default_low_stock_threshold",
    ]);
    expect(map.price_change_pct_threshold).toBe(0.25);
    expect(map.default_low_stock_threshold).toBe(7);
  });

  it("store_pix_key: aparas espaços, aceita vazia (= desligado) e limita a 140", async () => {
    const saved = await updateSetting(db, {
      key: "store_pix_key",
      value: "  pix@trive.com.br  ",
      userId: FIXED_USER_ID,
    });
    expect(saved.value).toBe("pix@trive.com.br");

    const map = await getSettingsMap(db, ["store_pix_key"]);
    expect(map.store_pix_key).toBe("pix@trive.com.br");

    // Vazia desliga o recurso (o robô responde indisponível) — permitida.
    const cleared = await updateSetting(db, {
      key: "store_pix_key",
      value: "",
      userId: FIXED_USER_ID,
    });
    expect(cleared.value).toBe("");

    await expect(
      updateSetting(db, {
        key: "store_pix_key",
        value: "x".repeat(141),
        userId: FIXED_USER_ID,
      }),
    ).rejects.toThrow(/140/);
  });
});

describe("replaceFeeRule — métodos manuais (pix_manual/cash)", () => {
  it("aceita os métodos novos do core (dono edita a taxa dos 5)", async () => {
    const cash = await replaceFeeRule(db, {
      paymentMethod: "cash",
      percentRate: 0,
      fixedFeeCents: 0,
      settlementDays: 0,
      userId: FIXED_USER_ID,
    });
    expect(cash.paymentMethod).toBe("cash");
    expect(cash.percentRate).toBe(0);

    const pixManual = await replaceFeeRule(db, {
      paymentMethod: "pix_manual",
      percentRate: 0,
      fixedFeeCents: 0,
      settlementDays: 0,
      userId: FIXED_USER_ID,
    });
    expect(pixManual.paymentMethod).toBe("pix_manual");
  });
});
