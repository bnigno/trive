// O estorno que devolve dinheiro de verdade.
//
// Nasceu de um caso real: o pedido #1004 ficou 'refunded', a cliente recebeu
// "reembolso confirmado" e os R$ 54,99 continuaram no Mercado Pago. Os testes
// aqui guardam as duas promessas que consertam isso: o dinheiro sai UMA vez
// só, e a cliente só é avisada depois que ele saiu.
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakePaymentGateway } from "@/adapters/mercadopago/fake";
import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { transitionOrder } from "@/services/orders";
import { processPaymentEvent, refundOrderPayment } from "@/services/payments";
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

/** Pedido da loja pago pelo Mercado Pago, pronto para ser reembolsado. */
async function createPaidMpOrder() {
  const { variantId } = await createTestVariant(db, {
    sku: `CANECA-${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
    costCents: 1200,
    onHand: 10,
    name: "Caneca Azul",
  });
  await db.insert(schema.priceVersions).values({
    productVariantId: variantId,
    versionNumber: 1,
    status: "active",
    priceCents: 4990,
    origin: "initial",
    breakdown: {},
    costSnapshotCents: 1000,
    computedMarginRate: "0.3000",
    activatedAt: new Date(),
  });
  const [rate] = await db
    .insert(schema.shippingRates)
    .values({ name: "PAC", priceCents: 1990 })
    .returning({ id: schema.shippingRates.id });

  const order = await createStoreOrder(sdb, {
    customer: { fullName: "Maria da Silva", document: VALID_CPF, phone: "(11) 99999-8888", email: "maria@example.com", marketingOptIn: true },
    address: { postalCode: "01310-100", street: "Avenida Paulista", number: "1000", district: "Bela Vista", city: "São Paulo", state: "SP" },
    items: [{ variantId, quantity: 1, expectedUnitPriceCents: 4990 }],
    shippingRateId: rate!.id,
    expectedShippingCents: 1990,
  });

  const pref = await gateway.createCheckoutPreference({
    orderId: order.orderId,
    orderNumber: order.orderNumber,
    externalReference: order.orderId,
    items: [{ title: "Pedido", quantity: 1, unitPriceCents: order.totalCents }],
    backUrl: "https://trivemaison.com.br/pedido/token",
  });
  const mpPaymentId = gateway.paymentIdForPreference(pref.preferenceId);
  gateway.approvePayment(mpPaymentId, { paymentMethod: "pix" });
  await processPaymentEvent(sdb, gateway, { mpPaymentId });
  return { ...order, mpPaymentId };
}

async function orderRow(orderId: string) {
  const [row] = await db
    .select({ status: schema.orders.status, refundState: schema.orders.refundState, refundedAt: schema.orders.refundedAt, mpRefundId: schema.orders.mpRefundId })
    .from(schema.orders)
    .where(eq(schema.orders.id, orderId));
  return row!;
}

async function outboxTypes(orderId: string) {
  const rows = await db
    .select({ eventType: schema.outboxEvents.eventType })
    .from(schema.outboxEvents)
    .where(eq(schema.outboxEvents.aggregateId, orderId));
  return rows.map((r) => r.eventType);
}

describe("estorno no Mercado Pago", () => {
  it("devolve o dinheiro, carimba o pedido e liquida o financeiro", async () => {
    const order = await createPaidMpOrder();
    await transitionOrder(sdb, { orderId: order.orderId, to: "refunded", userId: FIXED_USER_ID });

    // Ainda não saiu: o pedido nasce 'pendente' e a fila é quem chama o vendor.
    expect((await orderRow(order.orderId)).refundState).toBe("pendente");
    expect(await outboxTypes(order.orderId)).toContain("payment.refund");

    const outcome = await refundOrderPayment(sdb, gateway, { orderId: order.orderId });
    expect(outcome).toMatchObject({ action: "estornado" });
    expect(gateway.refundCalls).toHaveLength(1);

    const row = await orderRow(order.orderId);
    expect(row.refundState).toBe("devolvido");
    expect(row.refundedAt).not.toBeNull();
    expect(row.mpRefundId).toMatch(/^fake-refund-/);

    // A saída "Reembolso do pedido #N" não fica pendente esperando a mão do dono.
    const [refundEntry] = await db
      .select({ status: schema.financialEntries.status })
      .from(schema.financialEntries)
      .where(and(eq(schema.financialEntries.orderId, order.orderId), eq(schema.financialEntries.category, "refund")));
    expect(refundEntry?.status).toBe("settled");

    // O MP devolve a taxa no estorno total: ela não pode seguir a pagar.
    const [feeEntry] = await db
      .select({ status: schema.financialEntries.status })
      .from(schema.financialEntries)
      .where(and(eq(schema.financialEntries.orderId, order.orderId), eq(schema.financialEntries.category, "mp_fee")));
    if (feeEntry) expect(feeEntry.status).toBe("canceled");
  });

  it("rodar de novo NÃO estorna em dobro", async () => {
    const order = await createPaidMpOrder();
    await transitionOrder(sdb, { orderId: order.orderId, to: "refunded", userId: FIXED_USER_ID });

    await refundOrderPayment(sdb, gateway, { orderId: order.orderId });
    const again = await refundOrderPayment(sdb, gateway, { orderId: order.orderId });

    expect(again).toEqual({ action: "ja_estornado" });
    expect(gateway.refundCalls).toHaveLength(1);
  });

  it("pagamento já estornado por fora não é estornado outra vez", async () => {
    const order = await createPaidMpOrder();
    await transitionOrder(sdb, { orderId: order.orderId, to: "refunded", userId: FIXED_USER_ID });
    // O dono estornou pelo painel do MP entre o clique e a fila.
    await gateway.refundPayment(order.mpPaymentId);
    gateway.refundCalls.length = 0;

    const outcome = await refundOrderPayment(sdb, gateway, { orderId: order.orderId });

    expect(outcome).toEqual({ action: "ja_estornado" });
    expect(gateway.refundCalls).toHaveLength(0);
    expect((await orderRow(order.orderId)).refundState).toBe("devolvido");
  });

  it("transição vinda do webhook não pede estorno (o MP já estornou)", async () => {
    const order = await createPaidMpOrder();
    // userId null = quem transicionou foi o serviço de pagamentos, pelo webhook.
    await transitionOrder(sdb, { orderId: order.orderId, to: "refunded", userId: null });

    expect(await outboxTypes(order.orderId)).not.toContain("payment.refund");
  });

  it("Pix manual não chama o vendor e fica marcado como devolução por fora", async () => {
    const order = await createPaidMpOrder();
    await db.update(schema.orders).set({ paymentMethod: "pix_manual", mpPaymentId: null }).where(eq(schema.orders.id, order.orderId));
    await transitionOrder(sdb, { orderId: order.orderId, to: "refunded", userId: FIXED_USER_ID });

    expect(await outboxTypes(order.orderId)).not.toContain("payment.refund");
    const outcome = await refundOrderPayment(sdb, gateway, { orderId: order.orderId });
    expect(outcome).toEqual({ action: "nao_aplicavel" });
    expect(gateway.refundCalls).toHaveLength(0);
    expect((await orderRow(order.orderId)).refundState).toBe("nao_aplicavel");
  });
});
