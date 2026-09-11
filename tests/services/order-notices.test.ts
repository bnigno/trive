// Avisos que não existiam: cancelamento e reembolso para a cliente (com
// opt-in e dedupe por pedido), chargeback e taxa divergente para o dono.
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeMessagingProvider } from "@/adapters/zapi/fake";
import { RESERVATION_EXPIRED_REASON } from "@/core/orders/reasons";
import * as schema from "@/db/schema";
import { formatCentsBRL } from "@/lib/money";
import type { DbOrTx } from "@/queue/enqueue";
import {
  notifyOwnerChargeback,
  notifyOwnerFeeDivergent,
  sendOrderCanceledWa,
  sendOrderRefundedWa,
} from "@/services/order-notices";
import { transitionOrder } from "@/services/orders";
import { createStoreOrder } from "@/services/store-orders";
import { createTestDb, createTestVariant, type TestDb } from "../helpers/db";

let db: TestDb;
let close: () => Promise<void>;
let sdb: DbOrTx;
let provider: FakeMessagingProvider;

const PHONE = "+5591988887777";
const OWNER_PHONE = "+5591999990000";
const VALID_CPF = "52998224725";

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  sdb = db as unknown as DbOrTx;
  provider = new FakeMessagingProvider();
  await db.insert(schema.settings).values([
    { key: "wa_enabled", value: true },
    { key: "owner_whatsapp_phone", value: OWNER_PHONE },
    { key: "store_name", value: "TRIVÉ" },
  ]);
  await db.insert(schema.waTemplates).values([
    {
      key: "order_canceled",
      label: "Pedido cancelado",
      bodyTemplate: "{{nome}}, o pedido #{{pedido}} foi cancelado: {{motivo}}. Detalhes: {{link}}",
      variables: ["nome", "pedido", "motivo", "link"],
    },
    {
      key: "order_refunded",
      label: "Reembolso",
      bodyTemplate: "{{nome}}, o reembolso de {{total}} do pedido #{{pedido}} foi confirmado.",
      variables: ["nome", "pedido", "total"],
    },
    {
      key: "owner_chargeback",
      label: "[interno] Chargeback",
      bodyTemplate: "Chargeback no pedido #{{pedido}} — {{cliente}} · {{total}}",
      variables: ["pedido", "cliente", "total"],
    },
    {
      key: "owner_fee_divergent",
      label: "[interno] Taxa",
      bodyTemplate: "Taxa #{{pedido}} ({{metodo}}): estimada {{estimada}} · real {{real}} · diferença {{diferenca}}",
      variables: ["pedido", "metodo", "estimada", "real", "diferenca"],
    },
  ]);
});

afterEach(async () => {
  await close();
});

async function createOrder(): Promise<{ orderId: string; orderNumber: number }> {
  const { variantId } = await createTestVariant(db, { sku: "CANECA-AZUL", onHand: 5 });
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
  const created = await createStoreOrder(sdb, {
    customer: { fullName: "Maria da Silva", document: VALID_CPF, phone: PHONE, marketingOptIn: true },
    address: {
      postalCode: "01310100",
      street: "Avenida Paulista",
      number: "1000",
      district: "Bela Vista",
      city: "São Paulo",
      state: "SP",
    },
    items: [{ variantId, quantity: 1, expectedUnitPriceCents: 4990 }],
    shippingRateId: rate.id,
    expectedShippingCents: 1990,
  });
  return { orderId: created.orderId, orderNumber: created.orderNumber };
}

describe("sendOrderCanceledWa", () => {
  it("cancelado pela dona: a cliente recebe o motivo, o link, e a segunda chamada não repete", async () => {
    const { orderId, orderNumber } = await createOrder();
    await transitionOrder(sdb, { orderId, to: "canceled", userId: null, reason: "  cliente   desistiu da compra " });

    const first = await sendOrderCanceledWa(sdb, provider, { orderId });
    expect(first).toMatchObject({ sent: true });
    expect(provider.sentMessages).toHaveLength(1);
    expect(provider.sentMessages[0].toE164).toBe(PHONE);
    expect(provider.sentMessages[0].body).toContain(`o pedido #${orderNumber} foi cancelado: cliente desistiu da compra.`);
    expect(provider.sentMessages[0].body).toContain("/pedido/");

    const second = await sendOrderCanceledWa(sdb, provider, { orderId });
    expect(second).toEqual({ skipped: "ja_enviado" });
    expect(provider.sentMessages).toHaveLength(1);
  });

  it("cancelado por expiração da reserva: o texto técnico vira frase humana", async () => {
    const { orderId } = await createOrder();
    await transitionOrder(sdb, { orderId, to: "canceled", userId: null, reason: RESERVATION_EXPIRED_REASON });
    await sendOrderCanceledWa(sdb, provider, { orderId });
    expect(provider.sentMessages[0].body).toContain("o prazo de pagamento terminou e a reserva foi liberada");
    expect(provider.sentMessages[0].body).not.toContain("Reserva expirada");
  });

  it("sem opt-in não envia; pedido que não está cancelado também não", async () => {
    const { orderId } = await createOrder();
    expect(await sendOrderCanceledWa(sdb, provider, { orderId })).toEqual({ skipped: "status_diferente" });

    await transitionOrder(sdb, { orderId, to: "canceled", userId: null });
    await db.update(schema.customers).set({ marketingOptIn: false }).where(eq(schema.customers.phoneE164, PHONE));
    expect(await sendOrderCanceledWa(sdb, provider, { orderId })).toEqual({ skipped: "sem_opt_in" });
    expect(provider.sentMessages).toHaveLength(0);
  });

  it("WhatsApp desligado: skip, nunca erro", async () => {
    const { orderId } = await createOrder();
    await transitionOrder(sdb, { orderId, to: "canceled", userId: null });
    await db.update(schema.settings).set({ value: false }).where(eq(schema.settings.key, "wa_enabled"));
    expect(await sendOrderCanceledWa(sdb, provider, { orderId })).toEqual({ skipped: "desabilitado" });
  });
});

describe("sendOrderRefundedWa", () => {
  it("reembolso confirmado: a cliente recebe o valor", async () => {
    const { orderId, orderNumber } = await createOrder();
    await transitionOrder(sdb, { orderId, to: "paid", userId: null });
    await transitionOrder(sdb, { orderId, to: "refunded", userId: null, reason: "Estorno" });

    expect(await sendOrderRefundedWa(sdb, provider, { orderId })).toMatchObject({ sent: true });
    expect(provider.sentMessages[0].body).toContain(`o reembolso de ${formatCentsBRL(6980)} do pedido #${orderNumber} foi confirmado`);
  });
});

describe("avisos ao dono", () => {
  it("chargeback e taxa divergente chegam ao telefone do dono com os valores em reais", async () => {
    const { orderId, orderNumber } = await createOrder();

    expect(await notifyOwnerChargeback(sdb, provider, { orderId })).toMatchObject({ sent: true });
    expect(await notifyOwnerFeeDivergent(sdb, provider, { orderId, estimatedCents: 1445, actualCents: 1610 })).toMatchObject({ sent: true });

    expect(provider.sentMessages).toHaveLength(2);
    expect(provider.sentMessages.every((message) => message.toE164 === OWNER_PHONE)).toBe(true);
    expect(provider.sentMessages[0].body).toContain(`Chargeback no pedido #${orderNumber} — Maria da Silva · ${formatCentsBRL(6980)}`);
    expect(provider.sentMessages[1].body).toContain(`estimada ${formatCentsBRL(1445)} · real ${formatCentsBRL(1610)} · diferença +${formatCentsBRL(165)}`);

    // Dedupe por pedido: repetir o evento não manda de novo.
    expect(await notifyOwnerChargeback(sdb, provider, { orderId })).toEqual({ skipped: "ja_enviado" });
    expect(provider.sentMessages).toHaveLength(2);
  });

  it("pedido inexistente é skip", async () => {
    expect(await notifyOwnerChargeback(sdb, provider, { orderId: "00000000-0000-4000-8000-000000000000" })).toEqual({
      skipped: "pedido_inexistente",
    });
  });
});
