import { describe, expect, it } from "vitest";

import { buildOrderJourney, type OrderJourneyInput } from "@/core/orders/journey";

const T0 = new Date("2026-09-10T10:00:00Z");
const T1 = new Date("2026-09-10T11:00:00Z");
const T2 = new Date("2026-09-10T12:00:00Z");
const T3 = new Date("2026-09-10T13:00:00Z");
const T4 = new Date("2026-09-11T13:00:00Z");

function input(over: Partial<OrderJourneyInput>): OrderJourneyInput {
  return {
    status: "pending_payment",
    createdAt: T0,
    paidAt: null,
    packedAt: null,
    preparingAt: null,
    shippedAt: null,
    deliveredAt: null,
    ...over,
  };
}

describe("buildOrderJourney", () => {
  it("aguardando pagamento: recebido feito, pagamento atual, resto a seguir", () => {
    const steps = buildOrderJourney(input({}))!;
    expect(steps.map((step) => [step.key, step.state, step.label])).toEqual([
      ["received", "done", "Recebido"],
      ["paid", "current", "Pagamento"],
      ["packed", "upcoming", "Separação"],
      ["shipped", "upcoming", "Enviado"],
      ["delivered", "upcoming", "Entregue"],
    ]);
    expect(steps[0].at).toBe(T0);
    expect(steps[1].at).toBeNull();
  });

  it("pago sem separação: 'Pago' feito e 'Separação' atual, sem hora", () => {
    const steps = buildOrderJourney(input({ status: "paid", paidAt: T1 }))!;
    expect(steps[1]).toMatchObject({ label: "Pago", state: "done", at: T1 });
    expect(steps[2]).toMatchObject({ label: "Separação", state: "current", at: null });
  });

  it("em preparação sem foto usa a hora do histórico; com foto vira 'Embalado' com a hora da foto", () => {
    const semFoto = buildOrderJourney(
      input({ status: "preparing", paidAt: T1, preparingAt: T2 }),
    )!;
    expect(semFoto[2]).toMatchObject({ label: "Em preparação", state: "current", at: T2 });

    const comFoto = buildOrderJourney(
      input({ status: "preparing", paidAt: T1, preparingAt: T2, packedAt: T3 }),
    )!;
    expect(comFoto[2]).toMatchObject({ label: "Embalado", state: "current", at: T3 });
  });

  it("enviado: passos anteriores feitos; entregue direto de pago deixa o meio sem hora", () => {
    const enviado = buildOrderJourney(
      input({ status: "shipped", paidAt: T1, preparingAt: T2, packedAt: T3, shippedAt: T4 }),
    )!;
    expect(enviado.map((step) => step.state)).toEqual(["done", "done", "done", "current", "upcoming"]);
    expect(enviado[2].label).toBe("Embalado");
    expect(enviado[3].at).toBe(T4);

    const direto = buildOrderJourney(
      input({ status: "delivered", paidAt: T1, deliveredAt: T4 }),
    )!;
    expect(direto.map((step) => step.state)).toEqual(["done", "done", "done", "done", "done"]);
    expect(direto[2]).toMatchObject({ label: "Separado", at: null });
    expect(direto[3].at).toBeNull();
    expect(direto[4].at).toBe(T4);
  });

  it("cancelado e reembolsado não têm linha do tempo", () => {
    expect(buildOrderJourney(input({ status: "canceled" }))).toBeNull();
    expect(buildOrderJourney(input({ status: "refunded" }))).toBeNull();
  });
});
