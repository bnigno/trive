import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import * as schema from "@/db/schema";
import { FakeMessagingProvider } from "@/adapters/zapi/fake";
import type { DbOrTx } from "@/queue/enqueue";
import {
  isWaEnabled,
  recoverUnpaidOrders,
  sendTemplateMessage,
  sendToOwner,
} from "@/services/wa-messaging";
import { createTestDb, type TestDb } from "../helpers/db";

let db: TestDb;
let close: () => Promise<void>;
// PGlite (testes) e node-postgres (produção) divergem apenas no retorno de
// execute(); a API drizzle usada pelos serviços é idêntica.
let sdb: DbOrTx;
let provider: FakeMessagingProvider;

const CLIENT_PHONE = "+5511999998888";
const OWNER_PHONE = "+5511988887777";

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  sdb = db as unknown as DbOrTx;
  provider = new FakeMessagingProvider();
});

afterEach(async () => {
  await close();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function enableWa(): Promise<void> {
  await db.insert(schema.settings).values({ key: "wa_enabled", value: true });
}

async function setOwnerPhone(phone: string = OWNER_PHONE): Promise<void> {
  await db
    .insert(schema.settings)
    .values({ key: "owner_whatsapp_phone", value: phone });
}

async function seedTemplates(): Promise<void> {
  await db.insert(schema.waTemplates).values([
    {
      key: "order_confirmed",
      label: "Pedido confirmado (cliente)",
      bodyTemplate:
        "Olá {{nome}}! Recebemos o pedido #{{pedido}} no total de {{total}}. Pague até {{prazo}} e acompanhe em {{link}}.",
      variables: ["nome", "pedido", "total", "prazo", "link"],
    },
    {
      key: "order_recovery",
      label: "Recuperação de pedido não pago",
      bodyTemplate:
        "Oi {{nome}}, seu pedido #{{pedido}} ainda aguarda pagamento ({{total}}). Finalize em {{link}}.",
      variables: ["nome", "pedido", "total", "link"],
    },
    {
      key: "owner_new_order",
      label: "Novo pedido (dono)",
      bodyTemplate: "Novo pedido #{{pedido}} de {{cliente}} — {{total}}.",
      variables: ["pedido", "cliente", "total"],
    },
    {
      key: "template_desligado",
      label: "Template inativo",
      bodyTemplate: "não deveria sair",
      variables: [],
      isActive: false,
    },
  ]);
}

async function createCustomer(
  optIn: boolean,
  phone: string | null = CLIENT_PHONE,
): Promise<string> {
  const [customer] = await db
    .insert(schema.customers)
    .values({
      fullName: "Maria da Silva",
      phoneE164: phone,
      marketingOptIn: optIn,
    })
    .returning({ id: schema.customers.id });
  return customer.id;
}

async function createStoreOrder(
  customerId: string,
  over: Partial<typeof schema.orders.$inferInsert> = {},
): Promise<{ id: string; orderNumber: number; publicToken: string }> {
  const [order] = await db
    .insert(schema.orders)
    .values({
      customerId,
      status: "pending_payment",
      channel: "store",
      subtotalCents: 9980,
      discountCents: 0,
      shippingCents: 1990,
      totalCents: 11970,
      // Elegível para recuperação: criado há 90 min, reserva ainda válida.
      createdAt: new Date(Date.now() - 90 * 60_000),
      paymentDueAt: new Date(Date.now() + 30 * 60_000),
      ...over,
    })
    .returning({
      id: schema.orders.id,
      orderNumber: schema.orders.orderNumber,
      publicToken: schema.orders.publicToken,
    });
  return order;
}

async function getMessages() {
  return db.select().from(schema.waMessages);
}

function baseInput(customerId: string) {
  return {
    templateKey: "order_confirmed",
    phoneE164: CLIENT_PHONE,
    vars: {
      nome: "Maria",
      pedido: "1000",
      total: "R$ 119,70",
      prazo: "25/08/2026 às 18:00",
      link: "https://loja.example/pedido/x",
    },
    customerId,
    dedupeKey: "wa.test:1",
    requireOptIn: true,
  };
}

// ---------------------------------------------------------------------------
// isWaEnabled + desabilitado
// ---------------------------------------------------------------------------

describe("isWaEnabled", () => {
  it("false sem o setting wa_enabled; true com ele em modo fake", async () => {
    expect(await isWaEnabled(sdb)).toBe(false);
    await enableWa();
    expect(await isWaEnabled(sdb)).toBe(true);
  });
});

describe("sendTemplateMessage", () => {
  it("wa desligado → { skipped: 'desabilitado' } e NADA gravado", async () => {
    await seedTemplates();
    const customerId = await createCustomer(true);

    const result = await sendTemplateMessage(sdb, provider, baseInput(customerId));

    expect(result).toEqual({ skipped: "desabilitado" });
    expect(await getMessages()).toHaveLength(0);
    expect(provider.sentMessages).toHaveLength(0);
  });

  it("sem opt-in → { skipped: 'sem_opt_in' } e NADA gravado (LGPD)", async () => {
    await enableWa();
    await seedTemplates();
    const customerId = await createCustomer(false);

    const result = await sendTemplateMessage(sdb, provider, baseInput(customerId));

    expect(result).toEqual({ skipped: "sem_opt_in" });
    expect(await getMessages()).toHaveLength(0);
    expect(await db.select().from(schema.waConversations)).toHaveLength(0);
    expect(provider.sentMessages).toHaveLength(0);
  });

  it("cliente inexistente com requireOptIn → sem_opt_in", async () => {
    await enableWa();
    await seedTemplates();

    const result = await sendTemplateMessage(sdb, provider, {
      ...baseInput("00000000-0000-4000-8000-0000000000aa"),
      customerId: undefined,
      phoneE164: "+5511977776666", // nenhum cliente com este telefone
    });

    expect(result).toEqual({ skipped: "sem_opt_in" });
    expect(await getMessages()).toHaveLength(0);
  });

  it("template ausente ou inativo → { skipped: 'sem_template' }", async () => {
    await enableWa();
    await seedTemplates();
    const customerId = await createCustomer(true);

    const missing = await sendTemplateMessage(sdb, provider, {
      ...baseInput(customerId),
      templateKey: "nao_existe",
    });
    const inactive = await sendTemplateMessage(sdb, provider, {
      ...baseInput(customerId),
      templateKey: "template_desligado",
    });

    expect(missing).toEqual({ skipped: "sem_template" });
    expect(inactive).toEqual({ skipped: "sem_template" });
    expect(await getMessages()).toHaveLength(0);
  });

  it("com opt-in: envia, grava sent com render e conversa; dedupe repetido → ja_enviado", async () => {
    await enableWa();
    await seedTemplates();
    const customerId = await createCustomer(true);

    const result = await sendTemplateMessage(sdb, provider, baseInput(customerId));
    expect(result).toMatchObject({ sent: true });

    const messages = await getMessages();
    expect(messages).toHaveLength(1);
    const [message] = messages;
    expect(message.status).toBe("sent");
    expect(message.direction).toBe("outbound");
    expect(message.templateKey).toBe("order_confirmed");
    expect(message.dedupeKey).toBe("wa.test:1");
    expect(message.zapiMessageId).toBeTruthy();
    expect(message.sentAt).toBeInstanceOf(Date);
    // Render: {{chave}} substituída pelas vars.
    expect(message.body).toContain("Olá Maria!");
    expect(message.body).toContain("#1000");
    expect(message.body).toContain("R$ 119,70");

    const [conversation] = await db.select().from(schema.waConversations);
    expect(conversation.phoneE164).toBe(CLIENT_PHONE);
    expect(conversation.customerId).toBe(customerId);
    expect(conversation.lastOutboundAt).toBeInstanceOf(Date);

    expect(provider.sentMessages).toHaveLength(1);
    expect(provider.sentMessages[0].toE164).toBe(CLIENT_PHONE);

    // Idempotência: mesmo dedupeKey → ja_enviado, sem novo envio nem linha.
    const repeat = await sendTemplateMessage(sdb, provider, baseInput(customerId));
    expect(repeat).toEqual({ skipped: "ja_enviado" });
    expect(await getMessages()).toHaveLength(1);
    expect(provider.sentMessages).toHaveLength(1);
  });

  it("sessão desconectada: lança, mensagem fica failed com error_detail", async () => {
    await enableWa();
    await seedTemplates();
    const customerId = await createCustomer(true);
    provider.simulateDisconnect();

    await expect(
      sendTemplateMessage(sdb, provider, baseInput(customerId)),
    ).rejects.toThrow(/desconectad/i);

    const messages = await getMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].status).toBe("failed");
    expect(messages[0].errorDetail).toMatch(/desconectad/i);
    expect(messages[0].zapiMessageId).toBeNull();
  });

  it("retomada: failed → queued → sent na retentativa (mesma linha, sem duplicar)", async () => {
    await enableWa();
    await seedTemplates();
    const customerId = await createCustomer(true);

    provider.simulateDisconnect();
    await expect(
      sendTemplateMessage(sdb, provider, baseInput(customerId)),
    ).rejects.toThrow();

    provider.simulateReconnect();
    const retry = await sendTemplateMessage(sdb, provider, baseInput(customerId));
    expect(retry).toMatchObject({ sent: true });

    const messages = await getMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].status).toBe("sent");
    expect(messages[0].errorDetail).toBeNull();
    expect(provider.sentMessages).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// sendToOwner
// ---------------------------------------------------------------------------

describe("sendToOwner", () => {
  it("sem owner_whatsapp_phone → { skipped: 'sem_telefone_dono' }", async () => {
    await enableWa();
    await seedTemplates();

    const result = await sendToOwner(sdb, provider, {
      templateKey: "owner_new_order",
      vars: { pedido: "1000", cliente: "Maria da Silva", total: "R$ 119,70" },
      dedupeKey: "wa.owner_new:teste",
    });

    expect(result).toEqual({ skipped: "sem_telefone_dono" });
    expect(await getMessages()).toHaveLength(0);
  });

  it("com telefone do dono: envia SEM exigir opt-in nem cliente", async () => {
    await enableWa();
    await seedTemplates();
    await setOwnerPhone();

    const result = await sendToOwner(sdb, provider, {
      templateKey: "owner_new_order",
      vars: { pedido: "1000", cliente: "Maria da Silva", total: "R$ 119,70" },
      dedupeKey: "wa.owner_new:teste",
    });

    expect(result).toMatchObject({ sent: true });
    expect(provider.sentMessages).toHaveLength(1);
    expect(provider.sentMessages[0].toE164).toBe(OWNER_PHONE);
    expect(provider.sentMessages[0].body).toContain("Maria da Silva");

    const [message] = await getMessages();
    expect(message.status).toBe("sent");
  });

  it("corpo avulso (bodyOverride) também sai para o dono", async () => {
    await enableWa();
    await setOwnerPhone();

    const result = await sendToOwner(sdb, provider, {
      bodyOverride: '💬 Maria respondeu: "Chega amanhã?"',
      dedupeKey: "wa.owner_forward:teste",
    });

    expect(result).toMatchObject({ sent: true });
    expect(provider.sentMessages[0].body).toContain("Chega amanhã?");
  });
});

// ---------------------------------------------------------------------------
// recoverUnpaidOrders — UMA única mensagem por pedido, jamais segunda cobrança
// ---------------------------------------------------------------------------

describe("recoverUnpaidOrders", () => {
  it("envia UMA mensagem por pedido elegível, mesmo rodando duas vezes", async () => {
    await enableWa();
    await seedTemplates();
    const customerId = await createCustomer(true);
    const order = await createStoreOrder(customerId);

    const first = await recoverUnpaidOrders(sdb, provider);
    expect(first).toEqual({ checked: 1, sent: 1, skipped: 0, failed: 0 });

    const second = await recoverUnpaidOrders(sdb, provider);
    expect(second).toEqual({ checked: 1, sent: 0, skipped: 1, failed: 0 });

    const messages = await getMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].dedupeKey).toBe(`wa.recovery:${order.id}`);
    expect(messages[0].orderId).toBe(order.id);
    expect(messages[0].body).toContain(`#${order.orderNumber}`);
    expect(provider.sentMessages).toHaveLength(1);

    // Audit da recuperação gravado 1x.
    const audits = await db
      .select()
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.action, "wa.recovery"),
          eq(schema.auditLog.entityId, order.id),
        ),
      );
    expect(audits).toHaveLength(1);
  });

  it("sem opt-in → não envia (skipped) e nada é gravado", async () => {
    await enableWa();
    await seedTemplates();
    const customerId = await createCustomer(false);
    await createStoreOrder(customerId);

    const result = await recoverUnpaidOrders(sdb, provider);

    expect(result).toEqual({ checked: 1, sent: 0, skipped: 1, failed: 0 });
    expect(await getMessages()).toHaveLength(0);
    expect(provider.sentMessages).toHaveLength(0);
  });

  it("não cobra pedido já pago, recente demais, com reserva vencida ou de outro canal", async () => {
    await enableWa();
    await seedTemplates();
    const customerId = await createCustomer(true);
    await createStoreOrder(customerId, { status: "paid" });
    await createStoreOrder(customerId, {
      createdAt: new Date(Date.now() - 10 * 60_000), // só 10 min
    });
    await createStoreOrder(customerId, {
      paymentDueAt: new Date(Date.now() - 5 * 60_000), // reserva vencida
    });
    await createStoreOrder(customerId, { channel: "manual" });

    const result = await recoverUnpaidOrders(sdb, provider);

    expect(result).toEqual({ checked: 0, sent: 0, skipped: 0, failed: 0 });
    expect(provider.sentMessages).toHaveLength(0);
  });

  it("wa desligado → contadores zerados, nenhuma consulta de envio", async () => {
    await seedTemplates();
    const customerId = await createCustomer(true);
    await createStoreOrder(customerId);

    const result = await recoverUnpaidOrders(sdb, provider);

    expect(result).toEqual({ checked: 0, sent: 0, skipped: 0, failed: 0 });
    expect(provider.sentMessages).toHaveLength(0);
  });

  it("provider caído: conta failed e a rodada seguinte RETOMA (uma mensagem só)", async () => {
    await enableWa();
    await seedTemplates();
    const customerId = await createCustomer(true);
    await createStoreOrder(customerId);

    provider.simulateDisconnect();
    const down = await recoverUnpaidOrders(sdb, provider);
    expect(down).toEqual({ checked: 1, sent: 0, skipped: 0, failed: 1 });

    const afterFail = await getMessages();
    expect(afterFail).toHaveLength(1);
    expect(afterFail[0].status).toBe("failed");

    provider.simulateReconnect();
    const up = await recoverUnpaidOrders(sdb, provider);
    expect(up).toEqual({ checked: 1, sent: 1, skipped: 0, failed: 0 });

    const messages = await getMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].status).toBe("sent");
    expect(provider.sentMessages).toHaveLength(1);
  });
});
