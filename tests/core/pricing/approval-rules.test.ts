import { describe, expect, it } from "vitest";

import {
  evaluateApproval,
  type ApprovalContext,
} from "../../../src/core/pricing/approval-rules";

function makeContext(overrides: Partial<ApprovalContext> = {}): ApprovalContext {
  return {
    newPriceCents: 10500,
    previousActivePriceCents: 10000,
    effectiveMarginRate: 0.35,
    minMarginRate: 0.2,
    totalCostCents: 6000,
    changePctThreshold: 0.1,
    isFirstPrice: false,
    firstPriceRequiresApproval: true,
    isBulk: false,
    ...overrides,
  };
}

describe("evaluateApproval", () => {
  it("aumento dentro do threshold com margem ok é automático", () => {
    expect(evaluateApproval(makeContext())).toEqual({
      requiresApproval: false,
      reasons: [],
    });
  });

  it("limiar exato: threshold − 1 centavo, igual e + 1 centavo", () => {
    // prev 10000, threshold 10% => fronteira em 11000 (variação relativa)
    expect(evaluateApproval(makeContext({ newPriceCents: 10999 }))).toEqual({
      requiresApproval: false,
      reasons: [],
    });
    // exatamente no threshold NÃO exige aprovação (limiar exclusivo)
    expect(evaluateApproval(makeContext({ newPriceCents: 11000 }))).toEqual({
      requiresApproval: false,
      reasons: [],
    });
    expect(evaluateApproval(makeContext({ newPriceCents: 11001 }))).toEqual({
      requiresApproval: true,
      reasons: ["change_above_threshold"],
    });
  });

  it("limiar é simétrico para reduções (além do próprio price_drop)", () => {
    expect(evaluateApproval(makeContext({ newPriceCents: 9000 }))).toEqual({
      requiresApproval: true,
      reasons: ["price_drop"],
    });
    expect(evaluateApproval(makeContext({ newPriceCents: 8999 }))).toEqual({
      requiresApproval: true,
      reasons: ["price_drop", "change_above_threshold"],
    });
  });

  it("redução de 1 centavo exige aprovação", () => {
    const decision = evaluateApproval(makeContext({ newPriceCents: 9999 }));
    expect(decision.requiresApproval).toBe(true);
    expect(decision.reasons).toEqual(["price_drop"]);
  });

  it("margem abaixo do mínimo exige aprovação; igual ao mínimo não", () => {
    expect(
      evaluateApproval(makeContext({ effectiveMarginRate: 0.19 })).reasons,
    ).toEqual(["below_min_margin"]);
    expect(
      evaluateApproval(makeContext({ effectiveMarginRate: 0.2 })).reasons,
    ).toEqual([]);
  });

  it("preço abaixo do custo total exige aprovação; igual ao custo não", () => {
    const base = {
      previousActivePriceCents: null,
      isFirstPrice: false,
    } as const;
    expect(
      evaluateApproval(makeContext({ ...base, newPriceCents: 5999 })).reasons,
    ).toEqual(["below_cost"]);
    expect(
      evaluateApproval(makeContext({ ...base, newPriceCents: 6000 })).reasons,
    ).toEqual([]);
  });

  it("mudança em massa sempre exige aprovação", () => {
    expect(evaluateApproval(makeContext({ isBulk: true }))).toEqual({
      requiresApproval: true,
      reasons: ["bulk_change"],
    });
  });

  it("primeira precificação depende da configuração", () => {
    const first = {
      previousActivePriceCents: null,
      isFirstPrice: true,
    } as const;
    expect(
      evaluateApproval(makeContext({ ...first, firstPriceRequiresApproval: true })),
    ).toEqual({ requiresApproval: true, reasons: ["first_price"] });
    expect(
      evaluateApproval(
        makeContext({ ...first, firstPriceRequiresApproval: false }),
      ),
    ).toEqual({ requiresApproval: false, reasons: [] });
  });

  it("sem preço anterior não avalia queda nem variação", () => {
    expect(
      evaluateApproval(
        makeContext({ previousActivePriceCents: null, newPriceCents: 100 }),
      ).reasons,
    ).toEqual(["below_cost"]);
  });

  it("preço anterior zero torna qualquer mudança acima do threshold", () => {
    expect(
      evaluateApproval(
        makeContext({ previousActivePriceCents: 0, newPriceCents: 10500 }),
      ).reasons,
    ).toEqual(["change_above_threshold"]);
  });

  it("acumula todos os motivos aplicáveis, na ordem", () => {
    const decision = evaluateApproval(
      makeContext({
        newPriceCents: 4000,
        effectiveMarginRate: 0.05,
        isBulk: true,
      }),
    );
    expect(decision).toEqual({
      requiresApproval: true,
      reasons: [
        "price_drop",
        "below_min_margin",
        "change_above_threshold",
        "below_cost",
        "bulk_change",
      ],
    });
  });
});
