// Que mensagem cada marco do pedido manda: a confirmação de sempre, o
// dinheiro na entrega, o "saiu" do motoboy e — novo — o pedido refeito, que
// troca a confirmação por "seu pedido foi atualizado" (e a dona recebe o que mudou).
import { describe, expect, it } from "vitest";

import { orderWaPlan } from "@/core/whatsapp/order-milestones";

const BASE = { paymentMethod: null, hasDeliveryWindow: false, replacesOrder: false };

describe("orderWaPlan", () => {
  it("pedido novo: confirmação (online ou dinheiro) e aviso de pedido novo à dona", () => {
    expect(orderWaPlan({ ...BASE, milestone: "store_created" })).toEqual({
      client: { template: "order_confirmed", dedupePrefix: "wa.order_confirmed:" },
      owner: { template: "owner_new_order", dedupePrefix: "wa.owner_new:" },
    });
    expect(orderWaPlan({ ...BASE, milestone: "store_created", paymentMethod: "cash" }).client).toEqual({
      template: "order_confirmed_cash",
      dedupePrefix: "wa.order_confirmed:",
    });
  });

  it("pedido refeito: 'seu pedido foi atualizado' no lugar da confirmação; a dona recebe o pedido refeito, não um pedido novo", () => {
    expect(orderWaPlan({ ...BASE, milestone: "store_created", replacesOrder: true })).toEqual({
      client: { template: "order_updated", dedupePrefix: "wa.order_updated:" },
      owner: { template: "owner_order_updated", dedupePrefix: "wa.owner_updated:" },
    });
    expect(orderWaPlan({ ...BASE, milestone: "store_created", replacesOrder: true, paymentMethod: "cash" }).client?.template).toBe("order_updated_cash");
    // Os marcos seguintes do pedido refeito são os de sempre.
    expect(orderWaPlan({ ...BASE, milestone: "paid", replacesOrder: true }).client?.template).toBe("payment_approved");
  });

  it("dinheiro na entrega pago: só a dona; motoboy 'enviado' vira o 'saiu' com a mesma chave do despacho", () => {
    expect(orderWaPlan({ ...BASE, milestone: "paid", paymentMethod: "cash" })).toEqual({
      client: null,
      owner: { template: "owner_payment_approved", dedupePrefix: "wa.owner_paid:" },
    });
    expect(orderWaPlan({ ...BASE, milestone: "shipped", hasDeliveryWindow: true })).toEqual({
      client: { template: "order_out_for_delivery", dedupePrefix: "wa.order_out_for_delivery:" },
      owner: null,
    });
    expect(orderWaPlan({ ...BASE, milestone: "shipped" }).client).toEqual({ template: "order_shipped", dedupePrefix: "wa.order_shipped:" });
  });
});
