// Turno do BOT DE VENDAS IA (Onda B): runBotTurn + executores de ferramentas
// com PGlite real, FakeSalesAssistant roteirizado e FakeMessagingProvider.
// Cobertura: turno simples, roteiro completo de venda (pedido channel
// 'whatsapp' com reserva e link), CPF inválido sem persistência, segurança do
// status_do_pedido, transferência para humano, skips, idempotência do reply e
// mídia do turno (menu interativo de listar_produtos, foto de
// detalhar_produto, melhor esforço e dedupe do retry).
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
  historyTextFor,
  isBotEnabled,
  runBotTurn,
} from "@/services/wa-bot";
import { createTestDb, createTestVariant, type TestDb } from "../helpers/db";
import { nextMessageStamp } from "../helpers/clock";

// Kicks para o Inngest: o turno dá um (sem id) depois do commit, para o que
// enfileirou (cartão, aviso ao dono) sair em segundos; turno pulado não dá.
const { kicks } = vi.hoisted(() => ({ kicks: [] as unknown[] }));
vi.mock("@/inngest/client", () => ({ inngest: { send: async (event: unknown) => { kicks.push(event); return { ids: [] }; } } }));

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
// Executor chamado direto (sem turno): qualquer id serve para os dedupes.
const DUMMY_INBOUND_ID = "00000000-0000-4000-8000-00000000feed";
const PIX_KEY = "pix@trive.com.br";

beforeEach(async () => {
  kicks.length = 0;
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
): Promise<{ productId: string; variantId: string }> {
  const { productId, variantId } = await createTestVariant(db, {
    sku: "CANECA-AZUL",
    costCents: 1200,
    onHand: opts.onHand ?? 10,
    name: "Caneca Azul",
  });
  await activatePrice(variantId, opts.priceCents ?? 4990);
  await createRate();
  return { productId, variantId };
}

/** Variante com atributos (cor/tamanho), estoque e preço ativo. */
async function createAttributedVariant(
  productId: string,
  sku: string,
  attributes: Record<string, string>,
  onHand: number,
  priceCents = 8990,
): Promise<string> {
  const [variant] = await db
    .insert(schema.productVariants)
    .values({ productId, sku, attributes, costCents: 3000 })
    .returning({ id: schema.productVariants.id });
  await db.insert(schema.stockLevels).values({
    productVariantId: variant.id,
    onHand,
    reserved: 0,
  });
  await activatePrice(variant.id, priceCents);
  return variant.id;
}

/**
 * Produto de DOIS eixos (cor × tamanho) — o caso que nenhum teste do bot
 * cobria: 5 combinações, uma esgotada, todas ao mesmo preço.
 */
async function setupPolo(): Promise<{ productId: string }> {
  const [product] = await db
    .insert(schema.products)
    .values({
      name: "Camisa Polo",
      slug: "camisa-polo",
      status: "active",
      attributesSchema: ["cor", "tamanho"],
    })
    .returning({ id: schema.products.id });
  await createAttributedVariant(product.id, "POLO-VD-P", { cor: "Verde", tamanho: "P" }, 3);
  await createAttributedVariant(product.id, "POLO-VD-G", { cor: "Verde", tamanho: "G" }, 2);
  await createAttributedVariant(product.id, "POLO-AM-M", { cor: "Amarelo", tamanho: "M" }, 1);
  await createAttributedVariant(product.id, "POLO-AM-G", { cor: "Amarelo", tamanho: "G" }, 0);
  await createAttributedVariant(product.id, "POLO-PT-P", { cor: "Preto", tamanho: "P" }, 4);
  await createRate();
  return { productId: product.id };
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

async function addInbound(conversationId: string, body: string, opts: { kind?: "text" | "audio"; mediaMeta?: unknown } = {}): Promise<string> {
  inboundSequence += 1;
  const [message] = await db
    .insert(schema.waMessages)
    .values({
      conversationId,
      direction: "inbound",
      ...(opts.kind ? { kind: opts.kind } : {}),
      ...(opts.mediaMeta !== undefined ? { mediaMeta: opts.mediaMeta } : {}),
      zapiMessageId: `MSG-IN-${inboundSequence}-${Math.random().toString(36).slice(2, 8)}`,
      body,
      status: "delivered",
      deliveredAt: new Date(),
      // createdAt crescente para o histórico/última-inbound serem determinísticos.
      createdAt: nextMessageStamp(),
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
    // "Digitando…" curto antes do balão; ✓✓ azul na mensagem dela.
    expect(provider.sentMessages[0].typingSeconds).toBe(1);
    const [inbound] = await db.select({ zapiMessageId: schema.waMessages.zapiMessageId }).from(schema.waMessages).where(eq(schema.waMessages.direction, "inbound"));
    expect(provider.readReceipts).toEqual([{ fromE164: PHONE, providerMessageId: inbound.zapiMessageId }]);

    const outbound = await outboundMessages(conversationId);
    expect(outbound).toHaveLength(1);
    expect(outbound[0].status).toBe("sent");
    expect(outbound[0].body).toBe("Olá! Como posso ajudar? 😊");
    expect(outbound[0].dedupeKey).toMatch(/^wa\.bot_reply:/);
    // Um kick depois do commit (sem id).
    expect(kicks).toEqual([{ name: "outbox/event.enqueued", data: {} }]);
  });

  it("responde mesmo se a consulta de número disser que ele não tem WhatsApp (ela acabou de escrever); balões seguintes com mais 'digitando'", async () => {
    const conversationId = await createConversation();
    await addInbound(conversationId, "Oi!");
    provider.setPhoneExists(PHONE, false);
    assistant.enqueueScript({
      // 1º balão com > 80 caracteres: teto de 1 s (first); o 2º, longo, 2 s (next).
      replyTemplate: "Oi! Que bom te ver por aqui — me conta o que você procura, a ocasião e o seu tamanho que eu separo as opções certas.\n---\n" + "Temos vestidos, blusas e saias — me conta o que você procura, a ocasião e o seu tamanho, que eu separo as opções certas para você. ".repeat(2),
    });
    const result = await runBotTurn(sdb, assistant, provider, { conversationId });
    expect(result).toEqual({ replied: true, handedOff: false });
    expect(provider.sentMessages).toHaveLength(2);
    expect(provider.sentMessages[0].typingSeconds).toBe(1);
    expect(provider.sentMessages[1].typingSeconds).toBe(2);
  });

  it("roteiro completo: listar → detalhar → criar_pedido cria pedido 'whatsapp' com reserva e link", async () => {
    const { variantId } = await setupStore();
    const conversationId = await createConversation();
    await addInbound(conversationId, "Quero 2 canecas azuis");

    assistant.enqueueScript({
      toolCalls: [
        { name: "listar_produtos", input: {} },
        { name: "detalhar_produto", input: { produto: "Caneca Azul" } },
        { name: "cotar_frete", input: { cep: "01310100" } },
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
    expect(turn.toolCalls.map((c) => c.ok)).toEqual([true, true, true, true]);
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

  it("transferir_para_atendente: o silêncio vem de handoff_silence_hours (2 h) e fica no audit", async () => {
    await db.insert(schema.settings).values({ key: "handoff_silence_hours", value: 2 });
    const before = Date.now();
    const conversationId = await createConversation();
    await addInbound(conversationId, "Quero falar com uma pessoa");
    assistant.enqueueScript({
      toolCalls: [{ name: "transferir_para_atendente", input: { motivo: "pediu uma pessoa" } }],
      replyTemplate: "Já chamo a equipe!",
    });
    await runBotTurn(sdb, assistant, provider, { conversationId });
    const [conversation] = await db
      .select()
      .from(schema.waConversations)
      .where(eq(schema.waConversations.id, conversationId));
    const silenceMs = conversation.botDisabledUntil!.getTime() - before;
    expect(silenceMs).toBeGreaterThan(1.9 * 60 * 60_000);
    expect(silenceMs).toBeLessThan(2.1 * 60 * 60_000);
    const [audit] = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "wa.bot_handoff"));
    expect(audit.after).toMatchObject({ silenceHours: 2 });
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

  it("conversa 'human' → skipped, sem nenhuma mensagem — e a mensagem dela que ficou sem resposta vai ao dono (como o webhook faria), sem duplicar", async () => {
    const conversationId = await createConversation(PHONE, { status: "human" });
    const inboundId = await addInbound(conversationId, "Oi?");
    assistant.enqueueScript({ replyTemplate: "não deve sair" });

    const result = await runBotTurn(sdb, assistant, provider, { conversationId });

    expect(result).toMatchObject({ skipped: "atendimento_humano" });
    expect(provider.sentMessages).toHaveLength(0);
    expect(assistant.turns).toHaveLength(0);
    // O turno foi enfileirado com a foto de ANTES da transferência: quem leva a mensagem ao dono é ele — com kick.
    const [inbound] = await db.select({ zapiMessageId: schema.waMessages.zapiMessageId }).from(schema.waMessages).where(eq(schema.waMessages.id, inboundId));
    const forwards = await db.select().from(schema.outboxEvents).where(eq(schema.outboxEvents.eventType, "wa.owner_forward"));
    expect(forwards).toHaveLength(1);
    expect(forwards[0]).toMatchObject({ dedupeKey: `wa.fwd:${inbound.zapiMessageId}`, payload: { phoneE164: PHONE, body: "Oi?" } });
    expect(result).toEqual({ skipped: "atendimento_humano", forwarded: [forwards[0].id] });
    expect(kicks.at(-1)).toEqual({ name: "outbox/event.enqueued", data: { outboxEventId: forwards[0].id } });
    // Rodar de novo (retry da fila) não duplica o encaminhamento; áudio ainda em transcrição fica para a transcrição.
    await addInbound(conversationId, "[a cliente enviou um áudio]", { kind: "audio", mediaMeta: { transcript: { status: "pending" } } });
    const again = await runBotTurn(sdb, assistant, provider, { conversationId });
    expect(again).toEqual({ skipped: "atendimento_humano", forwarded: [] });
    expect(await db.select().from(schema.outboxEvents).where(eq(schema.outboxEvents.eventType, "wa.owner_forward"))).toHaveLength(1);
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

  it("idempotência: mesma última inbound não gera segunda resposta (já respondida, sem rodar o modelo)", async () => {
    const conversationId = await createConversation();
    await addInbound(conversationId, "Oi!");

    assistant.enqueueScript({ replyTemplate: "Primeira resposta" });
    const first = await runBotTurn(sdb, assistant, provider, { conversationId });
    expect(first).toEqual({ replied: true, handedOff: false });

    // Retry do evento da fila (ou o evento da mensagem seguinte da rajada):
    // mesma conversa, tudo respondido — o modelo não roda de novo.
    assistant.enqueueScript({ replyTemplate: "Segunda resposta (não deve sair)" });
    const second = await runBotTurn(sdb, assistant, provider, { conversationId });
    expect(second).toEqual({ skipped: "ja_respondida" });
    expect(assistant.turns).toHaveLength(1);
    // Turno pulado não dá kick: só o do primeiro turno.
    expect(kicks).toHaveLength(1);

    expect(provider.sentMessages).toHaveLength(1);
    expect(provider.sentMessages[0].body).toBe("Primeira resposta");
    expect(await outboundMessages(conversationId)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Mídia do turno: menu interativo (listar_produtos) e foto (detalhar_produto)
// ---------------------------------------------------------------------------

/** Sufixo numérico da sequência única do fake — permite afirmar a ORDEM de envio. */
function providerSequence(providerMessageId: string): number {
  return Number(providerMessageId.split("-").at(-1));
}

class OptionListFailingProvider extends FakeMessagingProvider {
  override async sendOptionList(): Promise<never> {
    throw new Error("Z-API indisponível para mídia (stub)");
  }
}

describe("runBotTurn — mídia", () => {
  it("listar_produtos envia menu interativo DEPOIS do texto (a cliente sente a resposta primeiro) e persiste kind option_list", async () => {
    await setupStore();
    const conversationId = await createConversation();
    const inboundId = await addInbound(conversationId, "O que vocês vendem?");

    let toolText = "";
    assistant.enqueueScript({
      toolCalls: [{ name: "listar_produtos", input: {} }],
      replyTemplate: (toolTexts) => {
        toolText = toolTexts[0];
        return "Toque em Ver produtos 👇";
      },
    });

    const result = await runBotTurn(sdb, assistant, provider, { conversationId });
    expect(result).toEqual({ replied: true, handedOff: false });

    // O texto da ferramenta mantém os fatos e instrui a NÃO repetir a lista.
    expect(toolText).toContain("Caneca Azul");
    expect(toolText).toContain("[A lista tocável do catálogo foi enviada ao cliente");

    expect(provider.sentOptionLists).toHaveLength(1);
    const list = provider.sentOptionLists[0];
    expect(list.toE164).toBe(PHONE);
    expect(list.buttonLabel).toBe("Ver o catálogo");
    expect(list.title).toBe("Nossas peças");
    expect(list.options).toEqual([
      {
        id: "produto:caneca-azul",
        title: "Caneca Azul",
        description: formatCentsBRL(4990),
      },
    ]);

    // O texto da IA saiu antes do menu.
    expect(provider.sentMessages).toHaveLength(1);
    expect(providerSequence(list.providerMessageId)).toBeGreaterThan(
      providerSequence(provider.sentMessages[0].providerMessageId),
    );

    const outbound = await outboundMessages(conversationId);
    expect(outbound).toHaveLength(2);
    const media = outbound.find((m) => m.kind === "option_list");
    expect(media?.status).toBe("sent");
    expect(media?.dedupeKey).toBe(`wa.bot_media:${inboundId}:0`);
    expect(media?.body).toContain("Caneca Azul");
    const text = outbound.find((m) => m.kind === "text");
    expect(text?.body).toBe("Toque em Ver produtos 👇");
  });

  it("detalhar_produto com imagem envia a foto com legenda 'nome — preço'", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://x.supabase.co");
    const { productId } = await setupStore();
    await db.insert(schema.productImages).values({
      productId,
      storagePath: "caneca-azul/1-full.webp",
      sortOrder: 0,
    });
    const conversationId = await createConversation();
    const inboundId = await addInbound(conversationId, "Me mostra a caneca azul");

    let toolText = "";
    assistant.enqueueScript({
      toolCalls: [{ name: "detalhar_produto", input: { produto: "Caneca Azul" } }],
      replyTemplate: (toolTexts) => {
        toolText = toolTexts[0];
        return "Olha só que linda! 😍";
      },
    });

    const result = await runBotTurn(sdb, assistant, provider, { conversationId });
    expect(result).toEqual({ replied: true, handedOff: false });

    expect(toolText).toContain("[A foto da peça foi enviada ao cliente.]");

    const expectedUrl =
      "https://x.supabase.co/storage/v1/object/public/product-images/caneca-azul/1-full.webp";
    expect(provider.sentImages).toHaveLength(1);
    expect(provider.sentImages[0].imageUrl).toBe(expectedUrl);
    expect(provider.sentImages[0].caption).toBe(
      `Caneca Azul — ${formatCentsBRL(4990)}`,
    );

    const outbound = await outboundMessages(conversationId);
    const media = outbound.find((m) => m.kind === "image");
    expect(media?.status).toBe("sent");
    expect(media?.mediaUrl).toBe(expectedUrl);
    expect(media?.dedupeKey).toBe(`wa.bot_media:${inboundId}:0`);
  });

  it("detalhar_produto SEM imagem: nenhum attachment e texto normal", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://x.supabase.co");
    await setupStore();
    const conversationId = await createConversation();
    await addInbound(conversationId, "Me fala da caneca");

    let toolText = "";
    assistant.enqueueScript({
      toolCalls: [{ name: "detalhar_produto", input: { produto: "Caneca Azul" } }],
      replyTemplate: (toolTexts) => {
        toolText = toolTexts[0];
        return "Temos a Caneca Azul por R$ 49,90 😊";
      },
    });

    const result = await runBotTurn(sdb, assistant, provider, { conversationId });
    expect(result).toEqual({ replied: true, handedOff: false });

    expect(toolText).toContain("Caneca Azul");
    expect(toolText).not.toContain("[A foto do produto");
    expect(provider.sentImages).toHaveLength(0);

    const outbound = await outboundMessages(conversationId);
    expect(outbound).toHaveLength(1);
    expect(outbound[0].kind).toBe("text");
  });

  it("falha do provedor na mídia é melhor esforço: o texto da IA sai mesmo assim", async () => {
    const failing = new OptionListFailingProvider();
    await setupStore();
    const conversationId = await createConversation();
    const inboundId = await addInbound(conversationId, "produtos?");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      assistant.enqueueScript({
        toolCalls: [{ name: "listar_produtos", input: {} }],
        replyTemplate: "Temos canecas! 😊",
      });

      const result = await runBotTurn(sdb, assistant, failing, { conversationId });
      expect(result).toEqual({ replied: true, handedOff: false });

      expect(failing.sentOptionLists).toHaveLength(0);
      expect(failing.sentMessages).toHaveLength(1);
      expect(failing.sentMessages[0].body).toBe("Temos canecas! 😊");
      expect(warn).toHaveBeenCalled();

      // A linha de mídia fica 'failed' (visível no admin), sem derrubar o turno.
      const outbound = await outboundMessages(conversationId);
      const media = outbound.find((m) => m.kind === "option_list");
      expect(media?.status).toBe("failed");
      expect(media?.dedupeKey).toBe(`wa.bot_media:${inboundId}:0`);
      const text = outbound.find((m) => m.kind === "text");
      expect(text?.status).toBe("sent");
    } finally {
      warn.mockRestore();
    }
  });

  it("retry do turno: tudo respondido, o modelo não roda e mídia e texto não duplicam", async () => {
    await setupStore();
    const conversationId = await createConversation();
    await addInbound(conversationId, "produtos?");

    assistant.enqueueScript({
      toolCalls: [{ name: "listar_produtos", input: {} }],
      replyTemplate: "Toque em Ver produtos 👇",
    });
    const first = await runBotTurn(sdb, assistant, provider, { conversationId });
    expect(first).toEqual({ replied: true, handedOff: false });

    // Retry do evento da fila: mesma última inbound, já respondida (o
    // marcador é o dedupe da resposta) — o modelo nem roda.
    const second = await runBotTurn(sdb, assistant, provider, { conversationId });
    expect(second).toEqual({ skipped: "ja_respondida" });
    expect(assistant.turns).toHaveLength(1);

    expect(provider.sentOptionLists).toHaveLength(1);
    expect(provider.sentMessages).toHaveLength(1);
    // No banco: exatamente UMA linha de mídia e UMA de texto.
    expect(await outboundMessages(conversationId)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Variações: cor e tamanho (produto de DOIS eixos)
// ---------------------------------------------------------------------------

describe("runBotTurn — cor e tamanho", () => {
  /** Roda um turno com detalhar_produto e devolve o texto que a ferramenta deu ao modelo. */
  async function detalhar(
    conversationId: string,
    input: { produto: string; cor?: string },
  ): Promise<string> {
    let toolText = "";
    assistant.enqueueScript({
      toolCalls: [{ name: "detalhar_produto", input }],
      replyTemplate: (toolTexts) => {
        toolText = toolTexts[0];
        return "Que gosto bom! 😍";
      },
    });
    const result = await runBotTurn(sdb, assistant, provider, { conversationId });
    expect(result).toEqual({ replied: true, handedOff: false });
    return toolText;
  }

  it("lista agrupado por cor, com o preço uma vez só", async () => {
    await setupPolo();
    const conversationId = await createConversation();
    await addInbound(conversationId, "Me fala da camisa polo");

    const toolText = await detalhar(conversationId, { produto: "Camisa Polo" });

    expect(toolText).toContain("• Verde: P (3), G (2)");
    expect(toolText).toContain("• Amarelo: M (1), G (esgotado)");
    expect(toolText).toContain("• Preto: P (4)");
    expect(toolText).toContain(`Preço: ${formatCentsBRL(8990)}`);
    // Preço igual em todas as combinações aparece UMA vez, não cinco.
    expect(toolText.split(formatCentsBRL(8990))).toHaveLength(2);
    // O texto inteiro cabe folgado no limite do WhatsApp.
    expect(toolText.length).toBeLessThan(1200);
  });

  it("rótulo segue attributes_schema, não a ordem das chaves do jsonb", async () => {
    // Eixos declarados com o TAMANHO primeiro: o jsonb do Postgres reordena as
    // chaves ao gravar (por tamanho e depois byte a byte, logo "cor" primeiro),
    // então ler Object.values daria "Verde · P" — a ordem errada.
    const [product] = await db
      .insert(schema.products)
      .values({
        name: "Vestido Midi",
        slug: "vestido-midi",
        status: "active",
        attributesSchema: ["tamanho", "cor"],
      })
      .returning({ id: schema.products.id });
    await createAttributedVariant(
      product.id,
      "VEST-P-VD",
      { cor: "Verde", tamanho: "P" },
      3,
      12990,
    );
    await createAttributedVariant(
      product.id,
      "VEST-M-VD",
      // Ordem de inserção invertida de propósito.
      { tamanho: "M", cor: "Verde" },
      2,
      12990,
    );
    await createRate();

    const conversationId = await createConversation();
    await addInbound(conversationId, "Quero ver o vestido midi");
    const toolText = await detalhar(conversationId, { produto: "Vestido Midi" });

    expect(toolText).toContain("• P: Verde (3)");
    expect(toolText).toContain("• M: Verde (2)");
    expect(toolText).toContain("P · Verde=VEST-P-VD");
    expect(toolText).toContain("M · Verde=VEST-M-VD");
    expect(toolText).not.toContain("Verde · P");
    expect(toolText).not.toContain("Verde / P");
  });

  it("menu de variação sai com id 'variante:<sku>' dentro dos limites da Z-API", async () => {
    await setupPolo();
    const conversationId = await createConversation();
    const inboundId = await addInbound(conversationId, "Quero ver a polo");

    const toolText = await detalhar(conversationId, { produto: "Camisa Polo" });
    expect(toolText).toContain("[A lista tocável de cores e tamanhos foi enviada ao cliente");

    // Chegou ao provedor de verdade: passou pelo Zod de sendMediaMessage
    // (estourar 10 opções ou 24 caracteres de título faria o menu sumir).
    expect(provider.sentOptionLists).toHaveLength(1);
    const list = provider.sentOptionLists[0];
    expect(list.toE164).toBe(PHONE);
    expect(list.buttonLabel).toBe("Escolher cor/tamanho");
    expect(list.title).toBe("Camisa Polo");
    // Só as combinações COM estoque (POLO-AM-G está esgotada).
    expect(list.options.map((option) => option.id)).toEqual([
      "variante:POLO-VD-P",
      "variante:POLO-VD-G",
      "variante:POLO-AM-M",
      "variante:POLO-PT-P",
    ]);
    expect(list.options.length).toBeLessThanOrEqual(10);
    for (const option of list.options) {
      expect(option.id.length).toBeLessThanOrEqual(64);
      expect(option.title.length).toBeLessThanOrEqual(24);
      expect(option.title.length).toBeGreaterThan(0);
    }
    expect(list.options[0].title).toBe("Verde · P");

    const outbound = await outboundMessages(conversationId);
    const menu = outbound.find((message) => message.kind === "option_list");
    expect(menu?.status).toBe("sent");
    expect(menu?.dedupeKey).toBe(`wa.bot_media:${inboundId}:0`);
  });

  it("produto sem variação continua sem menu de variação", async () => {
    await setupStore();
    const conversationId = await createConversation();
    await addInbound(conversationId, "me fala da caneca");

    const toolText = await detalhar(conversationId, { produto: "Caneca Azul" });

    expect(toolText).toContain("SKU: CANECA-AZUL");
    expect(toolText).not.toContain("lista tocável de cores e tamanhos");
    expect(provider.sentOptionLists).toHaveLength(0);
  });

  it("manda a foto da cor escolhida; sem foto daquela cor, a genérica", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://x.supabase.co");
    const { productId } = await setupPolo();
    await db.insert(schema.productImages).values([
      { productId, storagePath: "polo/geral-full.webp", color: null, sortOrder: 0 },
      { productId, storagePath: "polo/verde-full.webp", color: "Verde", sortOrder: 1 },
      { productId, storagePath: "polo/amarelo-full.webp", color: "Amarelo", sortOrder: 2 },
    ]);
    const base = "https://x.supabase.co/storage/v1/object/public/product-images/";

    const conversationId = await createConversation();
    await addInbound(conversationId, "Tem essa polo amarela?");
    const toolText = await detalhar(conversationId, {
      produto: "Camisa Polo",
      cor: "Amarelo",
    });
    expect(toolText).toContain("[A foto de Amarelo foi enviada ao cliente.]");
    // Amarelo só tem o M disponível: a escolha está feita, sem lista — o SKU
    // vai explícito para o modelo seguir para a sacola.
    expect(toolText).toContain(
      "[Com a cor Amarelo, só existe uma combinação disponível: Amarelo · M = SKU POLO-AM-M.",
    );
    expect(provider.sentOptionLists).toHaveLength(0);

    expect(provider.sentImages).toHaveLength(1);
    expect(provider.sentImages[0].imageUrl).toBe(`${base}polo/amarelo-full.webp`);
    expect(provider.sentImages[0].caption).toContain("Camisa Polo (Amarelo)");

    // Sem cor: a lista completa de cores e tamanhos vai para a cliente.
    await addInbound(conversationId, "quais cores tem?");
    await detalhar(conversationId, { produto: "Camisa Polo" });
    expect(provider.sentOptionLists).toHaveLength(1);
    expect(provider.sentOptionLists[0].options).toHaveLength(4);

    // Toque na lista: o SKU chega no lugar do nome e a cor sai da variante.
    await addInbound(conversationId, "Escolhi esta opção: Verde · P (SKU POLO-VD-P).");
    await detalhar(conversationId, { produto: "POLO-VD-P" });
    expect(provider.sentImages[2].imageUrl).toBe(`${base}polo/verde-full.webp`);
    // Quem já escolheu a combinação não recebe a lista de novo.
    expect(provider.sentOptionLists).toHaveLength(1);

    // Verde tem P e G: a lista sai só com as opções daquela cor.
    await addInbound(conversationId, "e verde, tem que tamanho?");
    await detalhar(conversationId, { produto: "Camisa Polo", cor: "Verde" });
    expect(provider.sentOptionLists).toHaveLength(2);
    expect(provider.sentOptionLists[1].options.map((option) => option.title)).toEqual([
      "Verde · P",
      "Verde · G",
    ]);

    // Preto não tem foto própria: cai na genérica (color null).
    await addInbound(conversationId, "E na cor preta?");
    await detalhar(conversationId, { produto: "Camisa Polo", cor: "Preto" });
    expect(provider.sentImages[4].imageUrl).toBe(`${base}polo/geral-full.webp`);
  });

  it("criar_pedido de combinação esgotada diz QUAL combinação acabou", async () => {
    await setupPolo();
    const conversationId = await createConversation();
    const executor = buildToolExecutor(sdb, {
      conversationId,
      phoneE164: PHONE,
      customerId: null,
      lastInboundId: DUMMY_INBOUND_ID,
    });

    await executor("cotar_frete", { cep: "01310100" });
    const result = await executor("criar_pedido", {
      itens: [{ sku: "POLO-AM-G", quantidade: 1 }],
      nome_completo: "Maria da Silva",
      cpf: VALID_CPF,
      cep: "01310100",
      rua: "Avenida Paulista",
      numero: "1000",
      bairro: "Bela Vista",
      cidade: "São Paulo",
      uf: "SP",
    });

    expect(result.ok).toBe(false);
    expect(result.text).toContain('"Camisa Polo (Amarelo · G)"');
    expect(result.text).toContain("esgotou");
    expect(await db.select().from(schema.orders)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Pix manual (enviar_chave_pix), aviso ao dono (avisar_dono) e dinheiro na
// entrega (criar_pedido forma_de_pagamento)
// ---------------------------------------------------------------------------

describe("runBotTurn — enviar_chave_pix / avisar_dono / dinheiro na entrega", () => {
  async function setPixKey(value: string) {
    await db.insert(schema.settings).values({ key: "store_pix_key", value });
  }

  async function ownerForwards() {
    return db
      .select()
      .from(schema.outboxEvents)
      .where(eq(schema.outboxEvents.eventType, "wa.owner_forward"));
  }

  it("enviar_chave_pix feliz: marca pix_manual, estende prazo p/ 24h, avisa o dono e manda chave+valor", async () => {
    await setPixKey(PIX_KEY);
    const { variantId } = await setupStore();
    const [rate] = await db.select().from(schema.shippingRates);
    const created = await createStoreOrder(
      sdb,
      baseStoreOrderInput(variantId, rate.id),
    );

    const conversationId = await createConversation();
    const inboundId = await addInbound(
      conversationId,
      "O link de pagamento não funciona aqui",
    );
    const before = Date.now();

    assistant.enqueueScript({
      toolCalls: [{ name: "enviar_chave_pix", input: {} }],
      replyTemplate: (toolTexts) => toolTexts[0],
    });
    const result = await runBotTurn(sdb, assistant, provider, { conversationId });
    expect(result).toEqual({ replied: true, handedOff: false });
    expect(assistant.turns[0].toolCalls[0].ok).toBe(true);

    // Pedido marcado como pix_manual, com prazo estendido de ~2h para ~24h.
    const [order] = await db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, created.orderId));
    expect(order.paymentMethod).toBe("pix_manual");
    const dueMs = order.paymentDueAt!.getTime() - before;
    expect(dueMs).toBeGreaterThan(23 * 60 * 60_000);
    expect(dueMs).toBeLessThan(25 * 60 * 60_000);

    // Resposta ao cliente: chave, valor EXATO, instrução de avisar e prazo.
    const body = provider.sentMessages[0].body;
    expect(body).toContain(PIX_KEY);
    expect(body).toContain(formatCentsBRL(created.totalCents));
    expect(body).toContain("avise aqui");
    expect(body).toContain("reserva vale até");

    // Aviso interno ao dono via outbox, raw, com dedupe pedido+inbound.
    const forwards = await ownerForwards();
    expect(forwards).toHaveLength(1);
    expect(forwards[0].dedupeKey).toBe(
      `wa.pix_key:${created.orderId}:${inboundId}`,
    );
    expect(forwards[0].payload).toMatchObject({ raw: true });
    const forwardBody = String((forwards[0].payload as { body: string }).body);
    expect(forwardBody).toContain(`#${created.orderNumber}`);
    expect(forwardBody).toContain(formatCentsBRL(created.totalCents));
    expect(forwardBody).toContain("Pix manual");

    // Audit da marcação.
    const audits = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "order.pix_manual"));
    expect(audits).toHaveLength(1);
    expect(audits[0].entityId).toBe(created.orderId);
  });

  it("enviar_chave_pix sem chave cadastrada: ok:false e NENHUM efeito", async () => {
    const { variantId } = await setupStore();
    const [rate] = await db.select().from(schema.shippingRates);
    const created = await createStoreOrder(
      sdb,
      baseStoreOrderInput(variantId, rate.id),
    );
    const conversationId = await createConversation();
    await addInbound(conversationId, "não consigo pagar pelo link");

    assistant.enqueueScript({
      toolCalls: [{ name: "enviar_chave_pix", input: {} }],
      replyTemplate: (toolTexts) => toolTexts[0],
    });
    await runBotTurn(sdb, assistant, provider, { conversationId });

    expect(assistant.turns[0].toolCalls[0].ok).toBe(false);
    expect(provider.sentMessages[0].body).toContain("NÃO está disponível");
    expect(await ownerForwards()).toHaveLength(0);
    const [order] = await db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, created.orderId));
    expect(order.paymentMethod).toBeNull();
  });

  it("enviar_chave_pix sem pedido pendente do cliente: ok:false", async () => {
    await setPixKey(PIX_KEY);
    const conversationId = await createConversation();
    await addInbound(conversationId, "me passa o pix");

    assistant.enqueueScript({
      toolCalls: [{ name: "enviar_chave_pix", input: {} }],
      replyTemplate: (toolTexts) => toolTexts[0],
    });
    await runBotTurn(sdb, assistant, provider, { conversationId });

    expect(assistant.turns[0].toolCalls[0].ok).toBe(false);
    expect(await ownerForwards()).toHaveLength(0);
  });

  it("enviar_chave_pix NÃO encurta prazo maior que 24h (e mantém NULL de cash como NULL)", async () => {
    await setPixKey(PIX_KEY);
    const { variantId } = await setupStore();
    const [rate] = await db.select().from(schema.shippingRates);
    const created = await createStoreOrder(
      sdb,
      baseStoreOrderInput(variantId, rate.id),
    );
    // Prazo atual de 48h (maior que a extensão de 24h): não pode encurtar.
    const farDue = new Date(Date.now() + 48 * 60 * 60_000);
    await db
      .update(schema.orders)
      .set({ paymentDueAt: farDue })
      .where(eq(schema.orders.id, created.orderId));

    const conversationId = await createConversation();
    const executor = buildToolExecutor(sdb, {
      conversationId,
      phoneE164: PHONE,
      customerId: null,
      lastInboundId: DUMMY_INBOUND_ID,
    });
    const result = await executor("enviar_chave_pix", {});
    expect(result.ok).toBe(true);

    const [order] = await db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, created.orderId));
    expect(order.paymentMethod).toBe("pix_manual");
    expect(order.paymentDueAt!.getTime()).toBe(farDue.getTime());

    // Pedido cash (due NULL) que pediu Pix manual: continua sem prazo.
    await db
      .update(schema.orders)
      .set({ paymentDueAt: null, paymentMethod: "cash" })
      .where(eq(schema.orders.id, created.orderId));
    const again = await executor("enviar_chave_pix", {});
    expect(again.ok).toBe(true);
    const [cashOrder] = await db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, created.orderId));
    expect(cashOrder.paymentDueAt).toBeNull();
    expect(cashOrder.paymentMethod).toBe("pix_manual");
    expect(again.text).not.toContain("reserva vale até");
  });

  it("retry do turno com enviar_chave_pix: aviso ao dono e resposta NÃO duplicam", async () => {
    await setPixKey(PIX_KEY);
    const { variantId } = await setupStore();
    const [rate] = await db.select().from(schema.shippingRates);
    await createStoreOrder(sdb, baseStoreOrderInput(variantId, rate.id));
    const conversationId = await createConversation();
    await addInbound(conversationId, "o link deu erro");

    assistant.enqueueScript({
      toolCalls: [{ name: "enviar_chave_pix", input: {} }],
      replyTemplate: (toolTexts) => toolTexts[0],
    });
    const first = await runBotTurn(sdb, assistant, provider, { conversationId });
    expect(first).toEqual({ replied: true, handedOff: false });

    // Retry do evento da fila: mesma última inbound, já respondida.
    const second = await runBotTurn(sdb, assistant, provider, { conversationId });
    expect(second).toEqual({ skipped: "ja_respondida" });
    expect(assistant.turns).toHaveLength(1);

    expect(await ownerForwards()).toHaveLength(1);
    expect(provider.sentMessages).toHaveLength(1);
    expect(await outboundMessages(conversationId)).toHaveLength(1);
  });

  it("avisar_dono: outbox raw com prefixo e dedupe pela última inbound", async () => {
    const conversationId = await createConversation();
    const inboundId = await addInbound(conversationId, "Já fiz o Pix do pedido 1000!");

    assistant.enqueueScript({
      toolCalls: [
        {
          name: "avisar_dono",
          input: { mensagem: "Cliente diz que já pagou o pedido #1000 (R$ 51,80)." },
        },
      ],
      replyTemplate: "Avisei o dono — ele confirma em breve! 😉",
    });
    const result = await runBotTurn(sdb, assistant, provider, { conversationId });
    expect(result).toEqual({ replied: true, handedOff: false });
    expect(assistant.turns[0].toolCalls[0].ok).toBe(true);

    const forwards = await ownerForwards();
    expect(forwards).toHaveLength(1);
    expect(forwards[0].dedupeKey).toBe(`wa.avisar_dono:${inboundId}`);
    expect(forwards[0].payload).toMatchObject({
      phoneE164: PHONE,
      raw: true,
      body: "📢 Aviso da vendedora: Cliente diz que já pagou o pedido #1000 (R$ 51,80).",
    });

    // Retry do turno: aviso não duplica (dedupe no outbox) e a ferramenta
    // continua ok (idempotente).
    assistant.enqueueScript({
      toolCalls: [
        {
          name: "avisar_dono",
          input: { mensagem: "Cliente diz que já pagou o pedido #1000 (R$ 51,80)." },
        },
      ],
      replyTemplate: "Avisei o dono — ele confirma em breve! 😉",
    });
    await runBotTurn(sdb, assistant, provider, { conversationId });
    expect(await ownerForwards()).toHaveLength(1);
  });

  it("criar_pedido dinheiro na entrega: pedido cash sem prazo, receivable pendente e resumo sem link MP", async () => {
    await setupStore();
    const conversationId = await createConversation();
    await addInbound(conversationId, "Quero pagar em dinheiro na entrega");

    assistant.enqueueScript({
      toolCalls: [
        { name: "cotar_frete", input: { cep: "01310100" } },
        {
          name: "criar_pedido",
          input: {
            itens: [{ sku: "CANECA-AZUL", quantidade: 1 }],
            nome_completo: "Maria da Silva",
            cpf: VALID_CPF,
            cep: "01310100",
            rua: "Avenida Paulista",
            numero: "1000",
            bairro: "Bela Vista",
            cidade: "São Paulo",
            uf: "SP",
            forma_de_pagamento: "dinheiro_na_entrega",
          },
        },
      ],
      replyTemplate: (toolTexts) => toolTexts[1],
    });
    const result = await runBotTurn(sdb, assistant, provider, { conversationId });
    expect(result).toEqual({ replied: true, handedOff: false });
    expect(assistant.turns[0].toolCalls[1].ok).toBe(true);

    const [order] = await db.select().from(schema.orders);
    expect(order.channel).toBe("whatsapp");
    expect(order.status).toBe("pending_payment");
    expect(order.paymentMethod).toBe("cash");
    expect(order.paymentDueAt).toBeNull();

    // Receivable sale PENDENTE criado junto do pedido.
    const entries = await db
      .select()
      .from(schema.financialEntries)
      .where(eq(schema.financialEntries.orderId, order.id));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      direction: "receivable",
      category: "sale",
      status: "pending",
      amountCents: order.totalCents,
      createdBy: null,
    });

    // Resumo próprio do cash: sem link do MP e sem linha de reserva.
    const body = provider.sentMessages[0].body;
    expect(body).toContain(`Pedido #${order.orderNumber}`);
    expect(body).toContain("Pagamento em dinheiro na entrega");
    expect(body).toContain("combinar a entrega por aqui");
    expect(body).toContain(`Acompanhe seu pedido: `);
    expect(body).toContain(`/pedido/${order.publicToken}`);
    expect(body).not.toContain("Pague aqui");
    expect(body).not.toContain("Reserva garantida");
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
      lastInboundId: DUMMY_INBOUND_ID,
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
      lastInboundId: DUMMY_INBOUND_ID,
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
      lastInboundId: DUMMY_INBOUND_ID,
    });

    const result = await executor("cotar_frete", { cep: "01310100" });
    expect(result.ok).toBe(true);
    expect(result.text).toContain("PAC");
    expect(result.text).toContain(formatCentsBRL(1990));
    expect(result.text).toContain("Estimativa para 1 peça");

    const [conversation] = await db
      .select()
      .from(schema.waConversations)
      .where(eq(schema.waConversations.id, conversationId));
    const state = conversation.botState as { lastQuotes?: { name: string }[] };
    expect(state.lastQuotes).toHaveLength(1);
    expect(state.lastQuotes![0].name).toBe("PAC");
  });

  it("cotar_frete oferece as janelas do motoboy (antes da hora-limite) com 'pague até' e guarda a opção no caderninho", async () => {
    await setupStore();
    await db.insert(schema.shippingRates).values({
      name: "Motoboy Belém",
      cepStart: "00000000",
      cepEnd: "99999999",
      weightMinGrams: 0,
      weightMaxGrams: 30000,
      priceCents: 900,
      deliveryDaysMin: 0,
      deliveryDaysMax: 0,
      kind: "motoboy",
      deliveryWindows: [{ start: "19:00", end: "21:00", cutoff: "13:00" }],
    });
    const conversationId = await createConversation();
    const morning = new Date("2026-09-18T13:30:00Z"); // 10:30 SP, sexta
    const executor = buildToolExecutor(sdb, {
      conversationId,
      phoneE164: PHONE,
      customerId: null,
      lastInboundId: DUMMY_INBOUND_ID,
      now: morning,
    });

    const result = await executor("cotar_frete", { cep: "01310100", entregar_ate: "2026-09-18" });
    expect(result.ok).toBe(true);
    expect(result.text).toContain(`1. Motoboy Belém — hoje, 19h–21h — ${formatCentsBRL(900)} (pague até 13h) · Chega até sexta 18/09, no dia`);
    // Onde o motoboy chega, o PAC da loja não aparece (motoboy exclusivo).
    expect(result.text).not.toContain("PAC");

    const [conversation] = await db
      .select()
      .from(schema.waConversations)
      .where(eq(schema.waConversations.id, conversationId));
    const state = conversation.botState as { lastQuotes?: { optionKey?: string; kind?: string }[]; chosenOptionKey?: string; neededBy?: string };
    expect(state.lastQuotes?.map((q) => q.kind)).toEqual(["motoboy"]);
    expect(state.lastQuotes?.[0].optionKey).toMatch(/:2026-09-18:19:00$/);
    // Uma opção só já é a escolhida.
    expect(state.chosenOptionKey).toMatch(/:2026-09-18:19:00$/);
    expect(state.neededBy).toBe("2026-09-18");

    // criar_pedido com a janela: o pedido nasce com delivery_window e a data marcada.
    const order = await executor("criar_pedido", {
      itens: [{ sku: "CANECA-AZUL", quantidade: 1 }],
      frete: "motoboy 19h",
      nome_completo: "Maria da Silva",
      cpf: VALID_CPF,
      cep: "01310100",
      rua: "Avenida Paulista",
      numero: "1000",
      bairro: "Bela Vista",
      cidade: "São Paulo",
      uf: "SP",
      ocasiao: "aniversário",
    });
    expect(order.ok).toBe(true);
    expect(order.text).toContain(`Entrega: Motoboy Belém — hoje, 19h–21h · pague até 13h — ${formatCentsBRL(900)}`);
    expect(order.text).toContain("Data marcada: Para o dia 18/09 — aniversário — Chega até sexta 18/09, no dia");
    const [row] = await db.select().from(schema.orders).orderBy(schema.orders.orderNumber);
    expect(row.deliveryWindow).toMatchObject({ dayKey: "2026-09-18", start: "19:00", end: "21:00", cutoff: "13:00", rateName: "Motoboy Belém" });
    expect(row.neededBy).toBe("2026-09-18");
    expect(row.occasion).toBe("aniversário");
    expect(row.shippingCents).toBe(900);
  });

  it("data marcada: velha no caderninho some sem travar; diferente da cotada é recusada até cotar de novo", async () => {
    await setupStore();
    const conversationId = await createConversation();
    const base = { conversationId, phoneE164: PHONE, customerId: null, lastInboundId: DUMMY_INBOUND_ID };
    // Cotou com data para 18/09; no dia 19 a cliente fecha sem data: a velha some e o pedido sai sem data marcada.
    await buildToolExecutor(sdb, { ...base, now: new Date("2026-09-18T13:30:00Z") })("cotar_frete", { cep: "01310100", entregar_ate: "2026-09-18", ocasiao: "festa" });
    let [conversation] = await db.select().from(schema.waConversations).where(eq(schema.waConversations.id, conversationId));
    expect((conversation.botState as { neededBy?: string; occasion?: string }).occasion).toBe("festa");
    const nextDay = buildToolExecutor(sdb, { ...base, now: new Date("2026-09-19T13:00:00Z") });
    await nextDay("cotar_frete", { cep: "01310100" });
    [conversation] = await db.select().from(schema.waConversations).where(eq(schema.waConversations.id, conversationId));
    expect((conversation.botState as { neededBy?: string }).neededBy).toBeUndefined();

    // Data no fechamento diferente da cotada (a cotação foi sem data): recusa e manda cotar com entregar_ate.
    const mismatch = await nextDay("criar_pedido", {
      itens: [{ sku: "CANECA-AZUL", quantidade: 1 }],
      entregar_ate: "2026-09-25",
      nome_completo: "Maria da Silva",
      cpf: VALID_CPF,
      cep: "01310100",
      rua: "Avenida Paulista",
      numero: "1000",
      bairro: "Bela Vista",
      cidade: "São Paulo",
      uf: "SP",
    });
    expect(mismatch.ok).toBe(false);
    expect(mismatch.text).toContain("chame cotar_frete com entregar_ate=2026-09-25");
    expect(await db.select().from(schema.orders)).toHaveLength(0);

    // Data no passado no fechamento: recusa dizendo que dia é hoje.
    const past = await nextDay("criar_pedido", { itens: [{ sku: "CANECA-AZUL", quantidade: 1 }], entregar_ate: "2026-09-18", usar_cadastro_salvo: false, nome_completo: "Maria da Silva", cpf: VALID_CPF, cep: "01310100", rua: "Avenida Paulista", numero: "1000", bairro: "Bela Vista", cidade: "São Paulo", uf: "SP" });
    expect(past.ok).toBe(false);
    expect(past.text).toContain("hoje é 2026-09-19");

    // Sem data: fecha normalmente, sem data marcada.
    const ok = await nextDay("criar_pedido", { itens: [{ sku: "CANECA-AZUL", quantidade: 1 }], nome_completo: "Maria da Silva", cpf: VALID_CPF, cep: "01310100", rua: "Avenida Paulista", numero: "1000", bairro: "Bela Vista", cidade: "São Paulo", uf: "SP" });
    expect(ok.ok).toBe(true);
    const [row] = await db.select().from(schema.orders);
    expect(row.neededBy).toBeNull();
  });

  it("janela que passou da hora-limite entre a cotação e o fechamento: criar_pedido manda cotar de novo, sem criar pedido", async () => {
    await setupStore();
    await db.insert(schema.shippingRates).values({
      name: "Motoboy Belém",
      cepStart: "00000000",
      cepEnd: "99999999",
      weightMinGrams: 0,
      weightMaxGrams: 30000,
      priceCents: 900,
      deliveryDaysMin: 0,
      deliveryDaysMax: 0,
      kind: "motoboy",
      deliveryWindows: [{ start: "19:00", end: "21:00", cutoff: "13:00" }],
    });
    const conversationId = await createConversation();
    const base = { conversationId, phoneE164: PHONE, customerId: null, lastInboundId: DUMMY_INBOUND_ID };
    await buildToolExecutor(sdb, { ...base, now: new Date("2026-09-18T13:30:00Z") })("cotar_frete", { cep: "01310100" });
    const late = buildToolExecutor(sdb, { ...base, now: new Date("2026-09-18T16:30:00Z") }); // 13:30 SP
    const result = await late("criar_pedido", {
      itens: [{ sku: "CANECA-AZUL", quantidade: 1 }],
      frete: "1",
      nome_completo: "Maria da Silva",
      cpf: VALID_CPF,
      cep: "01310100",
      rua: "Avenida Paulista",
      numero: "1000",
      bairro: "Bela Vista",
      cidade: "São Paulo",
      uf: "SP",
    });
    expect(result.ok).toBe(false);
    expect(result.text).toContain("já passou da hora-limite");
    expect(await db.select().from(schema.orders)).toHaveLength(0);
  });

  it("input inválido é recusado antes de qualquer efeito", async () => {
    const conversationId = await createConversation();
    const executor = buildToolExecutor(sdb, {
      conversationId,
      phoneE164: PHONE,
      customerId: null,
      lastInboundId: DUMMY_INBOUND_ID,
    });

    const result = await executor("cotar_frete", { cep: "013" });
    expect(result.ok).toBe(false);
    expect(result.text).toContain("Dados inválidos");
  });
});

describe("historyTextFor", () => {
  // Regressão de 26/08: o menu chegou ao cliente como texto puro, sem botões,
  // porque o modelo copiou do histórico o body já renderizado de um option_list
  // anterior em vez de chamar listar_produtos. O histórico não pode conter uma
  // lista de produtos copiável.
  it("troca o menu renderizado por um marcador sem produtos nem preços", () => {
    const menuRenderizado = [
      "Toque abaixo e veja o catálogo 👇",
      "• Camiseta Essencial — R$ 44,90",
      "• Moletom Canguru — R$ 85,90",
    ].join("\n");

    const texto = historyTextFor("option_list", menuRenderizado);

    expect(texto).not.toContain("Camiseta Essencial");
    expect(texto).not.toContain("R$ 44,90");
    expect(texto).not.toContain("•");
    expect(texto).toContain("lista tocável do catálogo");
  });

  it("mantém a legenda da foto, que é contexto útil e não vira menu falso", () => {
    expect(historyTextFor("image", "Camiseta Essencial — R$ 44,90")).toBe(
      "[foto enviada ao cliente] Camiseta Essencial — R$ 44,90",
    );
  });

  it("não altera mensagem de texto comum", () => {
    expect(historyTextFor("text", "Oi, tudo bem?")).toBe("Oi, tudo bem?");
  });
});

// ---------------------------------------------------------------------------
// Cadastro salvo do cliente recorrente
// ---------------------------------------------------------------------------

describe("buscar_cadastro + usar_cadastro_salvo", () => {
  it("cliente novo: diz que não há compra registrada, sem negar que a loja guarda dados", async () => {
    const conversationId = await createConversation();
    const executor = buildToolExecutor(sdb, {
      conversationId,
      phoneE164: PHONE,
      customerId: null,
      lastInboundId: DUMMY_INBOUND_ID,
    });

    const result = await executor("buscar_cadastro", {});

    expect(result.ok).toBe(true);
    expect(result.text).toContain("ainda não tem cadastro");
    // A frase que gerou o incidente de 26/08 não pode voltar.
    expect(result.text).toContain("NUNCA diga ao cliente que a loja não guarda dados");
  });

  it("cliente recorrente: acha o cadastro e mascara o CPF", async () => {
    const { variantId } = await setupStore();
    const rate = await createRate();
    // Primeira compra: é ela que cria cliente + endereço.
    await createStoreOrder(sdb, baseStoreOrderInput(variantId, rate.id));

    const conversationId = await createConversation();
    const executor = buildToolExecutor(sdb, {
      conversationId,
      phoneE164: PHONE,
      customerId: null,
      lastInboundId: DUMMY_INBOUND_ID,
    });

    const result = await executor("buscar_cadastro", {});

    expect(result.ok).toBe(true);
    expect(result.text).toContain("Maria da Silva");
    expect(result.text).toContain("Avenida Paulista, 1000");
    expect(result.text).toContain(`•••.•••.•••-${VALID_CPF.slice(-2)}`);
    // A garantia central: o CPF inteiro nunca chega ao modelo.
    expect(result.text).not.toContain(VALID_CPF);
  });

  it("fecha pedido com usar_cadastro_salvo, sem receber nome, CPF nem endereço", async () => {
    const { variantId } = await setupStore({ onHand: 10 });
    const rate = await createRate();
    await createStoreOrder(sdb, baseStoreOrderInput(variantId, rate.id));

    const conversationId = await createConversation();
    const executor = buildToolExecutor(sdb, {
      conversationId,
      phoneE164: PHONE,
      customerId: null,
      lastInboundId: DUMMY_INBOUND_ID,
    });

    await executor("cotar_frete", { cep: "01310100" });
    const result = await executor("criar_pedido", {
      itens: [{ sku: "CANECA-AZUL", quantidade: 1 }],
      usar_cadastro_salvo: true,
    });

    expect(result.ok).toBe(true);

    const [novo] = await db
      .select()
      .from(schema.orders)
      .orderBy(schema.orders.orderNumber);
    expect(novo).toBeDefined();

    // O endereço do pedido novo veio do cadastro, não do que o bot digitou.
    const criados = await db.select().from(schema.orders);
    expect(criados).toHaveLength(2);
    const ultimo = criados[criados.length - 1];
    expect(ultimo.channel).toBe("whatsapp");
    expect(ultimo.shippingAddress).toMatchObject({
      street: "Avenida Paulista",
      number: "1000",
      city: "São Paulo",
      state: "SP",
    });
  });

  it("sem cadastro, usar_cadastro_salvo falha com instrução de coletar os dados", async () => {
    await setupStore();
    const conversationId = await createConversation();
    const executor = buildToolExecutor(sdb, {
      conversationId,
      phoneE164: PHONE,
      customerId: null,
      lastInboundId: DUMMY_INBOUND_ID,
    });

    const result = await executor("criar_pedido", {
      itens: [{ sku: "CANECA-AZUL", quantidade: 1 }],
      usar_cadastro_salvo: true,
    });

    expect(result.ok).toBe(false);
    expect(result.text).toContain("Colete nome, CPF e endereço");
    expect(await db.select().from(schema.orders)).toHaveLength(0);
  });
});
