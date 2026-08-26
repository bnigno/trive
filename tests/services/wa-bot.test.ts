// Turno do BOT DE VENDAS IA (Onda B): runBotTurn + executores de ferramentas
// com PGlite real, FakeSalesAssistant roteirizado e FakeMessagingProvider.
// Cobertura: turno simples, roteiro completo de venda (pedido channel
// 'whatsapp' com reserva e link), CPF inválido sem persistência, segurança do
// status_do_pedido, transferência para humano, skips e idempotência do reply.
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeSalesAssistant } from "@/adapters/assistant/fake";
import { FakeMessagingProvider } from "@/adapters/zapi/fake";
import * as schema from "@/db/schema";
import { formatCentsBRL } from "@/lib/money";
import type { DbOrTx } from "@/queue/enqueue";
import {
  createStoreOrder,
  type CreateStoreOrderInput,
} from "@/services/store-orders";
import {
  buildToolExecutor,
  HANDOFF_COURTESY_REPLY,
  isBotEnabled,
  runBotTurn,
} from "@/services/wa-bot";
import { createTestDb, createTestVariant, type TestDb } from "../helpers/db";

let db: TestDb;
let close: () => Promise<void>;
// PGlite (testes) e postgres-js (produção) divergem apenas no tipo de
// retorno de execute(); a API drizzle usada pelos serviços é idêntica.
let sdb: DbOrTx;
let assistant: FakeSalesAssistant;
let provider: FakeMessagingProvider;

const PHONE = "+5511999998888";
const OTHER_PHONE = "+5521977776666";
const VALID_CPF = "52998224725";
const VALID_CPF_2 = "16899535009";

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  sdb = db as unknown as DbOrTx;
  assistant = new FakeSalesAssistant();
  provider = new FakeMessagingProvider();
  // Modo fake: isWaEnabled/isBotEnabled não exigem credenciais no ambiente.
  vi.stubEnv("ADAPTER_MODE", "fake");
  await db.insert(schema.settings).values([
    { key: "wa_enabled", value: true },
    { key: "bot_enabled", value: true },
  ]);
});

afterEach(async () => {
  await close();
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// Fixtures (padrão de tests/services/store-orders.test.ts)
// ---------------------------------------------------------------------------

async function activatePrice(variantId: string, priceCents: number): Promise<void> {
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

async function createRate(): Promise<{ id: string; priceCents: number }> {
  const [rate] = await db
    .insert(schema.shippingRates)
    .values({ name: "PAC", priceCents: 1990 })
    .returning({
      id: schema.shippingRates.id,
      priceCents: schema.shippingRates.priceCents,
    });
  return rate;
}

/** Vitrine pronta: variante ativa com preço, estoque e uma opção de frete. */
async function setupStore(
  opts: { onHand?: number; priceCents?: number } = {},
): Promise<{ variantId: string }> {
  const { variantId } = await createTestVariant(db, {
    sku: "CANECA-AZUL",
    costCents: 1200,
    onHand: opts.onHand ?? 10,
    name: "Caneca Azul",
  });
  await activatePrice(variantId, opts.priceCents ?? 4990);
  await createRate();
  return { variantId };
}

async function createConversation(
  phoneE164 = PHONE,
  opts: { status?: string; customerId?: string | null } = {},
): Promise<string> {
  const [conversation] = await db
    .insert(schema.waConversations)
    .values({
      phoneE164,
      status: opts.status ?? "open",
      customerId: opts.customerId ?? null,
    })
    .returning({ id: schema.waConversations.id });
  return conversation.id;
}

let inboundSequence = 0;

async function addInbound(conversationId: string, body: string): Promise<string> {
  inboundSequence += 1;
  const [message] = await db
    .insert(schema.waMessages)
    .values({
      conversationId,
      direction: "inbound",
      zapiMessageId: `MSG-IN-${inboundSequence}-${Math.random().toString(36).slice(2, 8)}`,
      body,
      status: "delivered",
      deliveredAt: new Date(),
      // createdAt crescente para o histórico/última-inbound serem determinísticos.
      createdAt: new Date(Date.now() - 60_000 + inboundSequence * 1000),
    })
    .returning({ id: schema.waMessages.id });
  return message.id;
}

function baseStoreOrderInput(
  variantId: string,
  shippingRateId: string,
  over: Partial<CreateStoreOrderInput> = {},
): CreateStoreOrderInput {
  return {
    customer: {
      fullName: "Maria da Silva",
      document: VALID_CPF,
      phone: PHONE,
      marketingOptIn: true,
    },
    address: {
      postalCode: "01310100",
      street: "Avenida Paulista",
      number: "1000",
      district: "Bela Vista",
      city: "São Paulo",
      state: "SP",
    },
    items: [{ variantId, quantity: 1, expectedUnitPriceCents: 4990 }],
    shippingRateId,
    expectedShippingCents: 1990,
    ...over,
  };
}

async function outboundMessages(conversationId: string) {
  return db
    .select()
    .from(schema.waMessages)
    .where(
      and(
        eq(schema.waMessages.conversationId, conversationId),
        eq(schema.waMessages.direction, "outbound"),
      ),
    );
}

// ---------------------------------------------------------------------------
// isBotEnabled
// ---------------------------------------------------------------------------

describe("isBotEnabled", () => {
  it("exige bot_enabled E wa_enabled; em modo fake dispensa a API key", async () => {
    expect(await isBotEnabled(sdb)).toBe(true);

    await db
      .update(schema.settings)
      .set({ value: false })
      .where(eq(schema.settings.key, "bot_enabled"));
    expect(await isBotEnabled(sdb)).toBe(false);

    await db
      .update(schema.settings)
      .set({ value: true })
      .where(eq(schema.settings.key, "bot_enabled"));
    await db
      .update(schema.settings)
      .set({ value: false })
      .where(eq(schema.settings.key, "wa_enabled"));
    expect(await isBotEnabled(sdb)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runBotTurn
// ---------------------------------------------------------------------------

describe("runBotTurn", () => {
  it("turno simples: responde a última inbound e grava a outbound como sent", async () => {
    const conversationId = await createConversation();
    await addInbound(conversationId, "Oi, tudo bem?");
    assistant.enqueueScript({ replyTemplate: "Olá! Como posso ajudar? 😊" });

    const result = await runBotTurn(sdb, assistant, provider, { conversationId });

    expect(result).toEqual({ replied: true, handedOff: false });
    expect(provider.sentMessages).toHaveLength(1);
    expect(provider.sentMessages[0].toE164).toBe(PHONE);
    expect(provider.sentMessages[0].body).toBe("Olá! Como posso ajudar? 😊");

    const outbound = await outboundMessages(conversationId);
    expect(outbound).toHaveLength(1);
    expect(outbound[0].status).toBe("sent");
    expect(outbound[0].body).toBe("Olá! Como posso ajudar? 😊");
    expect(outbound[0].dedupeKey).toMatch(/^wa\.bot_reply:/);
  });

  it("roteiro completo: listar → detalhar → criar_pedido cria pedido 'whatsapp' com reserva e link", async () => {
    const { variantId } = await setupStore();
    const conversationId = await createConversation();
    await addInbound(conversationId, "Quero 2 canecas azuis");

    assistant.enqueueScript({
      toolCalls: [
        { name: "listar_produtos", input: {} },
        { name: "detalhar_produto", input: { produto: "Caneca Azul" } },
        {
          name: "criar_pedido",
          input: {
            itens: [{ sku: "CANECA-AZUL", quantidade: 2 }],
            nome_completo: "Maria da Silva",
            cpf: VALID_CPF,
            cep: "01310100",
            rua: "Avenida Paulista",
            numero: "1000",
            bairro: "Bela Vista",
            cidade: "São Paulo",
            uf: "SP",
          },
        },
      ],
      // O resumo oficial de criar_pedido é retransmitido como veio.
      replyTemplate: (toolTexts) => toolTexts[toolTexts.length - 1],
    });

    const result = await runBotTurn(sdb, assistant, provider, { conversationId });
    expect(result).toEqual({ replied: true, handedOff: false });

    const turn = assistant.turns[0];
    expect(turn.toolCalls.map((c) => c.ok)).toEqual([true, true, true]);
    // detalhar_produto devolve SKU, preço EXATO e disponibilidade.
    expect(turn.toolCalls[1].name).toBe("detalhar_produto");

    const [order] = await db.select().from(schema.orders);
    expect(order.channel).toBe("whatsapp");
    expect(order.status).toBe("pending_payment");
    expect(order.subtotalCents).toBe(2 * 4990);
    expect(order.shippingCents).toBe(1990);
    expect(order.totalCents).toBe(2 * 4990 + 1990);

    // Reserva de estoque feita (draft→pending_payment).
    const [level] = await db
      .select()
      .from(schema.stockLevels)
      .where(eq(schema.stockLevels.productVariantId, variantId));
    expect(level.reserved).toBe(2);

    // Resposta enviada contém o resumo oficial com o link público do pedido.
    const body = provider.sentMessages[0].body;
    expect(body).toContain(`Pedido #${order.orderNumber}`);
    expect(body).toContain(`2× Caneca Azul`);
    expect(body).toContain(formatCentsBRL(order.totalCents));
    expect(body).toContain(`/pedido/${order.publicToken}`);

    // Cliente do pedido vinculado à conversa; telefone é o da conversa.
    const [conversation] = await db
      .select()
      .from(schema.waConversations)
      .where(eq(schema.waConversations.id, conversationId));
    expect(conversation.customerId).toBe(order.customerId);
    const [customer] = await db
      .select()
      .from(schema.customers)
      .where(eq(schema.customers.id, order.customerId));
    expect(customer.phoneE164).toBe(PHONE);
  });

  it("criar_pedido com CPF inválido: ok:false e NADA persistido", async () => {
    await setupStore();
    const conversationId = await createConversation();
    await addInbound(conversationId, "Fecha o pedido");

    assistant.enqueueScript({
      toolCalls: [
        {
          name: "criar_pedido",
          input: {
            itens: [{ sku: "CANECA-AZUL", quantidade: 1 }],
            nome_completo: "Maria da Silva",
            // 11 dígitos repetidos: passa no formato, falha no dígito verificador.
            cpf: "11111111111",
            cep: "01310100",
            rua: "Avenida Paulista",
            numero: "1000",
            bairro: "Bela Vista",
            cidade: "São Paulo",
            uf: "SP",
          },
        },
      ],
      replyTemplate: (toolTexts) => toolTexts[0],
    });

    const result = await runBotTurn(sdb, assistant, provider, { conversationId });
    expect(result).toEqual({ replied: true, handedOff: false });

    const turn = assistant.turns[0];
    expect(turn.toolCalls[0].ok).toBe(false);
    expect(provider.sentMessages[0].body).toContain("CPF inválido");

    // Nenhum pedido, cliente ou movimento de estoque foi criado.
    expect(await db.select().from(schema.orders)).toHaveLength(0);
    expect(await db.select().from(schema.customers)).toHaveLength(0);
    expect(await db.select().from(schema.stockMovements)).toHaveLength(0);
  });

  it("transferir_para_atendente: marca human + audit + aviso ao dono e PARA o turno", async () => {
    const before = Date.now();
    const conversationId = await createConversation();
    await addInbound(conversationId, "Quero falar com uma pessoa");

    assistant.enqueueScript({
      toolCalls: [
        {
          name: "transferir_para_atendente",
          input: { motivo: "cliente pediu atendimento humano" },
        },
        // NUNCA deve executar: endsTurn interrompe o roteiro.
        { name: "listar_produtos", input: {} },
      ],
      replyTemplate: "Vou te passar para um atendente 😉",
    });

    const result = await runBotTurn(sdb, assistant, provider, { conversationId });
    expect(result).toEqual({ replied: true, handedOff: true });

    // O turno parou na transferência (a segunda ferramenta não rodou).
    expect(assistant.turns[0].toolCalls).toHaveLength(1);

    const [conversation] = await db
      .select()
      .from(schema.waConversations)
      .where(eq(schema.waConversations.id, conversationId));
    expect(conversation.status).toBe("human");
    expect(conversation.botDisabledUntil).not.toBeNull();
    const silenceMs = conversation.botDisabledUntil!.getTime() - before;
    expect(silenceMs).toBeGreaterThan(23 * 60 * 60_000);
    expect(silenceMs).toBeLessThan(25 * 60 * 60_000);

    const audits = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "wa.bot_handoff"));
    expect(audits).toHaveLength(1);
    expect(audits[0].entityId).toBe(conversationId);
    expect(audits[0].reason).toBe("cliente pediu atendimento humano");

    const forwards = await db
      .select()
      .from(schema.outboxEvents)
      .where(eq(schema.outboxEvents.eventType, "wa.owner_forward"));
    expect(forwards).toHaveLength(1);
    // raw: true — o aviso já chega formatado e o handler NÃO deve embrulhá-lo
    // como fala de cliente ('💬 X respondeu: …').
    expect(forwards[0].payload).toMatchObject({ phoneE164: PHONE, raw: true });
    expect(String((forwards[0].payload as { body: string }).body)).toContain(
      "cliente pediu atendimento humano",
    );
    expect(String((forwards[0].payload as { body: string }).body)).toContain(
      "🤖→👤",
    );

    // Resposta do turno + mensagem de cortesia da transferência.
    const bodies = provider.sentMessages.map((m) => m.body);
    expect(bodies).toContain("Vou te passar para um atendente 😉");
    expect(bodies).toContain(HANDOFF_COURTESY_REPLY);
  });

  it("conversa 'human' → skipped, sem nenhuma mensagem", async () => {
    const conversationId = await createConversation(PHONE, { status: "human" });
    await addInbound(conversationId, "Oi?");
    assistant.enqueueScript({ replyTemplate: "não deve sair" });

    const result = await runBotTurn(sdb, assistant, provider, { conversationId });

    expect(result).toEqual({ skipped: "atendimento_humano" });
    expect(provider.sentMessages).toHaveLength(0);
    expect(assistant.turns).toHaveLength(0);
  });

  it("bot desligado (bot_enabled false) → skipped 'desabilitado'", async () => {
    await db
      .update(schema.settings)
      .set({ value: false })
      .where(eq(schema.settings.key, "bot_enabled"));
    const conversationId = await createConversation();
    await addInbound(conversationId, "Oi?");

    const result = await runBotTurn(sdb, assistant, provider, { conversationId });

    expect(result).toEqual({ skipped: "desabilitado" });
    expect(provider.sentMessages).toHaveLength(0);
  });

  it("idempotência: mesma última inbound não gera segunda resposta (ja_enviado)", async () => {
    const conversationId = await createConversation();
    await addInbound(conversationId, "Oi!");

    assistant.enqueueScript({ replyTemplate: "Primeira resposta" });
    const first = await runBotTurn(sdb, assistant, provider, { conversationId });
    expect(first).toEqual({ replied: true, handedOff: false });

    // Retry do evento da fila: mesma conversa, mesma última inbound.
    assistant.enqueueScript({ replyTemplate: "Segunda resposta (não deve sair)" });
    const second = await runBotTurn(sdb, assistant, provider, { conversationId });
    expect(second).toEqual({ replied: false, handedOff: false });

    expect(provider.sentMessages).toHaveLength(1);
    expect(provider.sentMessages[0].body).toBe("Primeira resposta");
    expect(await outboundMessages(conversationId)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Executores direto (segurança e frete estimado)
// ---------------------------------------------------------------------------

describe("buildToolExecutor", () => {
  it("status_do_pedido NUNCA vaza pedido de outro cliente", async () => {
    const { variantId } = await setupStore({ onHand: 10 });
    const [rate] = await db.select().from(schema.shippingRates);

    // Pedido do cliente A (telefone PHONE).
    const orderA = await createStoreOrder(
      sdb,
      baseStoreOrderInput(variantId, rate.id),
    );
    // Cliente B com outro telefone e outro CPF.
    await createStoreOrder(
      sdb,
      baseStoreOrderInput(variantId, rate.id, {
        customer: {
          fullName: "José Pereira",
          document: VALID_CPF_2,
          phone: OTHER_PHONE,
          marketingOptIn: true,
        },
      }),
    );

    const conversationB = await createConversation(OTHER_PHONE);
    const executorB = buildToolExecutor(sdb, {
      conversationId: conversationB,
      phoneE164: OTHER_PHONE,
      customerId: null,
    });

    // B pergunta pelo NÚMERO do pedido de A: nada é revelado.
    const leaked = await executorB("status_do_pedido", {
      numero_do_pedido: orderA.orderNumber,
    });
    expect(leaked.ok).toBe(false);
    expect(leaked.text).not.toContain(orderA.publicToken);
    expect(leaked.text).toContain(`#${orderA.orderNumber}`);

    // Sem número, B recebe o próprio pedido mais recente (nunca o de A).
    const own = await executorB("status_do_pedido", {});
    expect(own.ok).toBe(true);
    expect(own.text).toContain("aguardando pagamento");
    expect(own.text).not.toContain(orderA.publicToken);

    // Conversa sem cliente e sem pedidos: aviso gentil.
    const conversationC = await createConversation("+5531988887777");
    const executorC = buildToolExecutor(sdb, {
      conversationId: conversationC,
      phoneE164: "+5531988887777",
      customerId: null,
    });
    const none = await executorC("status_do_pedido", {});
    expect(none.ok).toBe(false);
  });

  it("cotar_frete sem carrinho: estimativa honesta de 1 item e lastQuotes salvo", async () => {
    await setupStore();
    const conversationId = await createConversation();
    const executor = buildToolExecutor(sdb, {
      conversationId,
      phoneE164: PHONE,
      customerId: null,
    });

    const result = await executor("cotar_frete", { cep: "01310100" });
    expect(result.ok).toBe(true);
    expect(result.text).toContain("PAC");
    expect(result.text).toContain(formatCentsBRL(1990));
    expect(result.text).toContain("Estimativa para 1 item");

    const [conversation] = await db
      .select()
      .from(schema.waConversations)
      .where(eq(schema.waConversations.id, conversationId));
    const state = conversation.botState as { lastQuotes?: { name: string }[] };
    expect(state.lastQuotes).toHaveLength(1);
    expect(state.lastQuotes![0].name).toBe("PAC");
  });

  it("input inválido é recusado antes de qualquer efeito", async () => {
    const conversationId = await createConversation();
    const executor = buildToolExecutor(sdb, {
      conversationId,
      phoneE164: PHONE,
      customerId: null,
    });

    const result = await executor("cotar_frete", { cep: "013" });
    expect(result.ok).toBe(false);
    expect(result.text).toContain("Dados inválidos");
  });
});
