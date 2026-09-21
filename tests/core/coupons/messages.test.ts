import { describe, expect, it } from "vitest";

import type { CouponErrorCode } from "@/core/coupons/evaluate";
import { couponErrorMessage, pendingNotice, scheduleLabel } from "@/core/coupons/messages";
import { formatCentsBRL } from "@/lib/money";

const base = {
  code: "CHUVA",
  minOrderCents: 15_000,
  freeShippingScope: "any" as const,
  validWeekdays: [0, 6],
  validFromMinute: 840,
  validToMinute: 900,
};

const ALL_CODES: CouponErrorCode[] = [
  "COUPON_NOT_FOUND",
  "COUPON_INACTIVE",
  "COUPON_NOT_STARTED",
  "COUPON_EXPIRED",
  "COUPON_EXHAUSTED",
  "COUPON_WRONG_WEEKDAY",
  "COUPON_OUTSIDE_HOURS",
  "COUPON_NOT_YOURS",
  "COUPON_FIRST_PURCHASE_ONLY",
  "COUPON_CUSTOMER_LIMIT",
  "COUPON_MIN_ORDER",
  "COUPON_NO_ELIGIBLE_ITEMS",
  "COUPON_SHIPPING_SCOPE",
];

describe("couponErrorMessage", () => {
  it("todo código tem frase em português", () => {
    for (const code of ALL_CODES) {
      const message = couponErrorMessage(code, base);
      expect(message.length).toBeGreaterThan(10);
      expect(message).not.toMatch(/COUPON_/);
    }
  });

  it("mínimo formatado em reais e janela com horário", () => {
    expect(couponErrorMessage("COUPON_MIN_ORDER", base)).toBe(`Este cupom vale para pedidos a partir de ${formatCentsBRL(15_000)}.`);
    expect(couponErrorMessage("COUPON_OUTSIDE_HOURS", base)).toBe("Este cupom vale só das 14h–15h.");
    expect(couponErrorMessage("COUPON_WRONG_WEEKDAY", base)).toBe("Este cupom vale só em alguns dias da semana (dom·sáb).");
  });

  it("escopo do frete grátis muda a frase", () => {
    expect(couponErrorMessage("COUPON_SHIPPING_SCOPE", { ...base, freeShippingScope: "motoboy" })).toMatch(/motoboy/);
    expect(couponErrorMessage("COUPON_SHIPPING_SCOPE", { ...base, freeShippingScope: "correios" })).toMatch(/Correios/);
  });
});

describe("scheduleLabel", () => {
  it("compõe dias e horário; nada quando o cupom vale sempre", () => {
    expect(scheduleLabel(base)).toBe("dom·sáb 14h–15h");
    expect(scheduleLabel({ validWeekdays: [5], validFromMinute: 1110, validToMinute: 1320 })).toBe("sex 18h30–22h");
    expect(scheduleLabel({ validWeekdays: null, validFromMinute: null, validToMinute: null })).toBeNull();
  });
});

describe("pendingNotice", () => {
  it("uma, duas e nenhuma pendência", () => {
    expect(pendingNotice([])).toBeNull();
    expect(pendingNotice(["first_purchase"])).toBe("Confirmamos no fechamento que esta é a sua primeira compra.");
    expect(pendingNotice(["personal", "customer_limit"])).toBe(
      "Confirmamos no fechamento que este cupom é seu e que você ainda não usou este cupom.",
    );
    expect(pendingNotice(["personal", "first_purchase", "shipping_scope"])).toBe(
      "Confirmamos no fechamento que este cupom é seu, que esta é a sua primeira compra e o frete grátis ao escolher a entrega.",
    );
  });
});
