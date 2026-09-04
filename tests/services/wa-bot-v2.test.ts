// Vendedora v2 (Onda 3): sacola real, frete escolhido pela cliente,
// caderninho injetado no turno, histórico com origem marcada, resposta em
// balões, catálogo com filtros/paginação, detalhe sem escolher em silêncio,
// transferência com resumo e modo ensaio (dryRun).
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AssistantTurn,
  RespondTurnInput,
  SalesAssistant,
} from "@/adapters/assistant";
import { FakeSalesAssistant } from "@/adapters/assistant/fake";
import { FakeMessagingProvider } from "@/adapters/zapi/fake";
import * as schema from "@/db/schema";
import { formatCentsBRL } from "@/lib/money";
import type { DbOrTx } from "@/queue/enqueue";
import { buildToolExecutor, runBotTurn } from "@/services/wa-bot";
import { createTestDb, createTestVariant, type TestDb } from "../helpers/db";

let db: TestDb;
let close: () => Promise<void>;
let sdb: DbOrTx;
let assistant: FakeSalesAssistant;
let provider: FakeMessagingProvider;

const PHONE = "+5511999998888";
const VALID_CPF = "52998224725";
const DUMMY_INBOUND_ID = "00000000-0000-4000-8000-00000000feed";

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  sdb = db as unknown as DbOrTx;
  assistant = new FakeSalesAssistant();
  provider = new FakeMessagingProvider();
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
// Fixtures
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

async function createRate(name: string, priceCents: number): Promise<string> {
  const [rate] = await db
    .insert(schema.shippingRates)
    .values({ name, priceCents })
    .returning({ id: schema.shippingRates.id });
  return rate.id;
}

/** Peça simples (sem variação) ativa, com preço, estoque e peso opcional. */
async function createSimpleProduct(
  sku: string,
  name: string,
  priceCents: number,
  opts: { onHand?: number; weightGrams?: number; categoryId?: string } = {},
): Promise<{ productId: string; variantId: string }> {
  const { productId, variantId } = await createTestVariant(db, {
    sku,
    name,
    onHand: opts.onHand ?? 5,
  });
  await activatePrice(variantId, priceCents);
  if (opts.weightGrams !== undefined) {
    await db
      .update(schema.productVariants)
      .set({ weightGrams: opts.weightGrams })
      .where(eq(schema.productVariants.id, variantId));
  }
  if (opts.categoryId) {
    await db
      .update(schema.products)
      .set({ categoryId: opts.categoryId })
      .where(eq(schema.products.id, productId));
  }
  return { productId, variantId };
}

/** Peça com grade cor × tamanho. */
async function createGridProduct(
  name: string,
  slug: string,
  grid: { sku: string; cor: string; tamanho: string; onHand: number; priceCents: number }[],
  categoryId?: string,
): Promise<string> {
  const [product] = await db
    .insert(schema.products)
    .values({
      name,
      slug,
      status: "active",
      attributesSchema: ["cor", "tamanho"],
      ...(categoryId ? { categoryId } : {}),
    })
    .returning({ id: schema.products.id });
  for (const cell of grid) {
    const [variant] = await db
      .insert(schema.productVariants)
      .values({
        productId: product.id,
        sku: cell.sku,
        attributes: { cor: cell.cor, tamanho: cell.tamanho },
        costCents: 3000,
      })
      .returning({ id: schema.productVariants.id });
    await db.insert(schema.stockLevels).values({
      productVariantId: variant.id,
      onHand: cell.onHand,
      reserved: 0,
    });
    await activatePrice(variant.id, cell.priceCents);
  }
  return product.id;
}

async function createCategory(name: string, slug: string): Promise<string> {
  const [category] = await db
    .insert(schema.categories)
    .values({ name, slug })
    .returning({ id: schema.categories.id });
  return category.id;
}

async function createConversation(
  opts: { botState?: unknown; status?: string } = {},
): Promise<string> {
  const [conversation] = await db
    .insert(schema.waConversations)
    .values({
      phoneE164: PHONE,
      status: opts.status ?? "open",
      ...(opts.botState !== undefined ? { botState: opts.botState } : {}),
    })
    .returning({ id: schema.waConversations.id });
  return conversation.id;
}

let sequence = 0;

async function addInbound(conversationId: string, body: string): Promise<string> {
  sequence += 1;
  const [message] = await db
    .insert(schema.waMessages)
    .values({
      conversationId,
      direction: "inbound",
      zapiMessageId: `MSG-IN-${sequence}-${Math.random().toString(36).slice(2, 8)}`,
      body,
      status: "delivered",
      deliveredAt: new Date(),
      createdAt: new Date(Date.now() - 60_000 + sequence * 1000),
    })
    .returning({ id: schema.waMessages.id });
  return message.id;
}

async function addOutbound(
  conversationId: string,
  body: string,
  opts: { dedupeKey: string; templateKey?: string },
): Promise<void> {
  sequence += 1;
  await db.insert(schema.waMessages).values({
    conversationId,
    direction: "outbound",
    body,
    status: "sent",
    dedupeKey: opts.dedupeKey,
    ...(opts.templateKey ? { templateKey: opts.templateKey } : {}),
    createdAt: new Date(Date.now() - 60_000 + sequence * 1000),
  });
}

async function botState(conversationId: string): Promise<Record<string, unknown>> {
  const [row] = await db
    .select({ botState: schema.waConversations.botState })
    .from(schema.waConversations)
    .where(eq(schema.waConversations.id, conversationId));
  return (row?.botState ?? {}) as Record<string, unknown>;
}

async function outboundTexts(conversationId: string) {
  return db
    .select({
      body: schema.waMessages.body,
      dedupeKey: schema.waMessages.dedupeKey,
      kind: schema.waMessages.kind,
    })
    .from(schema.waMessages)
    .where(
      and(
        eq(schema.waMessages.conversationId, conversationId),
        eq(schema.waMessages.direction, "outbound"),
      ),
    )
    .orderBy(schema.waMessages.createdAt);
}

function executorFor(conversationId: string, dryRun = false) {
  return buildToolExecutor(sdb, {
    conversationId,
    phoneE164: PHONE,
    customerId: null,
    lastInboundId: DUMMY_INBOUND_ID,
    ...(dryRun ? { dryRun: true } : {}),
  });
}

/** Assistente que só grava o que recebeu — para inspecionar prompt e histórico. */
function recorder(reply = "ok"): SalesAssistant & { seen: RespondTurnInput[] } {
  const seen: RespondTurnInput[] = [];
  return {
    seen,
    async respondTurn(input): Promise<AssistantTurn> {
      seen.push(input);
      return {
        reply,
        toolCalls: [],
        handedOff: false,
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    },
  };
}

const IDENTITY = {
  nome_completo: "Maria da Silva",
  cpf: VALID_CPF,
  cep: "01310100",
  rua: "Avenida Paulista",
  numero: "1000",
  bairro: "Bela Vista",
  cidade: "São Paulo",
  uf: "SP",
};

// ---------------------------------------------------------------------------
// Sacola e frete
// ---------------------------------------------------------------------------

describe("sacola", () => {
  it("adicionar confere estoque, ver mostra subtotal, remover esvazia; a sacola zera a cotação antiga", async () => {
    await createSimpleProduct("CANECA-AZUL", "Caneca Azul", 4990, { onHand: 2 });
    const conversationId = await createConversation({
      botState: { lastQuotes: [{ rateId: "x", name: "PAC", priceCents: 1, deliveryDaysMin: 1, deliveryDaysMax: 1 }] },
    });
    const executor = executorFor(conversationId);

    const demais = await executor("adicionar_a_sacola", { sku: "caneca-azul", quantidade: 3 });
    expect(demais.ok).toBe(false);
    expect(demais.text).toContain("tem só 2 unidades");

    const ok = await executor("adicionar_a_sacola", { sku: "caneca-azul", quantidade: 2 });
    expect(ok.ok).toBe(true);
    expect(ok.text).toContain("Adicionei 2× Caneca Azul à sacola.");
    expect(ok.text).toContain(`Subtotal: ${formatCentsBRL(9980)}`);

    const state = await botState(conversationId);
    expect(state.cart).toEqual([
      { sku: "CANECA-AZUL", quantidade: 2, nome: "Caneca Azul", variacao: "", precoCents: 4990 },
    ]);
    expect(state.lastQuotes).toBeUndefined();

    const ver = await executor("ver_sacola", {});
    expect(ver.text).toContain("• 2× Caneca Azul");

    const naoTem = await executor("remover_da_sacola", { sku: "OUTRA" });
    expect(naoTem.ok).toBe(false);

    const removeu = await executor("remover_da_sacola", { sku: "CANECA-AZUL" });
    expect(removeu.ok).toBe(true);
    expect(removeu.text).toContain("Sacola vazia.");
    expect((await botState(conversationId)).cart).toEqual([]);
  });

  it("peça esgotada não entra na sacola e a resposta orienta a alternativa", async () => {
    await createSimpleProduct("CANECA-AZUL", "Caneca Azul", 4990, { onHand: 0 });
    const executor = executorFor(await createConversation());
    const result = await executor("adicionar_a_sacola", { sku: "CANECA-AZUL" });
    expect(result.ok).toBe(false);
    expect(result.text).toContain("está esgotada agora");
  });

  it("cotar_frete com sacola usa o peso real (sem 'estimativa') e guarda CEP e cotações", async () => {
    await createSimpleProduct("CANECA-AZUL", "Caneca Azul", 4990, { weightGrams: 800 });
    await createRate("PAC", 1990);
    const conversationId = await createConversation();
    const executor = executorFor(conversationId);
    await executor("adicionar_a_sacola", { sku: "CANECA-AZUL", quantidade: 2 });

    const result = await executor("cotar_frete", { cep: "01310-100" });
    expect(result.ok).toBe(true);
    expect(result.text).not.toContain("Estimativa");
    expect(result.text).toContain("1. PAC");

    const state = await botState(conversationId);
    expect(state.lastCep).toBe("01310100");
    expect(state.lastQuotes).toHaveLength(1);
    // Uma opção só: já é a escolhida.
    expect(state.chosenRateId).toBeDefined();
  });
});

describe("criar_pedido com a sacola e o frete escolhido", () => {
  it("sem itens fecha com a sacola, usa o frete escolhido pelo número e esvazia a sacola", async () => {
    await createSimpleProduct("CANECA-AZUL", "Caneca Azul", 4990);
    await createRate("PAC", 1990);
    await createRate("SEDEX", 2990);
    const conversationId = await createConversation();
    const executor = executorFor(conversationId);
    await executor("adicionar_a_sacola", { sku: "CANECA-AZUL", quantidade: 1 });
    const cotacao = await executor("cotar_frete", { cep: "01310100" });
    expect(cotacao.text).toContain("[Pergunte à cliente qual opção ela prefere");

    const result = await executor("criar_pedido", { ...IDENTITY, frete: "2" });
    expect(result.ok).toBe(true);
    expect(result.text).toContain(`Frete (SEDEX): ${formatCentsBRL(2990)}`);
    expect(result.text).toContain(`TOTAL: ${formatCentsBRL(4990 + 2990)}`);

    const [order] = await db.select().from(schema.orders);
    expect(order.channel).toBe("whatsapp");
    expect(order.shippingCents).toBe(2990);

    const state = await botState(conversationId);
    expect(state.cart).toEqual([]);
    expect(state.lastQuotes).toBeUndefined();
    expect(state.lastOrderNumber).toBe(order.orderNumber);
  });

  it("frete pelo nome (sem caixa) também vale", async () => {
    await createSimpleProduct("CANECA-AZUL", "Caneca Azul", 4990);
    await createRate("PAC", 1990);
    await createRate("SEDEX", 2990);
    const executor = executorFor(await createConversation());
    const result = await executor("criar_pedido", {
      ...IDENTITY,
      itens: [{ sku: "CANECA-AZUL", quantidade: 1 }],
      frete: "sedex",
    });
    expect(result.ok).toBe(true);
    expect(result.text).toContain("Frete (SEDEX)");
  });

  it("duas opções e nenhuma escolha: pede a escolha e NÃO cria pedido", async () => {
    await createSimpleProduct("CANECA-AZUL", "Caneca Azul", 4990);
    await createRate("PAC", 1990);
    await createRate("SEDEX", 2990);
    const executor = executorFor(await createConversation());
    const result = await executor("criar_pedido", {
      ...IDENTITY,
      itens: [{ sku: "CANECA-AZUL", quantidade: 1 }],
    });
    expect(result.ok).toBe(false);
    expect(result.text).toContain("a escolha da cliente não veio");
    expect(result.text).toContain("2. SEDEX");
    expect(await db.select().from(schema.orders)).toHaveLength(0);
  });

  it("sacola vazia e sem itens: ok:false com orientação", async () => {
    await createRate("PAC", 1990);
    const executor = executorFor(await createConversation());
    const result = await executor("criar_pedido", IDENTITY);
    expect(result.ok).toBe(false);
    expect(result.text).toContain("A sacola está vazia");
  });
});

// ---------------------------------------------------------------------------
// Caderninho, histórico e balões
// ---------------------------------------------------------------------------

describe("caderninho", () => {
  it("anotar guarda preferências e recusa documento/CEP", async () => {
    const conversationId = await createConversation();
    const executor = executorFor(conversationId);

    const ok = await executor("anotar", { nota: "veste M em vestidos" });
    expect(ok.ok).toBe(true);
    expect(ok.text).toContain("Caderninho: veste M em vestidos");

    const cpf = await executor("anotar", { nota: "CPF 529.982.247-25" });
    expect(cpf.ok).toBe(false);
    const cep = await executor("anotar", { nota: "mora no CEP 01310-100" });
    expect(cep.ok).toBe(false);

    expect((await botState(conversationId)).notes).toEqual(["veste M em vestidos"]);
  });

  it("o turno recebe o CADERNINHO como primeira mensagem, e nada quando está vazio", async () => {
    const vazio = await createConversation();
    await addInbound(vazio, "oi");
    const semNota = recorder();
    await runBotTurn(sdb, semNota, provider, { conversationId: vazio });
    expect(semNota.seen[0].history[0]).toEqual({ role: "user", text: "oi" });

    await db
      .update(schema.waConversations)
      .set({ status: "closed" })
      .where(eq(schema.waConversations.id, vazio));
    const cheio = await createConversation({
      botState: { displayName: "Maria", notes: ["veste M em vestidos"] },
    });
    await addInbound(cheio, "oi de novo");
    const comNota = recorder();
    await runBotTurn(sdb, comNota, provider, { conversationId: cheio });
    const [primeira, segunda] = comNota.seen[0].history;
    expect(primeira.role).toBe("user");
    expect(primeira.text).toContain("CADERNINHO");
    expect(primeira.text).toContain("• Nome no WhatsApp: Maria");
    expect(primeira.text).toContain("• Anotações: veste M em vestidos");
    expect(segunda).toEqual({ role: "user", text: "oi de novo" });
    // O prompt de sistema não carrega o caderninho (cache estável).
    expect(comNota.seen[0].system).not.toContain("CADERNINHO (memória interna");
    expect(comNota.seen[0].system).toContain("Você é Lia, a vendedora da");
  });

  it("nome da vendedora e política de troca vêm das configurações; planta da loja entra quando há catálogo", async () => {
    await db.insert(schema.settings).values([
      { key: "bot_seller_name", value: "Bia" },
      { key: "store_exchange_policy", value: "Troca em 7 dias com etiqueta." },
    ]);
    const categoryId = await createCategory("Vestidos", "vestidos");
    await createSimpleProduct("VEST-1", "Vestido Um", 18900, { categoryId });
    const conversationId = await createConversation();
    await addInbound(conversationId, "oi");
    const seen = recorder();
    await runBotTurn(sdb, seen, provider, { conversationId });
    const system = seen.seen[0].system;
    expect(system).toContain("Você é Bia, a vendedora da");
    expect(system).toContain("Política de troca: Troca em 7 dias com etiqueta.");
    expect(system).toContain("PLANTA DA LOJA");
    expect(system).toContain(`• Vestidos (categoria: vestidos) — 1 peça, ${formatCentsBRL(18900)}`);
  });
});

describe("histórico", () => {
  it("marca a origem do que NÃO foi a vendedora: equipe e avisos automáticos", async () => {
    const conversationId = await createConversation();
    await addInbound(conversationId, "quero um vestido");
    await addOutbound(conversationId, "Toque no catálogo 👇", {
      dedupeKey: "wa.bot_reply:abc",
    });
    await addOutbound(conversationId, "Oi, aqui é o Fabiano, te dou 10%", {
      dedupeKey: "wa.send:manual-1",
    });
    await addOutbound(conversationId, "Seu pedido #1000 foi pago!", {
      dedupeKey: "wa.order_paid:1000",
      templateKey: "order_paid",
    });
    await addInbound(conversationId, "obrigada");

    const seen = recorder();
    await runBotTurn(sdb, seen, provider, { conversationId });
    const textos = seen.seen[0].history.map((message) => message.text);
    expect(textos).toEqual([
      "quero um vestido",
      "Toque no catálogo 👇",
      "[mensagem enviada pela equipe da loja, não por você] Oi, aqui é o Fabiano, te dou 10%",
      "[aviso automático da loja] Seu pedido #1000 foi pago!",
      "obrigada",
    ]);
  });
});

describe("balões", () => {
  it("resposta com '---' sai em até 3 balões com dedupes distintos; o retry não duplica", async () => {
    const conversationId = await createConversation();
    const inboundId = await addInbound(conversationId, "oi");
    assistant.enqueueScript({ replyTemplate: "Oi, Maria! 💛\n---\nO Dunas é de linho.\n---\nVai de M ou G?" });

    const result = await runBotTurn(sdb, assistant, provider, { conversationId });
    expect(result).toEqual({ replied: true, handedOff: false });

    const sent = await outboundTexts(conversationId);
    expect(sent.map((message) => [message.body, message.dedupeKey])).toEqual([
      ["Oi, Maria! 💛", `wa.bot_reply:${inboundId}`],
      ["O Dunas é de linho.", `wa.bot_reply:${inboundId}:1`],
      ["Vai de M ou G?", `wa.bot_reply:${inboundId}:2`],
    ]);
    expect(provider.sentMessages).toHaveLength(3);

    assistant.enqueueScript({ replyTemplate: "Oi, Maria! 💛\n---\nO Dunas é de linho.\n---\nVai de M ou G?" });
    await runBotTurn(sdb, assistant, provider, { conversationId });
    expect(await outboundTexts(conversationId)).toHaveLength(3);
  });

  it("a trilha do turno registra ferramentas, uso, balões e duração", async () => {
    const conversationId = await createConversation();
    await addInbound(conversationId, "oi");
    assistant.enqueueScript({
      toolCalls: [{ name: "ver_sacola", input: {} }],
      replyTemplate: "Sacola vazia por enquanto!",
    });
    await runBotTurn(sdb, assistant, provider, { conversationId });

    const [trail] = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "wa.bot_turn"));
    expect(trail.entityId).toBe(conversationId);
    expect(trail.after).toMatchObject({
      model: "claude-sonnet-5",
      toolCalls: [{ name: "ver_sacola", ok: true }],
      handedOff: false,
      bubbles: 1,
    });
    expect(typeof (trail.after as { durationMs: number }).durationMs).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// Catálogo: filtros, paginação e detalhe honesto
// ---------------------------------------------------------------------------

describe("listar_produtos 2.0", () => {
  it("filtra por categoria, cor, tamanho e preço; categoria inexistente é erro", async () => {
    const vestidos = await createCategory("Vestidos", "vestidos");
    const blusas = await createCategory("Blusas", "blusas");
    await createGridProduct(
      "Vestido Dunas",
      "vestido-dunas",
      [
        { sku: "DUNAS-PRET-M", cor: "Preto", tamanho: "M", onHand: 3, priceCents: 28900 },
        { sku: "DUNAS-VERD-G", cor: "Verde", tamanho: "G", onHand: 0, priceCents: 28900 },
      ],
      vestidos,
    );
    await createGridProduct(
      "Vestido Brisa",
      "vestido-brisa",
      [{ sku: "BRISA-VERD-G", cor: "Verde", tamanho: "G", onHand: 2, priceCents: 19900 }],
      vestidos,
    );
    await createSimpleProduct("BLUSA-1", "Blusa Linho", 9900, { categoryId: blusas });
    const executor = executorFor(await createConversation());

    const porCategoria = await executor("listar_produtos", { categoria: "Vestidos" });
    expect(porCategoria.text).toContain("2 peças encontradas (categoria Vestidos)");
    expect(porCategoria.text).not.toContain("Blusa Linho");

    const preto = await executor("listar_produtos", { cor: "preto" });
    expect(preto.text).toContain("1 peça encontrada (cor preto)");
    expect(preto.text).toContain("Vestido Dunas");

    // Verde G existe no Dunas mas SEM estoque: só o Brisa conta.
    const verdeG = await executor("listar_produtos", { cor: "Verde", tamanho: "G" });
    expect(verdeG.text).toContain("1 peça encontrada");
    expect(verdeG.text).toContain("Vestido Brisa");

    const barato = await executor("listar_produtos", { preco_maximo_reais: 200 });
    expect(barato.text).toContain("2 peças encontradas");
    expect(barato.text).not.toContain("Vestido Dunas");

    const nada = await executor("listar_produtos", { cor: "Roxo" });
    expect(nada.ok).toBe(true);
    expect(nada.text).toContain("Nenhuma peça encontrada (cor Roxo)");

    const semCategoria = await executor("listar_produtos", { categoria: "Sapatos" });
    expect(semCategoria.ok).toBe(false);
  });

  it("busca também na descrição", async () => {
    const { productId } = await createSimpleProduct("VEST-LINHO", "Vestido Areia", 25900);
    await db
      .update(schema.products)
      .set({ description: "Linho puro, caimento fluido." })
      .where(eq(schema.products.id, productId));
    const executor = executorFor(await createConversation());
    const result = await executor("listar_produtos", { busca: "linho" });
    expect(result.text).toContain("Vestido Areia");
  });

  it("pagina de 10 em 10 e a lista tocável acompanha a página", async () => {
    for (let i = 1; i <= 12; i++) {
      await createSimpleProduct(`PECA-${String(i).padStart(2, "0")}`, `Peça ${i}`, 1000 * i);
    }
    const conversationId = await createConversation();
    await addInbound(conversationId, "quero ver tudo");
    assistant.enqueueScript({
      toolCalls: [{ name: "listar_produtos", input: { pagina: 2 } }],
      replyTemplate: (texts) => texts[0],
    });
    await runBotTurn(sdb, assistant, provider, { conversationId });

    const texto = assistant.turns[0].reply ?? "";
    expect(texto).toContain("12 peças encontradas — mostrando 11 a 12 (página 2 de 2");
    expect(provider.sentOptionLists).toHaveLength(1);
    expect(provider.sentOptionLists[0].options).toHaveLength(2);
    expect(provider.sentOptionLists[0].message).toContain("(11–12 de 12)");
  });
});

describe("detalhar_produto 2.0", () => {
  it("nome ambíguo devolve as candidatas em vez de escolher em silêncio", async () => {
    await createSimpleProduct("SAIA-MIDI", "Saia Midi", 15900);
    await createSimpleProduct("SAIA-LONGA", "Saia Longa", 17900);
    const conversationId = await createConversation();
    const executor = executorFor(conversationId);

    const ambiguo = await executor("detalhar_produto", { produto: "saia" });
    expect(ambiguo.ok).toBe(true);
    expect(ambiguo.text).toContain('Há 2 peças com "saia" no nome');
    expect(ambiguo.text).toContain("Saia Midi (slug saia-midi)");
    expect(ambiguo.text).toContain("Saia Longa (slug saia-longa)");
    expect((await botState(conversationId)).focus).toBeUndefined();

    const exato = await executor("detalhar_produto", { produto: "produto:saia-midi" });
    expect(exato.ok).toBe(true);
    expect(exato.text.startsWith("Saia Midi")).toBe(true);
    expect((await botState(conversationId)).focus).toEqual({
      slug: "saia-midi",
      nome: "Saia Midi",
      cor: null,
    });
  });

  it("traz categoria, descrição inteira, promoção de/por e aviso sem descrição", async () => {
    const categoryId = await createCategory("Vestidos", "vestidos");
    const { productId, variantId } = await createSimpleProduct("VEST-1", "Vestido Um", 18900, { categoryId });
    const descricao = "Linho puro. ".repeat(40).trim();
    await db
      .update(schema.products)
      .set({ description: descricao, brand: "TRIVÉ" })
      .where(eq(schema.products.id, productId));
    await db
      .update(schema.priceVersions)
      .set({ compareAtPriceCents: 25900 })
      .where(eq(schema.priceVersions.productVariantId, variantId));
    const executor = executorFor(await createConversation());

    const result = await executor("detalhar_produto", { produto: "Vestido Um" });
    expect(result.text).toContain("Categoria: Vestidos · Marca: TRIVÉ");
    expect(result.text).toContain(descricao);
    expect(result.text).toContain(`Promoção: de ${formatCentsBRL(25900)} por ${formatCentsBRL(18900)}.`);

    await createSimpleProduct("SEM-DESC", "Peça Muda", 5000);
    const muda = await executor("detalhar_produto", { produto: "Peça Muda" });
    expect(muda.text).toContain("[Sem descrição cadastrada");
  });
});

// ---------------------------------------------------------------------------
// Transferência com resumo e modo ensaio
// ---------------------------------------------------------------------------

describe("transferir_para_atendente com resumo", () => {
  it("guarda o resumo no audit e no caderninho e manda ao dono", async () => {
    const conversationId = await createConversation();
    await addInbound(conversationId, "quero trocar o tamanho");
    assistant.enqueueScript({
      toolCalls: [
        {
          name: "transferir_para_atendente",
          input: {
            motivo: "quer trocar o tamanho",
            resumo: "Quer trocar o Dunas M por G.\nPedido #1000, comprado ontem.",
          },
        },
      ],
      replyTemplate: "Já chamo a equipe.",
    });
    const result = await runBotTurn(sdb, assistant, provider, { conversationId });
    expect(result).toEqual({ replied: true, handedOff: true });

    const [audit] = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "wa.bot_handoff"));
    expect(audit.after).toMatchObject({
      motivo: "quer trocar o tamanho",
      resumo: "Quer trocar o Dunas M por G.\nPedido #1000, comprado ontem.",
    });

    const state = await botState(conversationId);
    expect(state.handoff).toMatchObject({ motivo: "quer trocar o tamanho" });

    const [forward] = await db
      .select()
      .from(schema.outboxEvents)
      .where(eq(schema.outboxEvents.eventType, "wa.owner_forward"));
    expect((forward.payload as { body: string }).body).toContain("Pedido #1000, comprado ontem.");
  });
});

describe("modo ensaio (dryRun)", () => {
  it("nada com efeito externo acontece e o estado não é gravado", async () => {
    await createSimpleProduct("CANECA-AZUL", "Caneca Azul", 4990);
    await createRate("PAC", 1990);
    const conversationId = await createConversation();
    const executor = executorFor(conversationId, true);

    const sacola = await executor("adicionar_a_sacola", { sku: "CANECA-AZUL" });
    expect(sacola.ok).toBe(true);
    expect((await botState(conversationId)).cart).toBeUndefined();

    for (const [name, input] of [
      ["criar_pedido", { ...IDENTITY, itens: [{ sku: "CANECA-AZUL", quantidade: 1 }] }],
      ["avisar_dono", { mensagem: "teste" }],
      ["transferir_para_atendente", { motivo: "teste" }],
      ["enviar_chave_pix", {}],
    ] as const) {
      const result = await executor(name, input);
      expect(result.ok).toBe(true);
      expect(result.text).toContain("[Ensaio:");
      expect(result.endsTurn).toBeUndefined();
    }
    expect(await db.select().from(schema.orders)).toHaveLength(0);
    expect(await db.select().from(schema.outboxEvents)).toHaveLength(0);
    const [conversation] = await db.select().from(schema.waConversations);
    expect(conversation.status).toBe("open");
  });
});
