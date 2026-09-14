// A Lia confirma a entrega: 'chegou' → confirmar_entrega só age no pedido
// enviado da cliente desta conversa, e o caderninho lembra o último envio.
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { buildToolExecutor } from "@/services/wa-bot";
import { shipmentMemoryLineFor } from "@/services/bot/orders";
import { createTestDb, type TestDb } from "../helpers/db";

const PHONE = "+5511999990000";
const DUMMY_INBOUND_ID = "00000000-0000-4000-8000-0000000000aa";

let db: TestDb;
let sdb: DbOrTx;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  sdb = db as unknown as DbOrTx;
  vi.stubEnv("ADAPTER_MODE", "fake");
});

afterEach(async () => {
  await close();
  vi.unstubAllEnvs();
});

async function seedShippedOrder(phone = PHONE): Promise<{ orderId: string; orderNumber: number; customerId: string }> {
  const [customer] = await db.insert(schema.customers).values({ fullName: "Ana Cliente", phoneE164: phone, marketingOptIn: true }).returning({ id: schema.customers.id });
  const [order] = await db
    .insert(schema.orders)
    .values({
      customerId: customer.id,
      status: "shipped",
      channel: "whatsapp",
      subtotalCents: 1000,
      shippingCents: 0,
      totalCents: 1000,
      shippedAt: new Date("2026-09-05T12:00:00Z"),
      shippingTrackingCode: "AA123456789BR",
    })
    .returning({ id: schema.orders.id, orderNumber: schema.orders.orderNumber });
  return { orderId: order.id, orderNumber: order.orderNumber, customerId: customer.id };
}

describe("confirmar_entrega", () => {
  it("marca o pedido enviado da cliente como entregue (assinado pela Lia) e o caderninho para de lembrar", async () => {
    const { orderId, orderNumber, customerId } = await seedShippedOrder();
    const [conversation] = await db.insert(schema.waConversations).values({ phoneE164: PHONE, customerId }).returning({ id: schema.waConversations.id });
    const before = await shipmentMemoryLineFor(sdb, { customerId, phoneE164: PHONE });
    expect(before).toContain(`#${orderNumber} enviado em 05/09 (rastreio AA123456789BR)`);

    const executor = buildToolExecutor(sdb, { conversationId: conversation.id, phoneE164: PHONE, customerId, lastInboundId: DUMMY_INBOUND_ID });
    const result = await executor("confirmar_entrega", {});
    expect(result.ok).toBe(true);
    expect(result.text).toContain(`Pedido #${orderNumber} marcado como entregue`);
    const [order] = await db.select().from(schema.orders).where(eq(schema.orders.id, orderId));
    expect(order.status).toBe("delivered");
    expect(order.deliveryConfirmedBy).toBe("lia");
    expect(await shipmentMemoryLineFor(sdb, { customerId, phoneE164: PHONE })).toBeNull();

    const again = await executor("confirmar_entrega", {});
    expect(again.ok).toBe(true);
    expect(again.text).toContain("já estava marcado como entregue");
  });

  it("outro telefone não confirma o pedido alheio; pedido pago não vira entregue", async () => {
    const { orderNumber } = await seedShippedOrder();
    const [other] = await db.insert(schema.waConversations).values({ phoneE164: "+5511888880000" }).returning({ id: schema.waConversations.id });
    const executor = buildToolExecutor(sdb, { conversationId: other.id, phoneE164: "+5511888880000", customerId: null, lastInboundId: DUMMY_INBOUND_ID });
    const result = await executor("confirmar_entrega", { numero_do_pedido: orderNumber });
    expect(result.ok).toBe(false);
    expect(result.text).toContain("Ainda não encontrei pedidos");

    const paid = await seedShippedOrder("+5511777770000");
    await db.update(schema.orders).set({ status: "paid" }).where(eq(schema.orders.id, paid.orderId));
    const [conv] = await db.insert(schema.waConversations).values({ phoneE164: "+5511777770000", customerId: paid.customerId }).returning({ id: schema.waConversations.id });
    const paidExecutor = buildToolExecutor(sdb, { conversationId: conv.id, phoneE164: "+5511777770000", customerId: paid.customerId, lastInboundId: DUMMY_INBOUND_ID });
    const denied = await paidExecutor("confirmar_entrega", {});
    expect(denied.ok).toBe(false);
    expect(denied.text).toContain("não \"enviado\"");
  });

  it("no ensaio do painel (dryRun) não marca pedido de verdade", async () => {
    const { orderId, customerId } = await seedShippedOrder();
    const [conversation] = await db.insert(schema.waConversations).values({ phoneE164: PHONE, customerId }).returning({ id: schema.waConversations.id });
    const executor = buildToolExecutor(sdb, { conversationId: conversation.id, phoneE164: PHONE, customerId, lastInboundId: DUMMY_INBOUND_ID, dryRun: true });
    const result = await executor("confirmar_entrega", {});
    expect(result.ok).toBe(true);
    const [order] = await db.select().from(schema.orders).where(eq(schema.orders.id, orderId));
    expect(order.status).toBe("shipped");
  });
});
