// O valor justo da peça que volta.
//
// O caso que originou a regra: pedido #1009, R$ 184,96 de subtotal com o cupom
// LIVETV10 (10%, R$ 18,49). A cliente devolveu os ÓCULOS de R$ 54,99 — mas ela
// pagou R$ 49,49 por eles. Devolver a etiqueta seria dar R$ 5,50 de presente.
import { describe, expect, it } from "vitest";

import { fairReturnValue, itemDiscountShares, type ReturnableItem } from "@/core/orders/item-returns";

/** Os quatro itens do pedido #1009, com os valores reais. */
const PEDIDO_1009: ReturnableItem[] = [
  { id: "oculos", totalCents: 5499, quantity: 1 },
  { id: "cropped", totalCents: 4999, quantity: 1 },
  { id: "blusa", totalCents: 4999, quantity: 1 },
  { id: "baby-look", totalCents: 2999, quantity: 1 },
];
const DESCONTO_1009 = 1849;

describe("valor justo da devolução", () => {
  it("desconta do item a parte do cupom que coube a ele (caso #1009)", () => {
    const { refundCents, needsReview } = fairReturnValue(
      { items: PEDIDO_1009, discountCents: DESCONTO_1009 },
      { itemId: "oculos", quantity: 1 },
    );
    // R$ 54,99 de etiqueta − R$ 5,49 de cupom = R$ 49,50.
    expect(refundCents).toBe(4950);
    expect(needsReview).toBe(false);
  });

  it("o arredondamento é sempre a favor da cliente, nunca contra", () => {
    const shares = itemDiscountShares(PEDIDO_1009, DESCONTO_1009);
    // Cada parte é no máximo a proporcional exata: ela nunca paga desconto a mais.
    const subtotal = PEDIDO_1009.reduce((sum, item) => sum + item.totalCents, 0);
    shares.forEach((share, i) => {
      expect(share).toBeLessThanOrEqual((DESCONTO_1009 * PEDIDO_1009[i]!.totalCents) / subtotal);
    });
    // E a sobra que a loja absorve é de centavos, não de reais.
    expect(DESCONTO_1009 - shares.reduce((a, b) => a + b, 0)).toBeLessThan(PEDIDO_1009.length);
  });

  it("nenhum item é penalizado por estar no fim da lista", () => {
    const valor = (itens: typeof PEDIDO_1009, id: string) =>
      fairReturnValue({ items: itens, discountCents: DESCONTO_1009 }, { itemId: id, quantity: 1 }).refundCents;
    // A mesma peça vale o mesmo, esteja ela em que posição estiver.
    const invertido = [...PEDIDO_1009].reverse();
    for (const item of PEDIDO_1009) {
      expect(valor(PEDIDO_1009, item.id)).toBe(valor(invertido, item.id));
    }
  });

  it("sem cupom, devolve o preço cheio", () => {
    const { refundCents } = fairReturnValue(
      { items: PEDIDO_1009, discountCents: 0 },
      { itemId: "oculos", quantity: 1 },
    );
    expect(refundCents).toBe(5499);
  });

  it("linha com 2 unidades: devolver as duas soma a linha inteira", () => {
    const items: ReturnableItem[] = [
      { id: "par", totalCents: 9999, quantity: 2 },
      { id: "outra", totalCents: 5000, quantity: 1 },
    ];
    const uma = fairReturnValue({ items, discountCents: 999 }, { itemId: "par", quantity: 1 }).refundCents;
    const duas = fairReturnValue({ items, discountCents: 999 }, { itemId: "par", quantity: 2 }).refundCents;
    const shareDaLinha = itemDiscountShares(items, 999)[0]!;
    expect(duas).toBe(9999 - shareDaLinha);
    expect(uma).toBeLessThan(duas);
    expect(uma * 2).toBeGreaterThanOrEqual(duas);
  });

  it("cupom com escopo de item marca o valor como sugestão", () => {
    const { needsReview } = fairReturnValue(
      { items: PEDIDO_1009, discountCents: DESCONTO_1009, couponHadItemScope: true },
      { itemId: "oculos", quantity: 1 },
    );
    expect(needsReview).toBe(true);
  });

  it("recusa item de outro pedido e quantidade impossível", () => {
    expect(() => fairReturnValue({ items: PEDIDO_1009, discountCents: 0 }, { itemId: "nao-existe", quantity: 1 })).toThrow();
    expect(() => fairReturnValue({ items: PEDIDO_1009, discountCents: 0 }, { itemId: "oculos", quantity: 2 })).toThrow(RangeError);
    expect(() => fairReturnValue({ items: PEDIDO_1009, discountCents: 0 }, { itemId: "oculos", quantity: 0 })).toThrow(RangeError);
  });
});
