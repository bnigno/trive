import { describe, expect, it } from "vitest";

import {
  decideLiaGift,
  LIA_GIFT_DEFAULTS,
  liaGiftCode,
  liaGiftDedupeKey,
  liaGiftExpiresAt,
  liaGiftRefusalText,
  liaGiftToolText,
  type LiaGiftFacts,
  type LiaGiftPolicy,
  type LiaGiftRefusal,
} from "@/core/coupons/lia-gift";
import { formatCentsBRL } from "@/lib/money";

const sp = (iso: string) => new Date(`${iso}-03:00`);
const NOW = sp("2026-09-21T15:00:00");
const policy: LiaGiftPolicy = { ...LIA_GIFT_DEFAULTS, enabled: true };

function facts(over: Partial<LiaGiftFacts> = {}): LiaGiftFacts {
  return {
    now: NOW,
    customerId: "cust-1",
    priorPurchases: 2,
    cartSubtotalCents: 28_900,
    issuedTodayCount: 0,
    lastGiftAt: null,
    alreadyOfferedInConversation: false,
    hasValidatedCoupon: false,
    copilot: false,
    proactive: false,
    ...over,
  };
}

describe("decideLiaGift", () => {
  it("com tudo em ordem: sim, com o % da política e validade até o fim do dia", () => {
    expect(decideLiaGift(policy, facts())).toEqual({ ok: true, percent: 10, expiresAt: sp("2026-09-23T23:59:59") });
  });

  const cases: [LiaGiftRefusal, Partial<LiaGiftPolicy>, Partial<LiaGiftFacts>][] = [
    ["disabled", { enabled: false }, {}],
    ["proactive", {}, { proactive: true }],
    ["copilot", {}, { copilot: true }],
    ["unidentified", {}, { customerId: null }],
    ["already_offered", {}, { alreadyOfferedInConversation: true }],
    ["has_coupon", {}, { hasValidatedCoupon: true }],
    ["empty_cart", {}, { cartSubtotalCents: 0 }],
    ["cart_too_small", {}, { cartSubtotalCents: 14_999 }],
    ["few_purchases", {}, { priorPurchases: 0 }],
    ["cooldown", {}, { lastGiftAt: sp("2026-09-01T10:00:00") }],
    ["quota", {}, { issuedTodayCount: 3 }],
  ];
  it.each(cases)("recusa %s", (code, policyOver, factsOver) => {
    const decision = decideLiaGift({ ...policy, ...policyOver }, facts(factsOver));
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.code).toBe(code);
  });

  it("cooldown 0 nunca recusa por tempo; cota 0 sempre recusa; mínimo de compras 0 aceita quem nunca comprou", () => {
    expect(decideLiaGift({ ...policy, cooldownDays: 0 }, facts({ lastGiftAt: sp("2026-09-21T10:00:00") })).ok).toBe(true);
    expect(decideLiaGift({ ...policy, dailyQuota: 0 }, facts())).toMatchObject({ ok: false, code: "quota" });
    expect(decideLiaGift({ ...policy, minPurchases: 0 }, facts({ priorPurchases: 0 })).ok).toBe(true);
    // 60 dias exatos já liberam.
    expect(decideLiaGift(policy, facts({ lastGiftAt: sp("2026-07-23T15:00:00") })).ok).toBe(true);
  });
});

describe("validade, código, dedupe e textos", () => {
  it("expira no fim do dia de SP de now + N dias", () => {
    expect(liaGiftExpiresAt(sp("2026-09-21T23:50:00"), 2)).toEqual(sp("2026-09-23T23:59:59"));
  });

  it("código com o primeiro nome; sem nome, CARINHO-<sufixo>", () => {
    expect(liaGiftCode("María José da Silva", "abcd1234")).toBe("MARIA-CARINHO");
    expect(liaGiftCode(null, "abcd1234")).toBe("CARINHO-ABCD");
    expect(liaGiftCode("🌸", "")).toBe("CARINHO-LIA");
    expect(liaGiftDedupeKey("conv-1", "2026-09-21")).toBe("lia_gift:conv-1:2026-09-21");
  });

  it("texto de sucesso e de recusa", () => {
    const text = liaGiftToolText({ code: "MARIA-CARINHO", percent: 10, discountCents: 2890, subtotalCents: 28_900, expiresAt: sp("2026-09-23T23:59:59"), motivo: "hesitou no preço do Longo Dunas" });
    expect(text).toContain(`cupom MARIA-CARINHO — 10% na sacola atual (desconto de ${formatCentsBRL(2890)} sobre ${formatCentsBRL(28_900)} → ${formatCentsBRL(26_010)}, frete à parte), vale até 23/09.`);
    expect(text).toContain('ligada ao motivo ("hesitou no preço do Longo Dunas")');
    expect(text).toContain('Passe cupom: "MARIA-CARINHO" em criar_pedido');
    expect(liaGiftRefusalText({ code: "quota", reason: "cota do dia esgotada" })).toBe("Sem gentileza agora (cota do dia esgotada). NÃO mencione desconto, cupom nem que tentou — siga a conversa normalmente.");
  });
});
