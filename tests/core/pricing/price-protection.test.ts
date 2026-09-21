import { describe, expect, it } from "vitest";

import { isPriceDrop, priceProtectionNote, priceProtectionRefundCents, protectionWindowStart } from "@/core/pricing/price-protection";

describe("proteção de preço", () => {
  it("queda só quando há preço anterior maior", () => {
    expect(isPriceDrop({ priceCents: 17900, previousPriceCents: 19900 })).toBe(true);
    expect(isPriceDrop({ priceCents: 19900, previousPriceCents: 19900 })).toBe(false);
    expect(isPriceDrop({ priceCents: 21900, previousPriceCents: 19900 })).toBe(false);
    expect(isPriceDrop({ priceCents: 17900, previousPriceCents: null })).toBe(false);
  });

  it("janela e diferença × quantidade (nunca negativa)", () => {
    expect(protectionWindowStart(new Date("2026-09-21T15:00:00.000Z"), 14)).toEqual(new Date("2026-09-07T15:00:00.000Z"));
    expect(priceProtectionRefundCents({ unitPriceCents: 19900, quantity: 2, newPriceCents: 17900 })).toBe(4000);
    expect(priceProtectionRefundCents({ unitPriceCents: 17900, quantity: 1, newPriceCents: 19900 })).toBe(0);
    expect(priceProtectionRefundCents({ unitPriceCents: 19999, quantity: 3, newPriceCents: 19998 })).toBe(3);
  });

  it("nota interna", () => {
    expect(priceProtectionNote({ productName: "Longo Dunas", unitPriceCents: 19900, newPriceCents: 17900, orderNumber: 1042 })).toBe("Longo Dunas baixou de R$ 199,00 para R$ 179,00 (pedido #1042)");
  });
});
