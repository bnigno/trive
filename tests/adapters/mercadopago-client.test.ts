// Taxa real do Mercado Pago: fee_details manda; o atalho bruto − líquido só
// vale com o dinheiro JÁ liquidado. Num Pix pendente o MP devolve fee_details
// vazio e líquido zero — e o atalho ingênuo devolvia o valor cheio da
// transação como se fosse taxa (gravou R$ 33,99 de "taxa" num pedido de
// R$ 31,10 e jogou a margem do pedido para −R$ 17,00).
import { describe, expect, it } from "vitest";

import { extractFeeCents } from "@/adapters/mercadopago/client";

describe("extractFeeCents", () => {
  it("soma fee_details quando o MP já informa a taxa", () => {
    expect(
      extractFeeCents({
        id: "1",
        status: "approved",
        transaction_amount: 49.9,
        fee_details: [{ amount: 1.24 }, { amount: 0.75 }],
        transaction_details: { net_received_amount: 47.91 },
      }),
    ).toBe(199);
  });

  it("Pix PENDENTE não tem taxa: fee_details vazio e líquido zero → null", () => {
    // O formato exato que a API devolveu no pedido #1007.
    expect(
      extractFeeCents({
        id: "179442102177",
        status: "pending",
        transaction_amount: 33.99,
        fee_details: [],
        transaction_details: { net_received_amount: 0 },
      }),
    ).toBeNull();
  });

  it("liquidado sem fee_details: bruto − líquido", () => {
    expect(
      extractFeeCents({
        id: "2",
        status: "approved",
        transaction_amount: 100,
        fee_details: [],
        transaction_details: { net_received_amount: 95.1 },
      }),
    ).toBe(490);
  });

  it("sem transaction_details nenhum → null (taxa desconhecida)", () => {
    expect(
      extractFeeCents({ id: "3", status: "pending", transaction_amount: 10 }),
    ).toBeNull();
  });

  it("fee_details com amount nulo não vira taxa zero", () => {
    // Zero seria uma mentira mensurável: entraria no relatório como taxa 0.
    expect(
      extractFeeCents({
        id: "4",
        status: "approved",
        transaction_amount: 20,
        fee_details: [{ amount: null }],
        transaction_details: { net_received_amount: 0 },
      }),
    ).toBeNull();
  });
});
