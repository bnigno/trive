// "Refazer pedido" (core, puro): quem pode refazer, o plano do pedido novo
// (cupom mantido vale como na data do antigo, entrega mantida sem recotar,
// peso diferente pede entrega nova, janela vencida recusa, nada muda =
// recusa) e o resumo das mudanças para a cliente e a dona.
import { describe, expect, it } from "vitest";

import {
  buildRedoPlan,
  describeOrderChanges,
  isOverridableBlocker,
  paidCanceledOrderGuidance,
  redoBlockerMessage,
  redoBlockers,
  redoPaymentMethodOf,
  snapshotKeptShipping,
  type RedoEligibilityInput,
  type RedoSource,
} from "@/core/orders/redo";
import { friendlyCancelReason, SUPERSEDED_CANCEL_REASON } from "@/core/orders/reasons";

const ELIGIBLE: RedoEligibilityInput = {
  orderNumber: 1030,
  status: "pending_payment",
  channel: "whatsapp",
  packagePhotoPath: null,
  dispatchedAt: null,
  hasOpenDeliveryStop: false,
  mpPaymentId: null,
  reservationExpired: false,
  saleSettled: false,
  paymentMethod: null,
  replacedByOrderNumber: null,
};

const WINDOW = { dayKey: "2026-10-13", start: "14:00", end: "18:00", cutoff: "12:00", rateName: "Motoboy Belém", label: "amanhã, 14h–18h" };
const KEPT = snapshotKeptShipping(
  { shippingCents: 0, shippingService: null, shippingQuoteId: null, deliveryWindow: { ...WINDOW, dispatchedAt: "x" }, neededBy: null, occasion: null, shipBy: null },
  1000,
);
const VESTIDO = { variantId: "v-m", quantity: 1, expectedUnitPriceCents: 5998 };
const SOURCE: RedoSource = {
  couponCode: "SABRINA-HN5U7",
  paymentMethod: null,
  items: [VESTIDO],
  gift: null,
  createdAt: new Date("2026-10-02T10:22:00Z"),
  kept: KEPT,
  weightGrams: 300,
};
const CTX = { newWeightGrams: 300, todayKey: "2026-10-12", nowMinutes: 10 * 60 };

describe("redoBlockers", () => {
  it("pedido aguardando pagamento, do site ou da Lia, sem embalar nem sair: pode refazer", () => {
    expect(redoBlockers(ELIGIBLE)).toEqual([]);
    expect(redoBlockers({ ...ELIGIBLE, channel: "store" })).toEqual([]);
  });

  it("cada bloqueio, na ordem; só o pagamento em andamento a equipe passa por cima", () => {
    expect(redoBlockers({ ...ELIGIBLE, status: "canceled", replacedByOrderNumber: 1031 })).toEqual(["already_redone", "not_pending"]);
    expect(redoBlockers({ ...ELIGIBLE, status: "paid" })).toEqual(["not_pending"]);
    expect(redoBlockers({ ...ELIGIBLE, channel: "manual" })).toEqual(["manual_channel"]);
    expect(redoBlockers({ ...ELIGIBLE, packagePhotoPath: "p.jpg" })).toEqual(["packed"]);
    expect(redoBlockers({ ...ELIGIBLE, dispatchedAt: "2026-10-12T12:00:00Z" })).toEqual(["dispatched"]);
    expect(redoBlockers({ ...ELIGIBLE, hasOpenDeliveryStop: true })).toEqual(["in_route"]);
    expect(redoBlockers({ ...ELIGIBLE, mpPaymentId: "123" })).toEqual(["payment_attempt"]);
    expect(redoBlockers({ ...ELIGIBLE, paymentMethod: "pix_manual" })).toEqual(["pix_manual"]);
    expect(redoBlockers({ ...ELIGIBLE, reservationExpired: true })).toEqual(["reservation_expired"]);
    expect(redoBlockers({ ...ELIGIBLE, saleSettled: true })).toEqual(["money_received"]);
    expect(isOverridableBlocker("reservation_expired")).toBe(false);
    expect(isOverridableBlocker("money_received")).toBe(false);
    expect(isOverridableBlocker("payment_attempt")).toBe(true);
    expect(isOverridableBlocker("pix_manual")).toBe(true);
    expect(isOverridableBlocker("packed")).toBe(false);
  });

  it("as mensagens dizem o porquê e o caminho", () => {
    expect(redoBlockerMessage("already_redone", { orderNumber: 1030, replacedByOrderNumber: 1031 })).toBe("O pedido #1030 já foi refeito: agora ele é o #1031.");
    expect(redoBlockerMessage("payment_attempt", ELIGIBLE)).toContain("confira se ela já pagou");
    expect(redoBlockerMessage("manual_channel", ELIGIBLE)).toContain("venda manual nova");
    expect(redoBlockerMessage("pix_manual", ELIGIBLE)).toContain("confira no banco");
  });
});

describe("snapshotKeptShipping", () => {
  it("guarda o preço da opção ANTES do cupom e tira a saída do motoboy do pedido antigo", () => {
    expect(KEPT).toEqual({ kind: "motoboy", listPriceCents: 1000, service: null, quoteId: null, deliveryWindow: WINDOW, neededBy: null, occasion: null, shipBy: null });
    const correios = snapshotKeptShipping({ shippingCents: 3173, shippingService: "PAC", shippingQuoteId: "q1", deliveryWindow: null, neededBy: "2026-10-20", occasion: "aniversário", shipBy: "2026-10-14" }, 0);
    expect(correios).toMatchObject({ kind: "correios", listPriceCents: 3173, service: "PAC", quoteId: "q1", neededBy: "2026-10-20", shipBy: "2026-10-14" });
  });
});

describe("buildRedoPlan", () => {
  it("#1030: tirar o cupom — o resto fica como estava (entrega mantida, sem recotar)", () => {
    const result = buildRedoPlan(SOURCE, { coupon: { kind: "remove" } }, CTX);
    expect(result).toEqual({
      ok: true,
      plan: { couponCode: null, couponAsOf: null, paymentMethod: "online", items: [VESTIDO], gift: null, delivery: { kind: "keep", kept: KEPT } },
    });
  });

  it("#1020: passar para dinheiro na entrega; cupom mantido vale como na data do pedido antigo", () => {
    const result = buildRedoPlan(SOURCE, { paymentMethod: "cash" }, CTX);
    expect(result.ok && result.plan).toMatchObject({ paymentMethod: "cash", couponCode: "SABRINA-HN5U7", couponAsOf: SOURCE.createdAt });
  });

  it("outro cupom: vale com a data de hoje; trocar o tamanho com o mesmo peso mantém a entrega", () => {
    const g = { variantId: "v-g", quantity: 1, expectedUnitPriceCents: 5998 };
    const result = buildRedoPlan(SOURCE, { coupon: { kind: "code", code: " dez10 " }, items: [g] }, CTX);
    expect(result.ok && result.plan).toMatchObject({ couponCode: "DEZ10", couponAsOf: null, items: [g], delivery: { kind: "keep" } });
  });

  it("as mesmas peças com o preço de hoje (aceito pela cliente) entram com o preço novo", () => {
    const today = { ...VESTIDO, expectedUnitPriceCents: 6998 };
    const plan = buildRedoPlan(SOURCE, { paymentMethod: "cash", items: [today] }, CTX);
    expect(plan).toMatchObject({ ok: true, plan: { items: [today] } });
    // O resumo para ela diz o preço novo.
    expect(plan.ok && describeOrderChanges(SOURCE, plan.plan, (item) => `1× Vestido por ${item.expectedUnitPriceCents}`)).toEqual([
      "pagamento: dinheiro na entrega",
      "peças: 1× Vestido por 6998",
    ]);
    // Só o preço mudar não é motivo para refazer.
    expect(buildRedoPlan(SOURCE, { items: [today] }, CTX)).toMatchObject({ ok: false, code: "REDO_NO_CHANGES" });
  });

  it("peso diferente com a entrega mantida: pede escolher a entrega de novo; com a entrega escolhida, vale", () => {
    const two = { ...VESTIDO, quantity: 2 };
    expect(buildRedoPlan(SOURCE, { items: [two] }, { ...CTX, newWeightGrams: 600 })).toMatchObject({ ok: false, code: "REDO_SHIPPING_NEEDS_QUOTE" });
    const ship = { kind: "ship" as const, shippingRateId: "r1", expectedShippingCents: 1500, label: "Motoboy · amanhã 9h–12h" };
    expect(buildRedoPlan(SOURCE, { items: [two], delivery: ship }, { ...CTX, newWeightGrams: 600 })).toMatchObject({ ok: true, plan: { delivery: ship } });
  });

  it("janela do motoboy de um dia que já passou: recusa e pede horário novo", () => {
    expect(buildRedoPlan(SOURCE, { coupon: { kind: "remove" } }, { ...CTX, todayKey: "2026-10-14" })).toMatchObject({ ok: false, code: "REDO_WINDOW_PAST" });
    // O mesmo dia, antes da hora-limite, ainda vale: a entrega já estava combinada.
    const sameDay = { ...CTX, todayKey: "2026-10-13", nowMinutes: 11 * 60 };
    expect(buildRedoPlan(SOURCE, { coupon: { kind: "remove" } }, sameDay).ok).toBe(true);
    // Depois da hora-limite (12h): pagar pelo link não sai mais hoje; dinheiro na entrega ainda sai, até a janela acabar (18h).
    const afterCutoff = { ...sameDay, nowMinutes: 13 * 60 };
    expect(buildRedoPlan(SOURCE, { coupon: { kind: "remove" } }, afterCutoff)).toMatchObject({ ok: false, code: "REDO_WINDOW_PAST" });
    expect(buildRedoPlan(SOURCE, { paymentMethod: "cash" }, afterCutoff).ok).toBe(true);
    expect(buildRedoPlan(SOURCE, { paymentMethod: "cash" }, { ...sameDay, nowMinutes: 18 * 60 })).toMatchObject({ ok: false, code: "REDO_WINDOW_PAST" });
  });

  it("presente: mudar o bilhete, tirar ou virar presente; Pix manual conta como 'pelo link'", () => {
    const giftSource = { ...SOURCE, gift: { recipientName: "Ana", message: "Parabéns", deliverBy: null } };
    expect(buildRedoPlan(giftSource, { gift: { kind: "set", recipientName: "Ana", message: "Feliz aniversário" } }, CTX)).toMatchObject({
      ok: true,
      plan: { gift: { recipientName: "Ana", message: "Feliz aniversário", deliverBy: null } },
    });
    expect(buildRedoPlan(giftSource, { gift: { kind: "remove" } }, CTX)).toMatchObject({ ok: true, plan: { gift: null } });
    expect(redoPaymentMethodOf("pix_manual")).toBe("online");
    expect(redoPaymentMethodOf("cash")).toBe("cash");
  });

  it("nada muda (inclusive repetir o que já é): recusa — uma nova tentativa da Lia não duplica o pedido", () => {
    expect(buildRedoPlan(SOURCE, {}, CTX)).toMatchObject({ ok: false, code: "REDO_NO_CHANGES" });
    expect(buildRedoPlan(SOURCE, { coupon: { kind: "code", code: "sabrina-hn5u7" }, paymentMethod: "online", items: [VESTIDO] }, CTX)).toMatchObject({
      ok: false,
      code: "REDO_NO_CHANGES",
    });
  });
});

describe("describeOrderChanges e o motivo do cancelamento", () => {
  it("frases curtas do que mudou", () => {
    const label = () => "1× Vestido Amora (G)";
    const plan = buildRedoPlan(SOURCE, { coupon: { kind: "remove" }, paymentMethod: "cash", items: [{ variantId: "v-g", quantity: 1, expectedUnitPriceCents: 5998 }] }, CTX);
    expect(plan.ok && describeOrderChanges(SOURCE, plan.plan, label)).toEqual([
      "cupom SABRINA-HN5U7 retirado",
      "pagamento: dinheiro na entrega",
      "peças: 1× Vestido Amora (G)",
    ]);
    const ship = buildRedoPlan(SOURCE, { delivery: { kind: "ship", shippingRateId: "r", expectedShippingCents: 0, label: "Motoboy · sexta 9h–12h" } }, CTX);
    expect(ship.ok && describeOrderChanges(SOURCE, ship.plan, label)).toEqual(["entrega: Motoboy · sexta 9h–12h"]);
  });

  it("o pedido substituído não assusta a cliente: 'ganhou um número novo'", () => {
    expect(friendlyCancelReason(SUPERSEDED_CANCEL_REASON)).toBe("o pedido foi atualizado e ganhou um número novo");
  });
});

describe("paidCanceledOrderGuidance", () => {
  it("pagou o link antigo do pedido refeito: estorna e manda o link do novo; pagou os dois: estorna", () => {
    expect(paidCanceledOrderGuidance({ orderNumber: 1030, latest: { orderNumber: 1031, status: "pending_payment" } })).toBe(
      "Ele foi refeito e agora é o #1031, ainda aguardando pagamento: ela pagou o link antigo. Estorne este pagamento no Mercado Pago e mande a ela o link do #1031.",
    );
    expect(paidCanceledOrderGuidance({ orderNumber: 1030, latest: { orderNumber: 1031, status: "paid" } })).toContain("ela pagou duas vezes");
    expect(paidCanceledOrderGuidance({ orderNumber: 1030, latest: { orderNumber: 1031, status: "canceled" } })).toContain("também está cancelado");
  });

  it("reserva vencida (nunca refeito): venda manual ou estorno", () => {
    expect(paidCanceledOrderGuidance({ orderNumber: 1030, latest: null })).toContain("A reserva tinha vencido");
  });
});
