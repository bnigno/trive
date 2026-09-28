// Pedido com telefone sem WhatsApp (caso do #1011): a mensagem da cliente
// falha, a dona é avisada UMA vez por pedido e número (com a dica do número
// parecido que falou com a loja), telefone corrigido não gera aviso, e a
// página do pedido mostra o alerta enquanto o cadastro não muda.
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeMessagingProvider } from "@/adapters/zapi/fake";
import * as schema from "@/db/schema";
import { initialWaTemplates } from "@/db/seed-data";
import type { DbOrTx } from "@/queue/enqueue";
import { getOrderWhatsappProblem, notifyOwnerCustomerNoWhatsapp, OWNER_NO_WHATSAPP_TEMPLATE_KEY } from "@/services/order-no-whatsapp";
import { ORDER_NO_WHATSAPP_EVENT, sendTemplateMessage } from "@/services/wa-messaging";
import { createTestDb, type TestDb } from "../helpers/db";

vi.mock("@/inngest/client", () => ({ inngest: { send: async () => ({ ids: [] }) } }));

const NOW = new Date("2026-09-28T13:00:00Z");
const OWNER = "+5591981000001";
const TYPED = "+5591981232560"; // o que a cliente digitou (sem WhatsApp)
const REAL = "+5591981242560"; // o dela, um dígito diferente

let db: TestDb;
let sdb: DbOrTx;
let close: () => Promise<void>;
let provider: FakeMessagingProvider;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  sdb = db as unknown as DbOrTx;
  provider = new FakeMessagingProvider();
  provider.setPhoneExists(TYPED, false);
  await db.insert(schema.settings).values([
    { key: "wa_enabled", value: true },
    { key: "owner_whatsapp_phone", value: OWNER },
  ]).onConflictDoUpdate({ target: schema.settings.key, set: { value: true } });
  await db.update(schema.settings).set({ value: OWNER }).where(eq(schema.settings.key, "owner_whatsapp_phone"));
  const template = initialWaTemplates.find((row) => row.key === OWNER_NO_WHATSAPP_TEMPLATE_KEY)!;
  await db.insert(schema.waTemplates).values(template).onConflictDoNothing();
});

afterEach(async () => {
  await close();
  vi.restoreAllMocks();
});

async function seedOrder(phone = TYPED): Promise<{ orderId: string; customerId: string; orderNumber: number }> {
  const [customer] = await db.insert(schema.customers).values({ fullName: "Samila Santos Silva", phoneE164: phone }).returning({ id: schema.customers.id });
  const [order] = await db
    .insert(schema.orders)
    .values({ customerId: customer!.id, status: "paid", channel: "store", subtotalCents: 5850, discountCents: 0, shippingCents: 0, totalCents: 5850 })
    .returning({ id: schema.orders.id, orderNumber: schema.orders.orderNumber });
  return { orderId: order!.id, customerId: customer!.id, orderNumber: order!.orderNumber };
}

/** A cliente de verdade conversou com a loja pelo número certo. */
async function seedConversation(phone: string, lastInboundAt: Date) {
  await db.insert(schema.waConversations).values({ phoneE164: phone, lastInboundAt });
}

const sendOrderNotice = (orderId: string, key: string) =>
  sendTemplateMessage(sdb, provider, { bodyOverride: `aviso ${key}`, phoneE164: TYPED, orderId, dedupeKey: `wa.${key}:${orderId}`, requireOptIn: false });

const alertEvents = () => db.select().from(schema.outboxEvents).where(eq(schema.outboxEvents.eventType, ORDER_NO_WHATSAPP_EVENT));

describe("mensagem de pedido para número sem WhatsApp", () => {
  it("falha e põe UM aviso da dona na fila por pedido e número (os 5 avisos do pedido viram um alerta)", async () => {
    const { orderId } = await seedOrder();
    for (const key of ["order_confirmed", "payment_approved", "order_packed", "order_out_for_delivery"]) {
      expect(await sendOrderNotice(orderId, key)).toEqual({ skipped: "numero_sem_whatsapp" });
    }
    const events = await alertEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toEqual({ orderId, phoneE164: TYPED });
    expect(events[0]!.dedupeKey).toBe(`${ORDER_NO_WHATSAPP_EVENT}:${orderId}:${TYPED.replace(/\D/g, "")}`);
    const failed = await db.select().from(schema.waMessages).where(eq(schema.waMessages.orderId, orderId));
    expect(failed.every((row) => row.status === "failed")).toBe(true);
  });

  it("mensagem sem pedido (avulsa) falha como antes, sem alerta", async () => {
    await sendTemplateMessage(sdb, provider, { bodyOverride: "oi", phoneE164: TYPED, dedupeKey: "wa.avulsa:1", requireOptIn: false });
    expect(await alertEvents()).toHaveLength(0);
  });
});

describe("notifyOwnerCustomerNoWhatsapp — o aviso da dona", () => {
  it("manda à dona o pedido, a cliente, o telefone errado e a dica do número certo; repetido não duplica", async () => {
    const { orderId, orderNumber } = await seedOrder();
    await seedConversation(REAL, new Date(NOW.getTime() - 3 * 3_600_000));
    await seedConversation("+5511999990000", new Date(NOW.getTime() - 3_600_000));

    const result = await notifyOwnerCustomerNoWhatsapp(sdb, provider, { orderId, phoneE164: TYPED }, NOW);
    expect(result).toMatchObject({ sent: true });
    expect(provider.sentMessages).toHaveLength(1);
    const message = provider.sentMessages[0]!;
    expect(message.toE164).toBe(OWNER);
    expect(message.body).toContain(`pedido #${orderNumber}`);
    expect(message.body).toContain("Samila Santos Silva fez o pedido com o telefone (91) 98123-2560, que não tem WhatsApp");
    expect(message.body).toContain("os avisos do pedido e o link de acompanhamento não estão chegando");
    expect(message.body).toContain("Parece erro de digitação: o (91) 98124-2560 falou com a loja");

    expect(await notifyOwnerCustomerNoWhatsapp(sdb, provider, { orderId, phoneE164: TYPED }, NOW)).toEqual({ skipped: "ja_enviado" });
    expect(provider.sentMessages).toHaveLength(1);
  });

  it("sem número parecido (ou com dois parecidos): pede para conferir com ela, sem chutar", async () => {
    const { orderId } = await seedOrder();
    await seedConversation(REAL, new Date(NOW.getTime() - 3_600_000));
    await seedConversation("+5591981232561", new Date(NOW.getTime() - 3_600_000));
    await notifyOwnerCustomerNoWhatsapp(sdb, provider, { orderId, phoneE164: TYPED }, NOW);
    expect(provider.sentMessages[0]!.body).toContain("Confira o telefone com a cliente");
    expect(provider.sentMessages[0]!.body).not.toContain("Parece erro de digitação");
  });

  it("número parecido que falou com a loja há mais de 3 dias não vira dica", async () => {
    const { orderId } = await seedOrder();
    await seedConversation(REAL, new Date(NOW.getTime() - 4 * 24 * 3_600_000));
    await notifyOwnerCustomerNoWhatsapp(sdb, provider, { orderId, phoneE164: TYPED }, NOW);
    expect(provider.sentMessages[0]!.body).not.toContain("Parece erro de digitação");
  });

  it("telefone já corrigido no cadastro: nada a avisar", async () => {
    const { orderId, customerId } = await seedOrder();
    await db.update(schema.customers).set({ phoneE164: REAL }).where(eq(schema.customers.id, customerId));
    expect(await notifyOwnerCustomerNoWhatsapp(sdb, provider, { orderId, phoneE164: TYPED }, NOW)).toEqual({ skipped: "telefone_corrigido" });
    expect(provider.sentMessages).toHaveLength(0);
  });
});

describe("getOrderWhatsappProblem — o alerta da página do pedido", () => {
  it("mostra quantos avisos não chegaram e a dica; some quando o telefone é corrigido", async () => {
    const { orderId, customerId } = await seedOrder();
    expect(await getOrderWhatsappProblem(sdb, orderId, NOW)).toBeNull();
    await seedConversation(REAL, new Date(NOW.getTime() - 3_600_000));
    await sendOrderNotice(orderId, "order_confirmed");
    await sendOrderNotice(orderId, "payment_approved");

    expect(await getOrderWhatsappProblem(sdb, orderId, NOW)).toEqual({ phoneE164: TYPED, failedCount: 2, intendedPhone: REAL, customerId });

    await db.update(schema.customers).set({ phoneE164: REAL }).where(eq(schema.customers.id, customerId));
    expect(await getOrderWhatsappProblem(sdb, orderId, NOW)).toBeNull();
  });
});
