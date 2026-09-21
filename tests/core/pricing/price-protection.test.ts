import { describe, expect, it } from "vitest";

import { effectiveUnitPriceCents, priceProtectionNote, priceProtectionRefundCents, protectionWindowStart } from "@/core/pricing/price-protection";

describe("proteção de preço", () => {
  it("o que ela pagou: preço de lista com o desconto do pedido rateado", () => {
    expect(effectiveUnitPriceCents({ unitPriceCents: 19900, subtotalCents: 19900, discountCents: 0 })).toBe(19900);
    expect(effectiveUnitPriceCents({ unitPriceCents: 19900, subtotalCents: 19900, discountCents: 1990 })).toBe(17910);
    // Duas peças, desconto de R$ 30 no pedido de R$ 300: cada uma "custou" 10% a menos.
    expect(effectiveUnitPriceCents({ unitPriceCents: 10000, subtotalCents: 30000, discountCents: 3000 })).toBe(9000);
    expect(effectiveUnitPriceCents({ unitPriceCents: 10000, subtotalCents: 0, discountCents: 3000 })).toBe(10000);
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
