// Uma peça volta sem o pedido inteiro cair.
//
// O caso real: pedido #1009 com cupom de 10%, a cliente devolveu só os óculos.
// Aqui ficam as promessas que não podem quebrar: o valor é o que ela pagou
// (não a etiqueta), só a peça devolvida volta ao estoque, o pedido não muda de
// status, e DUAS devoluções no mesmo pedido geram DOIS estornos — era isso que
// a chave de idempotência por pagamento descartava em silêncio.
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakePaymentGateway } from "@/adapters/mercadopago/fake";
import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { processPaymentEvent } from "@/services/payments";
import { refundReturnedItem, returnOrderItem, ReturnError } from "@/services/order-returns";
import { createStoreOrder } from "@/services/store-orders";
import { createTestDb, createTestFeeRuleAndPolicy, createTestVariant, FIXED_USER_ID, type TestDb } from "../helpers/db";

let db: TestDb;
let close: () => Promise<void>;
let sdb: DbOrTx;
let gateway: FakePaymentGateway;

const VALID_CPF = "529.982.247-25";

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  sdb = db as unknown as DbOrTx;
  gateway = new FakePaymentGateway();
  await createTestFeeRuleAndPolicy(db);
});
afterEach(async () => {
  await close();
});

/** Pedido pago com DUAS peças distintas, para testar devolução de uma só. */
async function createPaidOrderComDuasPecas() {
  const a = await createTestVariant(db, { sku: `OCULOS-${Math.random().toString(36).slice(2, 6)}`, costCents: 1000, onHand: 5, name: "Óculos Marcela" });
  const b = await createTestVariant(db, { sku: `BLUSA-${Math.random().toString(36).slice(2, 6)}`, costCents: 2000, onHand: 5, name: "Blusa Stella" });
  for (const [variantId, price] of [[a.variantId, 5499], [b.variantId, 4999]] as const) {
    await db.insert(schema.priceVersions).values({
      productVariantId: variantId, versionNumber: 1, status: "active", priceCents: price,
      origin: "initial", breakdown: {}, costSnapshotCents: 1000, computedMarginRate: "0.3000", activatedAt: new Date(),
    });
  }
  const [rate] = await db.insert(schema.shippingRates).values({ name: "Motoboy", priceCents: 500 }).returning({ id: schema.shippingRates.id });
  const order = await createStoreOrder(sdb, {
    customer: { fullName: "Sabrina Rodrigues", document: VALID_CPF, phone: "(91) 99999-8888", email: "sabrina@example.com", marketingOptIn: true },
    address: { postalCode: "66000-000", street: "Av. Nazaré", number: "100", district: "Nazaré", city: "Belém", state: "PA" },
    items: [
      { variantId: a.variantId, quantity: 1, expectedUnitPriceCents: 5499 },
      { variantId: b.variantId, quantity: 1, expectedUnitPriceCents: 4999 },
    ],
    shippingRateId: rate!.id,
    expectedShippingCents: 500,
  });
  const pref = await gateway.createCheckoutPreference({
    orderId: order.orderId, orderNumber: order.orderNumber, externalReference: order.orderId,
    items: [{ title: "Pedido", quantity: 1, unitPriceCents: order.totalCents }],
    backUrl: "https://trivemaison.com.br/pedido/token",
  });
  const mpPaymentId = gateway.paymentIdForPreference(pref.preferenceId);
  gateway.approvePayment(mpPaymentId, { paymentMethod: "credit_card" });
  await processPaymentEvent(sdb, gateway, { mpPaymentId });

  const itens = await db.select().from(schema.orderItems).where(eq(schema.orderItems.orderId, order.orderId));
  return { ...order, mpPaymentId, oculos: itens.find((i) => i.nameSnapshot.includes("Óculos"))!, blusa: itens.find((i) => i.nameSnapshot.includes("Blusa"))!, variantA: a.variantId, variantB: b.variantId };
}

async function estoque(variantId: string) {
  const [row] = await db.select({ onHand: schema.stockLevels.onHand }).from(schema.stockLevels).where(eq(schema.stockLevels.productVariantId, variantId));
  return row!.onHand;
}
async function statusDoPedido(orderId: string) {
  const [row] = await db.select({ status: schema.orders.status }).from(schema.orders).where(eq(schema.orders.id, orderId));
  return row!.status;
}

describe("devolução de item", () => {
  it("devolve só a peça escolhida ao estoque e NÃO mexe no status do pedido", async () => {
    const o = await createPaidOrderComDuasPecas();
    const antesA = await estoque(o.variantA);
    const antesB = await estoque(o.variantB);

    await returnOrderItem(sdb, { orderId: o.orderId, orderItemId: o.oculos.id, quantity: 1, resolution: "credito", userId: FIXED_USER_ID });

    expect(await estoque(o.variantA)).toBe(antesA + 1);
    expect(await estoque(o.variantB)).toBe(antesB); // a outra peça não se move
    expect(await statusDoPedido(o.orderId)).toBe("paid"); // não virou 'refunded'
  });

  it("o crédito vira cupom pessoal de uso único pelo valor que ela pagou", async () => {
    const o = await createPaidOrderComDuasPecas();
    const r = await returnOrderItem(sdb, { orderId: o.orderId, orderItemId: o.oculos.id, quantity: 1, resolution: "credito", userId: FIXED_USER_ID });

    expect(r.couponCode).toBeTruthy();
    const [cupom] = await db.select().from(schema.coupons).where(eq(schema.coupons.code, r.couponCode!));
    expect(cupom).toMatchObject({ type: "fixed", origin: "troca", maxUses: 1, isActive: true });
    expect(cupom!.value).toBe(r.refundCents);
    expect(gateway.refundCalls).toHaveLength(0); // crédito não move dinheiro
  });

  it("o dinheiro é estorno PARCIAL, com o valor da peça", async () => {
    const o = await createPaidOrderComDuasPecas();
    const r = await returnOrderItem(sdb, { orderId: o.orderId, orderItemId: o.oculos.id, quantity: 1, resolution: "dinheiro", userId: FIXED_USER_ID });

    const outcome = await refundReturnedItem(sdb, gateway, { returnId: r.returnId });
    expect(outcome).toMatchObject({ action: "estornado" });
    expect(gateway.refundCalls).toEqual([{ paymentId: o.mpPaymentId, amountCents: r.refundCents }]);
    expect(r.refundCents).toBe(5499); // sem cupom neste pedido: preço cheio
  });

  it("DUAS peças devolvidas geram DOIS estornos (a chave por pagamento engolia o segundo)", async () => {
    const o = await createPaidOrderComDuasPecas();
    const r1 = await returnOrderItem(sdb, { orderId: o.orderId, orderItemId: o.oculos.id, quantity: 1, resolution: "dinheiro", userId: FIXED_USER_ID });
    const r2 = await returnOrderItem(sdb, { orderId: o.orderId, orderItemId: o.blusa.id, quantity: 1, resolution: "dinheiro", userId: FIXED_USER_ID });

    await refundReturnedItem(sdb, gateway, { returnId: r1.returnId });
    await refundReturnedItem(sdb, gateway, { returnId: r2.returnId });

    expect(gateway.refundCalls).toHaveLength(2);
    expect(gateway.refundCalls.map((c) => c.amountCents)).toEqual([r1.refundCents, r2.refundCents]);
  });

  it("repetir a mesma devolução não estorna de novo", async () => {
    const o = await createPaidOrderComDuasPecas();
    const r = await returnOrderItem(sdb, { orderId: o.orderId, orderItemId: o.oculos.id, quantity: 1, resolution: "dinheiro", userId: FIXED_USER_ID });

    await refundReturnedItem(sdb, gateway, { returnId: r.returnId });
    const again = await refundReturnedItem(sdb, gateway, { returnId: r.returnId });

    expect(again).toEqual({ action: "ja_estornado" });
    expect(gateway.refundCalls).toHaveLength(1);
  });

  it("não deixa devolver mais peças do que o pedido tem", async () => {
    const o = await createPaidOrderComDuasPecas();
    await returnOrderItem(sdb, { orderId: o.orderId, orderItemId: o.oculos.id, quantity: 1, resolution: "credito", userId: FIXED_USER_ID });
    await expect(
      returnOrderItem(sdb, { orderId: o.orderId, orderItemId: o.oculos.id, quantity: 1, resolution: "credito", userId: FIXED_USER_ID }),
    ).rejects.toBeInstanceOf(ReturnError);
  });

  it("o dono pode ajustar o valor (dinheiro de cliente é decisão dele)", async () => {
    const o = await createPaidOrderComDuasPecas();
    const r = await returnOrderItem(sdb, { orderId: o.orderId, orderItemId: o.oculos.id, quantity: 1, resolution: "credito", refundCents: 5000, userId: FIXED_USER_ID });
    expect(r.refundCents).toBe(5000);
  });
});
