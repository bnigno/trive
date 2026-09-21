import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  eligibleSubtotalCents,
  evaluateCoupon,
  isWithinSchedule,
  type CouponContext,
  type CouponContextItem,
  type CouponRule,
} from "@/core/coupons/evaluate";

// 2026-09-20 é sábado. 15:30 em São Paulo = 18:30Z.
const NOW = new Date("2026-09-20T18:30:00.000Z");

function rule(overrides: Partial<CouponRule> = {}): CouponRule {
  return {
    id: "cpn-1",
    code: "TESTE10",
    type: "percent",
    value: 10,
    minOrderCents: 0,
    startsAt: null,
    expiresAt: null,
    maxUses: null,
    usedCount: 0,
    isActive: true,
    perCustomerLimit: null,
    customerId: null,
    phoneE164: null,
    firstPurchaseOnly: false,
    freeShippingScope: "any",
    validWeekdays: null,
    validFromMinute: null,
    validToMinute: null,
    productIds: [],
    categoryIds: [],
    valueSchedule: null,
    growthPerRedeemer: 0,
    growthCap: null,
    createdAt: new Date("2026-09-01T12:00:00.000Z"),
    ...overrides,
  };
}

const VESTIDO: CouponContextItem = { productId: "p-vestido", categoryId: "cat-vestidos", unitPriceCents: 19900, quantity: 1 };
const BLUSA: CouponContextItem = { productId: "p-blusa", categoryId: "cat-blusas", unitPriceCents: 8900, quantity: 2 };

function ctx(overrides: Partial<CouponContext> = {}): CouponContext {
  return {
    now: NOW,
    items: [VESTIDO, BLUSA],
    shipping: { cents: 1500, kind: "motoboy" },
    identity: { customerId: "cust-1", phoneE164: "+5591999990000" },
    priorPurchases: 0,
    priorRedemptionsByThisCustomer: 0,
    ...overrides,
  };
}

function expectOk(result: ReturnType<typeof evaluateCoupon>) {
  if (!result.ok) throw new Error(`esperava ok, veio ${result.code}`);
  return result;
}

describe("evaluateCoupon — cálculo", () => {
  it("percent: floor sobre o subtotal, appliedValue = valor do cupom", () => {
    const r = expectOk(evaluateCoupon(rule({ value: 7 }), ctx({ items: [{ ...VESTIDO, unitPriceCents: 1999 }] })));
    expect(r.discountCents).toBe(139); // floor(1999 × 0,07 = 139,93)
    expect(r.appliedValue).toBe(7);
    expect(r.subtotalCents).toBe(1999);
    expect(r.eligibleSubtotalCents).toBe(1999);
    expect(r.freeShipping).toBe(false);
    expect(r.shippingDiscountCents).toBe(0);
    expect(r.pending).toEqual([]);
  });

  it("fixed: nunca desconta mais que o subtotal elegível", () => {
    const r = expectOk(evaluateCoupon(rule({ type: "fixed", value: 99900 }), ctx({ items: [VESTIDO] })));
    expect(r.discountCents).toBe(19900);
    expect(r.appliedValue).toBe(99900);
  });

  it("free_shipping: perdoa o frete conhecido e não mexe nas peças", () => {
    const r = expectOk(evaluateCoupon(rule({ type: "free_shipping", value: 0 }), ctx()));
    expect(r).toMatchObject({ discountCents: 0, appliedValue: 0, freeShipping: true, shippingDiscountCents: 1500, pending: [] });
  });

  it("free_shipping sem entrega escolhida: frete perdoado 0 (o checkout recalcula)", () => {
    const r = expectOk(evaluateCoupon(rule({ type: "free_shipping", value: 0 }), ctx({ shipping: null })));
    expect(r.shippingDiscountCents).toBe(0);
    expect(r.freeShipping).toBe(true);
    expect(r.pending).toEqual([]);
  });

  it("propriedade: desconto ≤ elegível ≤ subtotal e frete perdoado ≤ frete", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            productId: fc.constantFrom("p-a", "p-b", "p-c"),
            categoryId: fc.constantFrom("c-1", "c-2", null),
            unitPriceCents: fc.integer({ min: 0, max: 100_000 }),
            quantity: fc.integer({ min: 1, max: 5 }),
          }),
          { minLength: 1, maxLength: 6 },
        ),
        fc.constantFrom<CouponRule["type"]>("percent", "fixed", "free_shipping"),
        fc.integer({ min: 1, max: 100 }),
        fc.integer({ min: 0, max: 5000 }),
        fc.subarray(["p-a", "p-b"]),
        (items, type, value, shippingCents, productIds) => {
          const r = evaluateCoupon(
            rule({ type, value: type === "free_shipping" ? 0 : type === "fixed" ? value * 100 : value, productIds }),
            ctx({ items, shipping: { cents: shippingCents, kind: "correios" } }),
          );
          if (!r.ok) return r.code === "COUPON_NO_ELIGIBLE_ITEMS";
          return (
            r.discountCents <= r.eligibleSubtotalCents &&
            r.eligibleSubtotalCents <= r.subtotalCents &&
            r.shippingDiscountCents <= shippingCents
          );
        },
      ),
    );
  });
});

describe("evaluateCoupon — ordem das recusas", () => {
  it("inativo vence vencido; vencido vence esgotado; esgotado vence mínimo", () => {
    const past = new Date("2026-01-01T00:00:00.000Z");
    expect(evaluateCoupon(rule({ isActive: false, expiresAt: past, maxUses: 1, usedCount: 1 }), ctx())).toEqual({ ok: false, code: "COUPON_INACTIVE" });
    expect(evaluateCoupon(rule({ expiresAt: past, maxUses: 1, usedCount: 1 }), ctx())).toEqual({ ok: false, code: "COUPON_EXPIRED" });
    expect(evaluateCoupon(rule({ maxUses: 1, usedCount: 1, minOrderCents: 999_999 }), ctx())).toEqual({ ok: false, code: "COUPON_EXHAUSTED" });
    expect(evaluateCoupon(rule({ minOrderCents: 999_999 }), ctx())).toEqual({ ok: false, code: "COUPON_MIN_ORDER" });
  });

  it("vigência futura", () => {
    expect(evaluateCoupon(rule({ startsAt: new Date("2026-12-01T00:00:00.000Z") }), ctx())).toEqual({ ok: false, code: "COUPON_NOT_STARTED" });
  });

  it("mínimo é sobre o pedido inteiro, mesmo com restrição de peça", () => {
    const r = expectOk(evaluateCoupon(rule({ minOrderCents: 30_000, productIds: ["p-vestido"] }), ctx()));
    expect(r.subtotalCents).toBe(37_700);
    expect(r.eligibleSubtotalCents).toBe(19_900);
    expect(r.discountCents).toBe(1990);
  });
});

describe("evaluateCoupon — peças e categorias", () => {
  it("desconto só sobre as peças da restrição (por produto ou categoria)", () => {
    expect(eligibleSubtotalCents(rule({ categoryIds: ["cat-blusas"] }), [VESTIDO, BLUSA])).toBe(17_800);
    expect(eligibleSubtotalCents(rule({ productIds: ["p-vestido"], categoryIds: ["cat-blusas"] }), [VESTIDO, BLUSA])).toBe(37_700);
    expect(eligibleSubtotalCents(rule(), [VESTIDO, BLUSA])).toBe(37_700);
  });

  it("nenhuma peça elegível na sacola", () => {
    expect(evaluateCoupon(rule({ productIds: ["p-outra"] }), ctx())).toEqual({ ok: false, code: "COUPON_NO_ELIGIBLE_ITEMS" });
  });

  it("peça sem categoria não casa com restrição por categoria", () => {
    expect(eligibleSubtotalCents(rule({ categoryIds: ["cat-blusas"] }), [{ ...BLUSA, categoryId: null }])).toBe(0);
  });
});

describe("evaluateCoupon — cupom pessoal", () => {
  it("bate por cadastro ou por telefone", () => {
    expect(evaluateCoupon(rule({ customerId: "cust-1" }), ctx()).ok).toBe(true);
    expect(evaluateCoupon(rule({ phoneE164: "+5591999990000" }), ctx({ identity: { customerId: null, phoneE164: "+5591999990000" } })).ok).toBe(true);
    expect(evaluateCoupon(rule({ customerId: "cust-1", phoneE164: "+5591000000000" }), ctx()).ok).toBe(true);
  });

  it("de outra cliente", () => {
    expect(evaluateCoupon(rule({ customerId: "cust-2" }), ctx())).toEqual({ ok: false, code: "COUPON_NOT_YOURS" });
    expect(evaluateCoupon(rule({ phoneE164: "+5591000000000" }), ctx({ identity: { customerId: null, phoneE164: "+5591999990000" } }))).toEqual({ ok: false, code: "COUPON_NOT_YOURS" });
  });

  it("sacola anônima: fica pendente", () => {
    const r = expectOk(evaluateCoupon(rule({ customerId: "cust-2" }), ctx({ identity: null, priorPurchases: null, priorRedemptionsByThisCustomer: null })));
    expect(r.pending).toEqual(["personal"]);
  });
});

describe("evaluateCoupon — primeira compra e limite por cliente", () => {
  it("primeira compra: 0 aceita, 1 recusa, desconhecido pendente", () => {
    expect(evaluateCoupon(rule({ firstPurchaseOnly: true }), ctx({ priorPurchases: 0 })).ok).toBe(true);
    expect(evaluateCoupon(rule({ firstPurchaseOnly: true }), ctx({ priorPurchases: 1 }))).toEqual({ ok: false, code: "COUPON_FIRST_PURCHASE_ONLY" });
    expect(expectOk(evaluateCoupon(rule({ firstPurchaseOnly: true }), ctx({ priorPurchases: null }))).pending).toEqual(["first_purchase"]);
  });

  it("limite por cliente: abaixo aceita, igual recusa, desconhecido pendente", () => {
    expect(evaluateCoupon(rule({ perCustomerLimit: 2 }), ctx({ priorRedemptionsByThisCustomer: 1 })).ok).toBe(true);
    expect(evaluateCoupon(rule({ perCustomerLimit: 1 }), ctx({ priorRedemptionsByThisCustomer: 1 }))).toEqual({ ok: false, code: "COUPON_CUSTOMER_LIMIT" });
    expect(expectOk(evaluateCoupon(rule({ perCustomerLimit: 1 }), ctx({ priorRedemptionsByThisCustomer: null }))).pending).toEqual(["customer_limit"]);
  });

  it("várias pendências acumulam na ordem das regras", () => {
    const r = expectOk(
      evaluateCoupon(
        rule({ customerId: "cust-9", firstPurchaseOnly: true, perCustomerLimit: 1, type: "free_shipping", value: 0, freeShippingScope: "motoboy" }),
        ctx({ identity: null, priorPurchases: null, priorRedemptionsByThisCustomer: null, shipping: null }),
      ),
    );
    expect(r.pending).toEqual(["personal", "first_purchase", "customer_limit", "shipping_scope"]);
  });
});

describe("evaluateCoupon — frete grátis com escopo", () => {
  it("escopo motoboy recusa Correios e vice-versa", () => {
    const motoboy = rule({ type: "free_shipping", value: 0, freeShippingScope: "motoboy" });
    expect(evaluateCoupon(motoboy, ctx({ shipping: { cents: 3200, kind: "correios" } }))).toEqual({ ok: false, code: "COUPON_SHIPPING_SCOPE" });
    expect(expectOk(evaluateCoupon(motoboy, ctx())).shippingDiscountCents).toBe(1500);
    const correios = rule({ type: "free_shipping", value: 0, freeShippingScope: "correios" });
    expect(evaluateCoupon(correios, ctx())).toEqual({ ok: false, code: "COUPON_SHIPPING_SCOPE" });
  });
});

describe("isWithinSchedule — relógio de São Paulo", () => {
  // Chuva das duas: 14:00–15:00 SP = 840..900.
  const chuva = { validWeekdays: null, validFromMinute: 840, validToMinute: 900 };

  it("13:59 não, 14:00 sim, 14:59 sim, 15:00 não", () => {
    expect(isWithinSchedule(chuva, new Date("2026-09-21T16:59:00.000Z")).hours).toBe(false);
    expect(isWithinSchedule(chuva, new Date("2026-09-21T17:00:00.000Z")).hours).toBe(true);
    expect(isWithinSchedule(chuva, new Date("2026-09-21T17:59:59.000Z")).hours).toBe(true);
    expect(isWithinSchedule(chuva, new Date("2026-09-21T18:00:00.000Z")).hours).toBe(false);
  });

  it("dia da semana no calendário de SP: 23h30 de sábado em SP ainda é sábado (02h30Z de domingo)", () => {
    const fimDeSemana = { validWeekdays: [6], validFromMinute: null, validToMinute: null };
    expect(isWithinSchedule(fimDeSemana, new Date("2026-09-20T02:30:00.000Z")).weekday).toBe(true); // sáb 19/09 23:30 SP
    expect(isWithinSchedule(fimDeSemana, new Date("2026-09-20T03:30:00.000Z")).weekday).toBe(false); // dom 20/09 00:30 SP
  });

  it("evaluateCoupon devolve os códigos da janela", () => {
    expect(evaluateCoupon(rule({ validWeekdays: [1, 2] }), ctx())).toEqual({ ok: false, code: "COUPON_WRONG_WEEKDAY" });
    expect(evaluateCoupon(rule({ validFromMinute: 840, validToMinute: 900 }), ctx())).toEqual({ ok: false, code: "COUPON_OUTSIDE_HOURS" });
    expect(evaluateCoupon(rule({ validWeekdays: [0, 6], validFromMinute: 900, validToMinute: 960 }), ctx()).ok).toBe(true);
  });
});

describe("evaluateCoupon — cupom que muda com o tempo", () => {
  it("usa o valor do dia (degraus desde a criação) e devolve appliedValue", () => {
    const stepped = rule({ value: 5, valueSchedule: [{ afterDays: 7, value: 10 }, { afterDays: 30, value: 15 }] });
    // NOW = 20/09; criado em 01/09 → dia 19 → 10%.
    const r = expectOk(evaluateCoupon(stepped, ctx({ items: [VESTIDO] })));
    expect(r.appliedValue).toBe(10);
    expect(r.discountCents).toBe(1990);
    const later = expectOk(evaluateCoupon(stepped, ctx({ items: [VESTIDO], now: new Date("2026-10-05T18:30:00.000Z") })));
    expect(later.appliedValue).toBe(15);
    // Fixo: os degraus são centavos e o clamp vale sobre o degrau.
    const fixed = rule({ type: "fixed", value: 1000, valueSchedule: [{ afterDays: 1, value: 999_999 }] });
    expect(expectOk(evaluateCoupon(fixed, ctx({ items: [VESTIDO] })))).toMatchObject({ appliedValue: 999_999, discountCents: 19900 });
  });
});

describe("evaluateCoupon — cupom da turma", () => {
  it("o valor sobe com as clientes distintas que já usaram, até o teto; sem contagem = ninguém ainda", () => {
    const turma = rule({ value: 5, growthPerRedeemer: 2, growthCap: 15 });
    expect(expectOk(evaluateCoupon(turma, ctx({ items: [VESTIDO], distinctRedeemers: 2 })))).toMatchObject({ appliedValue: 9, discountCents: 1791 });
    expect(expectOk(evaluateCoupon(turma, ctx({ items: [VESTIDO], distinctRedeemers: 40 }))).appliedValue).toBe(15);
    expect(expectOk(evaluateCoupon(turma, ctx({ items: [VESTIDO] }))).appliedValue).toBe(5);
  });
});
