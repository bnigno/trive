import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import type {
  CheckoutPreference,
  Payment,
  PaymentGateway,
  RefundResult,
} from "@/adapters/mercadopago";
import { FakePaymentGateway } from "@/adapters/mercadopago/fake";
import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import {
  processPaymentEvent,
  reconcilePendingMpOrders,
  ServiceError,
} from "@/services/payments";
import { createStoreOrder } from "@/services/store-orders";
import { createTestDb, createTestFeeRuleAndPolicy, createTestVariant, type TestDb } from "../helpers/db";
import { listSettlementForecast } from "@/services/financial";
import { spDayKey } from "@/lib/sp-day";

let db: TestDb;
let close: () => Promise<void>;
// PGlite (testes) e postgres-js (produção) divergem apenas no tipo de
// retorno de execute(); a API drizzle usada pelos serviços é idêntica.
let sdb: DbOrTx;
let gateway: FakePaymentGateway;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  sdb = db as unknown as DbOrTx;
  gateway = new FakePaymentGateway();
});

afterEach(async () => {
  await close();
});

const VALID_CPF = "529.982.247-25";

/**
 * Stub com estado mutável direto: cobre cenários que o FakePaymentGateway não
 * expõe por helper (ex.: chargeback) mantendo o MESMO contrato PaymentGateway.
 */
class StubPaymentGateway implements PaymentGateway {
  constructor(private readonly payment: Payment) {}
  async createCheckoutPreference(): Promise<CheckoutPreference> {
    throw new Error("StubPaymentGateway: não usado nestes testes");
  }
  async getPayment(paymentId: string): Promise<Payment> {
    if (paymentId !== this.payment.paymentId) {
      throw new Error(`StubPaymentGateway: unknown payment ${paymentId}`);
    }
    return { ...this.payment };
  }
  async refundPayment(paymentId: string): Promise<RefundResult> {
    return { refundId: `stub-refund-${paymentId}`, status: "approved" };
  }
  set(partial: Partial<Payment>): void {
    Object.assign(this.payment, partial);
  }
}

async function activatePrice(variantId: string, priceCents: number) {
  await db.insert(schema.priceVersions).values({
    productVariantId: variantId,
    versionNumber: 1,
    status: "active",
    priceCents,
    origin: "initial",
    breakdown: {},
    costSnapshotCents: 1000,
    computedMarginRate: "0.3000",
    activatedAt: new Date(),
  });
}

/** Vitrine pronta + pedido da loja em pending_payment com reserva de 2 un. */
async function createPendingStoreOrder(opts: { onHand?: number } = {}) {
  const { variantId } = await createTestVariant(db, {
    sku: `CANECA-${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
    costCents: 1200,
    onHand: opts.onHand ?? 10,
    name: "Caneca Azul",
  });
  await activatePrice(variantId, 4990);
  const [rate] = await db
    .insert(schema.shippingRates)
    .values({ name: "PAC", priceCents: 1990 })
    .returning({ id: schema.shippingRates.id });

  const order = await createStoreOrder(sdb, {
    customer: {
      fullName: "Maria da Silva",
      document: VALID_CPF,
      phone: "(11) 99999-8888",
      email: "maria@example.com",
      marketingOptIn: true,
    },
    address: {
      postalCode: "01310-100",
      street: "Avenida Paulista",
      number: "1000",
      district: "Bela Vista",
      city: "São Paulo",
      state: "SP",
    },
    items: [{ variantId, quantity: 2, expectedUnitPriceCents: 4990 }],
    shippingRateId: rate.id,
    expectedShippingCents: 1990,
  });
  return { ...order, variantId };
}

/** Cria a preferência no fake para o pedido e retorna o paymentId associado. */
async function createFakePayment(order: {
  orderId: string;
  orderNumber: number;
  totalCents: number;
}): Promise<string> {
  const pref = await gateway.createCheckoutPreference({
    orderId: order.orderId,
    orderNumber: order.orderNumber,
    externalReference: order.orderId,
    items: [{ title: "Pedido", quantity: 1, unitPriceCents: order.totalCents }],
    backUrl: "https://trivemaison.com.br/pedido/token",
  });
  return gateway.paymentIdForPreference(pref.preferenceId);
}

async function getOrder(orderId: string) {
  const [order] = await db
    .select()
    .from(schema.orders)
    .where(eq(schema.orders.id, orderId));
  return order;
}

async function getLevel(variantId: string) {
  const [level] = await db
    .select()
    .from(schema.stockLevels)
    .where(eq(schema.stockLevels.productVariantId, variantId));
  return level;
}

async function outboxOfType(eventType: string) {
  return db
    .select()
    .from(schema.outboxEvents)
    .where(eq(schema.outboxEvents.eventType, eventType));
}

async function auditOfAction(action: string) {
  return db
    .select()
    .from(schema.auditLog)
    .where(eq(schema.auditLog.action, action));
}

describe("processPaymentEvent", () => {
  it("pagamento aprovado marca o pedido pago, consome estoque, lança financeiro e grava a taxa real", async () => {
    const pending = await createPendingStoreOrder();
    const paymentId = await createFakePayment(pending);
    gateway.approvePayment(paymentId); // fee fake = 5% arredondado, pix, 1x

    const result = await processPaymentEvent(sdb, gateway, {
      mpPaymentId: paymentId,
    });
    expect(result).toEqual({ orderId: pending.orderId, action: "paid" });

    const order = await getOrder(pending.orderId);
    expect(order.status).toBe("paid");
    expect(order.paidAt).not.toBeNull();
    expect(order.mpPaymentId).toBe(paymentId);
    expect(order.paymentMethod).toBe("pix");
    expect(order.installments).toBe(1);
    expect(order.mpFeeCents).toBe(Math.round(pending.totalCents * 0.05));

    // Reserva consumida: baixa definitiva de 2 un.
    const level = await getLevel(pending.variantId);
    expect(level.onHand).toBe(8);
    expect(level.reserved).toBe(0);

    // Lançamento financeiro da venda (settled) criado pelo transitionOrder.
    const sales = await db
      .select()
      .from(schema.financialEntries)
      .where(
        and(
          eq(schema.financialEntries.orderId, pending.orderId),
          eq(schema.financialEntries.category, "sale"),
        ),
      );
    expect(sales).toHaveLength(1);
    expect(sales[0].direction).toBe("receivable");
    expect(sales[0].status).toBe("settled");
    expect(sales[0].amountCents).toBe(pending.totalCents);

    // Efeito externo via outbox na mesma transação.
    expect(await outboxOfType("order.paid")).toHaveLength(1);
    // Sem payment_fee_rules de pix → sem estimativa → sem divergência.
    expect(await outboxOfType("mp.fee_divergent")).toHaveLength(0);
    // Valor pago = total do pedido → nada a avisar.
    expect(await outboxOfType("mp.amount_divergent")).toHaveLength(0);
  });

  it("pagamento PENDENTE não grava taxa nem avisa divergência", async () => {
    // O Pix pendente do pedido #1007: o MP não tem taxa a informar, mas o
    // webhook 'payment.created' chega do mesmo jeito. Gravar aqui punha o
    // valor da transação no lugar da taxa e mandava alerta falso ao dono.
    await createTestFeeRuleAndPolicy(db);
    const pending = await createPendingStoreOrder();
    const stub = new StubPaymentGateway({
      paymentId: "mp-pend-1",
      status: "pending",
      externalReference: pending.orderId,
      amountCents: pending.totalCents,
      feeCents: pending.totalCents, // o que o adapter quebrado devolvia
      installments: 1,
      paymentMethod: "pix",
    });

    await processPaymentEvent(sdb, stub, { mpPaymentId: "mp-pend-1" });

    const order = await getOrder(pending.orderId);
    expect(order.status).toBe("pending_payment");
    // O id do pagamento é sincronizado; a taxa, não.
    expect(order.mpPaymentId).toBe("mp-pend-1");
    expect(order.mpFeeCents).toBeNull();
    expect(await outboxOfType("mp.fee_divergent")).toHaveLength(0);
    expect(await outboxOfType("mp.amount_divergent")).toHaveLength(0);
  });

  it("aprovado com valor diferente do pedido: marca pago E avisa o dono", async () => {
    // A cliente pagou um link antigo, de antes da correção. O dinheiro entrou
    // de verdade, então o pedido é pago; travar aqui a deixaria no limbo.
    const pending = await createPendingStoreOrder();
    const stub = new StubPaymentGateway({
      paymentId: "mp-div-1",
      status: "approved",
      externalReference: pending.orderId,
      amountCents: pending.totalCents + 289,
      feeCents: 100,
      installments: 1,
      paymentMethod: "pix",
    });

    const result = await processPaymentEvent(sdb, stub, {
      mpPaymentId: "mp-div-1",
    });
    expect(result).toEqual({ orderId: pending.orderId, action: "paid" });
    expect((await getOrder(pending.orderId)).status).toBe("paid");

    const avisos = await outboxOfType("mp.amount_divergent");
    expect(avisos).toHaveLength(1);
    expect(avisos[0].dedupeKey).toBe(`mp.amount_divergent:${pending.orderId}`);
    expect(avisos[0].payload).toMatchObject({
      expectedCents: pending.totalCents,
      paidCents: pending.totalCents + 289,
    });
    expect(await auditOfAction("payment.amount_divergent")).toHaveLength(1);

    // Reenvio do webhook: dedupe segura — continua 1 aviso.
    await processPaymentEvent(sdb, stub, { mpPaymentId: "mp-div-1" });
    expect(await outboxOfType("mp.amount_divergent")).toHaveLength(1);
    expect(await auditOfAction("payment.amount_divergent")).toHaveLength(1);
  });

  it("reprocessar o mesmo evento aprovado é no-op idempotente", async () => {
    const pending = await createPendingStoreOrder();
    const paymentId = await createFakePayment(pending);
    gateway.approvePayment(paymentId);
    await processPaymentEvent(sdb, gateway, { mpPaymentId: paymentId });

    const again = await processPaymentEvent(sdb, gateway, {
      mpPaymentId: paymentId,
    });
    expect(again).toEqual({ orderId: pending.orderId, action: "noop" });

    const order = await getOrder(pending.orderId);
    expect(order.status).toBe("paid");
    const sales = await db
      .select()
      .from(schema.financialEntries)
      .where(
        and(
          eq(schema.financialEntries.orderId, pending.orderId),
          eq(schema.financialEntries.category, "sale"),
        ),
      );
    expect(sales).toHaveLength(1); // sem lançamento duplicado
    const level = await getLevel(pending.variantId);
    expect(level.onHand).toBe(8); // sem dupla baixa de estoque
    expect(level.reserved).toBe(0);
    expect(await outboxOfType("order.paid")).toHaveLength(1);
  });

  it("taxa real divergente da estimada enfileira mp.fee_divergent uma única vez", async () => {
    // Regra vigente de pix a 1%: estimada = 1% do total; a taxa fake é 5%.
    await db.insert(schema.paymentFeeRules).values({
      paymentMethod: "pix",
      installmentsMax: 1,
      percentRate: "0.0100",
      fixedFeeCents: 0,
    });
    const pending = await createPendingStoreOrder();
    const paymentId = await createFakePayment(pending);
    gateway.approvePayment(paymentId);

    await processPaymentEvent(sdb, gateway, { mpPaymentId: paymentId });

    const events = await outboxOfType("mp.fee_divergent");
    expect(events).toHaveLength(1);
    expect(events[0].dedupeKey).toBe(`mp.fee_divergent:${pending.orderId}`);
    expect(events[0].payload).toEqual({
      orderId: pending.orderId,
      estimatedCents: Math.round(pending.totalCents * 0.01),
      actualCents: Math.round(pending.totalCents * 0.05),
    });
    expect(await auditOfAction("payment.fee_divergent")).toHaveLength(1);

    // Reprocessamento: dedupeKey segura — continua 1x.
    await processPaymentEvent(sdb, gateway, { mpPaymentId: paymentId });
    expect(await outboxOfType("mp.fee_divergent")).toHaveLength(1);
    expect(await auditOfAction("payment.fee_divergent")).toHaveLength(1);
  });

  it("reembolso confirmado transiciona para refunded SEM devolver estoque", async () => {
    const pending = await createPendingStoreOrder();
    const paymentId = await createFakePayment(pending);
    gateway.approvePayment(paymentId);
    await processPaymentEvent(sdb, gateway, { mpPaymentId: paymentId });

    await gateway.refundPayment(paymentId);
    const result = await processPaymentEvent(sdb, gateway, {
      mpPaymentId: paymentId,
    });
    expect(result).toEqual({ orderId: pending.orderId, action: "refunded" });

    const order = await getOrder(pending.orderId);
    expect(order.status).toBe("refunded");

    // Sem restock automático: a mercadoria pode não voltar.
    const level = await getLevel(pending.variantId);
    expect(level.onHand).toBe(8);
    expect(level.reserved).toBe(0);

    const refunds = await db
      .select()
      .from(schema.financialEntries)
      .where(
        and(
          eq(schema.financialEntries.orderId, pending.orderId),
          eq(schema.financialEntries.category, "refund"),
        ),
      );
    expect(refunds).toHaveLength(1);
    expect(refunds[0].direction).toBe("payable");

    const [history] = await db
      .select()
      .from(schema.orderStatusHistory)
      .where(
        and(
          eq(schema.orderStatusHistory.orderId, pending.orderId),
          eq(schema.orderStatusHistory.toStatus, "refunded"),
        ),
      );
    expect(history.reason).toBe("Reembolso confirmado pelo Mercado Pago");
  });

  it("chargeback sinaliza via outbox/audit e NÃO transiciona o pedido", async () => {
    const pending = await createPendingStoreOrder();
    const stub = new StubPaymentGateway({
      paymentId: "mp-cb-1",
      status: "approved",
      externalReference: pending.orderId,
      amountCents: pending.totalCents,
      feeCents: null,
      installments: 1,
      paymentMethod: "pix",
    });
    await processPaymentEvent(sdb, stub, { mpPaymentId: "mp-cb-1" });

    stub.set({ status: "charged_back" });
    const result = await processPaymentEvent(sdb, stub, {
      mpPaymentId: "mp-cb-1",
    });
    expect(result).toEqual({
      orderId: pending.orderId,
      action: "chargeback_flagged",
    });

    const order = await getOrder(pending.orderId);
    expect(order.status).toBe("paid"); // dono decide no admin

    const flags = await outboxOfType("payment.chargeback");
    expect(flags).toHaveLength(1);
    expect(flags[0].dedupeKey).toBe(`payment.chargeback:${pending.orderId}`);
    expect(await auditOfAction("payment.chargeback")).toHaveLength(1);

    // Reenvio do webhook: dedupe segura — continua 1x.
    const again = await processPaymentEvent(sdb, stub, {
      mpPaymentId: "mp-cb-1",
    });
    expect(again.action).toBe("chargeback_flagged");
    expect(await outboxOfType("payment.chargeback")).toHaveLength(1);
    expect(await auditOfAction("payment.chargeback")).toHaveLength(1);
  });

  it("pagamento rejeitado mantém pending_payment e a reserva intacta", async () => {
    const pending = await createPendingStoreOrder();
    const paymentId = await createFakePayment(pending);
    gateway.rejectPayment(paymentId);

    const result = await processPaymentEvent(sdb, gateway, {
      mpPaymentId: paymentId,
    });
    expect(result).toEqual({ orderId: pending.orderId, action: "noop" });

    const order = await getOrder(pending.orderId);
    expect(order.status).toBe("pending_payment"); // cliente pode tentar de novo
    const level = await getLevel(pending.variantId);
    expect(level.onHand).toBe(10);
    expect(level.reserved).toBe(2); // reserva expira sozinha depois
  });

  it("pagamento sem pedido correspondente lança ServiceError (evento vai para a DLQ)", async () => {
    const pref = await gateway.createCheckoutPreference({
      orderId: "11111111-1111-4111-8111-111111111111",
      orderNumber: 9999,
      externalReference: "11111111-1111-4111-8111-111111111111",
      items: [{ title: "Fantasma", quantity: 1, unitPriceCents: 1000 }],
      backUrl: "https://trivemaison.com.br/pedido/token",
    });
    const paymentId = gateway.paymentIdForPreference(pref.preferenceId);
    gateway.approvePayment(paymentId);

    await expect(
      processPaymentEvent(sdb, gateway, { mpPaymentId: paymentId }),
    ).rejects.toMatchObject({
      name: "ServiceError",
      code: "ORDER_NOT_FOUND_FOR_PAYMENT",
    });
    await expect(
      processPaymentEvent(sdb, gateway, { mpPaymentId: paymentId }),
    ).rejects.toBeInstanceOf(ServiceError);
  });
});

describe("reconcilePendingMpOrders", () => {
  it("reprocessa pedidos antigos com pagamento conhecido e pula os sem paymentId", async () => {
    const elevenMinAgo = new Date(Date.now() - 11 * 60_000);

    // A: pending há >10min, preferência + paymentId conhecidos, pagamento aprovado.
    const orderA = await createPendingStoreOrder();
    const paymentA = await createFakePayment(orderA);
    gateway.approvePayment(paymentA);
    await db
      .update(schema.orders)
      .set({
        mpPreferenceId: "fake-pref-1",
        mpPaymentId: paymentA,
        createdAt: elevenMinAgo,
      })
      .where(eq(schema.orders.id, orderA.orderId));

    // B: pending há >10min com preferência mas SEM paymentId → pulado
    // (o webhook é o caminho; busca por external_reference entra com credencial real).
    const orderB = await createPendingStoreOrder();
    await db
      .update(schema.orders)
      .set({ mpPreferenceId: "pref-sem-pagamento", createdAt: elevenMinAgo })
      .where(eq(schema.orders.id, orderB.orderId));

    // C: recente (<10min) → fora da varredura.
    const orderC = await createPendingStoreOrder();
    await db
      .update(schema.orders)
      .set({ mpPreferenceId: "pref-recente" })
      .where(eq(schema.orders.id, orderC.orderId));

    const result = await reconcilePendingMpOrders(sdb, gateway, {});
    expect(result).toEqual({
      scanned: 2,
      processed: 1,
      paid: 1,
      skipped: 1,
      failed: 0,
    });

    expect((await getOrder(orderA.orderId)).status).toBe("paid");
    expect((await getOrder(orderB.orderId)).status).toBe("pending_payment");
    expect((await getOrder(orderC.orderId)).status).toBe("pending_payment");
  });
});

describe("taxa do Mercado Pago como lançamento (mp_fee)", () => {
  async function mpFeeEntries(orderId: string) {
    return db
      .select()
      .from(schema.financialEntries)
      .where(
        and(
          eq(schema.financialEntries.orderId, orderId),
          eq(schema.financialEntries.category, "mp_fee"),
        ),
      );
  }

  it("aprovado com taxa → um lançamento a pagar pendente com vencimento no dia do pagamento (sem regra = 0 dias); reprocessar não duplica", async () => {
    const pending = await createPendingStoreOrder();
    const paymentId = await createFakePayment(pending);
    gateway.approvePayment(paymentId);
    await processPaymentEvent(sdb, gateway, { mpPaymentId: paymentId });

    const entries = await mpFeeEntries(pending.orderId);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      direction: "payable",
      status: "pending",
      amountCents: Math.round(pending.totalCents * 0.05),
      description: `Taxa Mercado Pago — pedido #${pending.orderNumber}`,
      dueDate: spDayKey(new Date()),
    });

    await processPaymentEvent(sdb, gateway, { mpPaymentId: paymentId });
    expect(await mpFeeEntries(pending.orderId)).toHaveLength(1);
    expect(await auditOfAction("financial_entry.mp_fee_sync")).toHaveLength(1);

    // A previsão lista o pedido com líquido = total − taxa.
    const forecast = await listSettlementForecast(sdb);
    expect(forecast).toHaveLength(1);
    expect(forecast[0]).toMatchObject({
      orderNumber: pending.orderNumber,
      grossCents: pending.totalCents,
      feeCents: Math.round(pending.totalCents * 0.05),
      dueDate: spDayKey(new Date()),
    });
  });

  it("com regra do método (30 dias), o vencimento é o dia do pagamento + 30", async () => {
    await createTestFeeRuleAndPolicy(db); // credit_card, 4,98%, 30 dias
    const pending = await createPendingStoreOrder();
    const paymentId = await createFakePayment(pending);
    gateway.approvePayment(paymentId, { paymentMethod: "credit_card", installments: 1 });
    await processPaymentEvent(sdb, gateway, { mpPaymentId: paymentId });

    const [entry] = await mpFeeEntries(pending.orderId);
    const expected = new Date();
    expected.setUTCDate(expected.getUTCDate() + 30);
    expect(entry.dueDate).toBe(spDayKey(expected));
  });

  it("taxa diferente num reenvio atualiza o valor com audit; reembolso cancela o lançamento pendente", async () => {
    const pending = await createPendingStoreOrder();
    const paymentId = await createFakePayment(pending);
    gateway.approvePayment(paymentId);
    await processPaymentEvent(sdb, gateway, { mpPaymentId: paymentId });

    const base = await gateway.getPayment(paymentId);
    const withOtherFee: PaymentGateway = {
      createCheckoutPreference: (input) => gateway.createCheckoutPreference(input),
      refundPayment: (id) => gateway.refundPayment(id),
      getPayment: async (): Promise<Payment> => ({ ...base, feeCents: (base.feeCents ?? 0) + 37 }),
    };
    await processPaymentEvent(sdb, withOtherFee, { mpPaymentId: paymentId });
    let [entry] = await mpFeeEntries(pending.orderId);
    expect(entry.amountCents).toBe(Math.round(pending.totalCents * 0.05) + 37);
    expect(entry.status).toBe("pending");
    expect(await auditOfAction("financial_entry.mp_fee_sync")).toHaveLength(2);

    await gateway.refundPayment(paymentId);
    await processPaymentEvent(sdb, gateway, { mpPaymentId: paymentId });
    [entry] = await mpFeeEntries(pending.orderId);
    expect(entry.status).toBe("canceled");
    expect(await listSettlementForecast(sdb)).toHaveLength(0);
  });

  it("pagamento rejeitado com taxa não gera lançamento", async () => {
    const pending = await createPendingStoreOrder();
    const paymentId = await createFakePayment(pending);
    gateway.rejectPayment(paymentId);
    await processPaymentEvent(sdb, gateway, { mpPaymentId: paymentId });
    expect(await mpFeeEntries(pending.orderId)).toHaveLength(0);
  });
});
