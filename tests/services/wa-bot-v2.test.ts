// Vendedora v2 (Onda 3): sacola real, frete escolhido pela cliente,
// caderninho injetado no turno, histórico com origem marcada, resposta em
// balões, catálogo com filtros/paginação, detalhe sem escolher em silêncio,
// transferência com resumo e modo ensaio (dryRun).
import { and, eq, ilike } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AssistantTurn,
  RespondTurnInput,
  SalesAssistant,
} from "@/adapters/assistant";
import { FakeSalesAssistant } from "@/adapters/assistant/fake";
import { FakeCepLookup } from "@/adapters/cep/fake";
import { FakeCorreiosQuoter } from "@/adapters/superfrete/fake";
import { FakeMessagingProvider } from "@/adapters/zapi/fake";
import * as schema from "@/db/schema";
import { formatCentsBRL } from "@/lib/money";
import type { DbOrTx } from "@/queue/enqueue";
import { BotTurnOutOfTimeError, buildToolExecutor, runBotTurn } from "@/services/wa-bot";
import { createTestDb, createTestVariant, type TestDb } from "../helpers/db";
import { nextMessageStamp } from "../helpers/clock";

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
      createdAt: nextMessageStamp(),
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
    createdAt: nextMessageStamp(),
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

function executorFor(conversationId: string, dryRun = false, cepLookup?: FakeCepLookup, correiosQuoter?: FakeCorreiosQuoter) {
  return buildToolExecutor(sdb, {
    conversationId,
    phoneE164: PHONE,
    customerId: null,
    lastInboundId: DUMMY_INBOUND_ID,
    ...(dryRun ? { dryRun: true } : {}),
    ...(cepLookup ? { cepLookup } : {}),
    ...(correiosQuoter ? { correiosQuoter } : {}),
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
    // Este recorder é só do turno de conversa; a ficha pela foto não passa por aqui.
    async extractFromPhotos() {
      throw new Error("extractFromPhotos não é usado neste teste");
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
      { sku: "CANECA-AZUL", variantId: expect.any(String), quantidade: 2, nome: "Caneca Azul", variacao: "", precoCents: 4990 },
    ]);
    expect(state.lastQuotes).toBeUndefined();

    const ver = await executor("ver_sacola", {});
    expect(ver.text).toContain("• 2× Caneca Azul — R$");
    expect(ver.text).toContain("[sku: CANECA-AZUL]");

    // Repetir a peça (o turno do "SIM") não dobra: quantidade é o total.
    const repetida = await executor("adicionar_a_sacola", { sku: "CANECA-AZUL" });
    expect(repetida.ok).toBe(true);
    expect(repetida.text).toContain("[Já estava na sacola: 2× Caneca Azul — nada mudou.");
    expect((await botState(conversationId)).cart).toMatchObject([{ quantidade: 2 }]);

    const naoTem = await executor("remover_da_sacola", { sku: "OUTRA" });
    expect(naoTem.ok).toBe(false);
    expect(naoTem.text).toContain('Nada na sacola casa com "OUTRA"');

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
    // Uma opção só: já é a escolhida (as duas chaves).
    expect(state.chosenRateId).toBeDefined();
    expect(state.chosenOptionKey).toBe(state.chosenRateId);
  });
});

describe("cotar_frete fora da área do motoboy", () => {
  it("sem faixa para o CEP: Correios com frete pela equipe — a Lia é instruída a transferir; o caderninho guarda o CEP e zera a cotação antiga", async () => {
    await createSimpleProduct("CANECA-AZUL", "Caneca Azul", 4990);
    await db.insert(schema.shippingRates).values({
      name: "Motoboy Belém",
      kind: "motoboy",
      cepStart: "66000000",
      cepEnd: "66999999",
      priceCents: 1500,
      deliveryWindows: [{ start: "16:00", end: "19:00", cutoff: "13:00" }],
    });
    await db.insert(schema.shippingRates).values({ name: "Motoboy Castanhal", kind: "motoboy", cepStart: "68740000", cepEnd: "68749999", priceCents: 1500, deliveryWindows: [{ start: "16:00", end: "19:00", cutoff: "13:00" }] });
    const cep = new FakeCepLookup();
    const conversationId = await createConversation();
    const executor = executorFor(conversationId, false, cep);
    await executor("adicionar_a_sacola", { sku: "CANECA-AZUL" });

    // Dentro da área: cotação normal (e fica no caderninho).
    const dentro = await executor("cotar_frete", { cep: "66010000" });
    expect(dentro.ok).toBe(true);
    expect(dentro.text).toContain("Motoboy Belém");
    expect((await botState(conversationId)).lastQuotes).toHaveLength(1);

    // Fora da área (São Paulo): sem valor, instrução de transferir, endereço do CEP para a equipe.
    const fora = await executor("cotar_frete", { cep: "01310100" });
    expect(fora.ok).toBe(true);
    expect(fora.text).toContain("Fora da área do motoboy (Belém e Castanhal)");
    expect(fora.text).toContain("CEP 01310-100");
    expect(fora.text).toContain("FRETE É CALCULADO PELA EQUIPE");
    expect(fora.text).toContain("Endereço do CEP: Avenida Paulista, Bela Vista — São Paulo/SP.");
    expect(fora.text).toContain("transferir_para_atendente");
    expect(fora.text).toContain("NÃO chame criar_pedido");
    const state = await botState(conversationId);
    expect(state.lastCep).toBe("01310100");
    expect(state.lastQuotes).toEqual([]);
    expect(state.chosenOptionKey).toBeUndefined();

    // Sem a cotação, criar_pedido não fecha com o frete antigo de Belém.
    const pedido = await executor("criar_pedido", { ...IDENTITY, frete: "Motoboy Belém" });
    expect(pedido.ok).toBe(false);
    expect(pedido.text).toContain("não há frete automático");
    expect(pedido.text).toContain("transferir_para_atendente");
    expect(pedido.text).not.toContain("Chame cotar_frete");

    // Só perguntou o frete (sacola vazia): explica, mas NÃO transfere — continua vendendo.
    await executor("remover_da_sacola", { sku: "CANECA-AZUL" });
    const soPergunta = await executor("cotar_frete", { cep: "01310100" });
    expect(soPergunta.ok).toBe(true);
    expect(soPergunta.text).toContain("NÃO transfira agora");
    expect(soPergunta.text).not.toContain("chame transferir_para_atendente");
  });
});

describe("cotar_frete fora da área com Correios automático (SuperFrete)", () => {
  async function enableCorreiosAuto(): Promise<void> {
    await db.insert(schema.settings).values([
      { key: "correios_auto_enabled", value: true },
      { key: "store_cep", value: "66045-335" },
      { key: "correios_surcharge_cents", value: 300 },
    ]);
    await db.insert(schema.shippingRates).values({
      name: "Motoboy Belém",
      kind: "motoboy",
      cepStart: "66000000",
      cepEnd: "66999999",
      priceCents: 1500,
      deliveryWindows: [{ start: "16:00", end: "19:00", cutoff: "13:00" }],
    });
  }

  it("fora da área a Lia recebe PAC e SEDEX com valor (já com a embalagem) e prazo em dias úteis, guarda as duas no caderninho e fecha o pedido com a escolhida", async () => {
    await enableCorreiosAuto();
    await createSimpleProduct("CANECA-AZUL", "Caneca Azul", 4990, { weightGrams: 800 });
    const correios = new FakeCorreiosQuoter();
    const conversationId = await createConversation();
    const executor = executorFor(conversationId, false, new FakeCepLookup(), correios);
    await executor("adicionar_a_sacola", { sku: "CANECA-AZUL" });

    const cotacao = await executor("cotar_frete", { cep: "01310-100" });
    expect(cotacao.ok).toBe(true);
    expect(cotacao.text).toContain(`1. PAC — ${formatCentsBRL(2590)} (6-9 dias úteis)`);
    expect(cotacao.text).toContain(`2. SEDEX — ${formatCentsBRL(4290)} (2-3 dias úteis)`);
    expect(cotacao.text).toContain("[Correios: o prazo é em dias úteis a partir da postagem");
    expect(cotacao.text).toContain("Pergunte à cliente qual opção ela prefere");
    expect(cotacao.text).not.toContain("FRETE É CALCULADO PELA EQUIPE");
    expect(correios.calls).toEqual([
      { fromCep: "66045335", toCep: "01310100", weightGrams: 800, package: { heightCm: 4, widthCm: 16, lengthCm: 24 }, services: ["PAC", "SEDEX"] },
    ]);

    const state = await botState(conversationId);
    expect(state.lastCep).toBe("01310100");
    expect(state.lastQuotes).toHaveLength(2);
    expect(state.chosenOptionKey).toBeUndefined();

    const pedido = await executor("criar_pedido", { ...IDENTITY, frete: "sedex" });
    expect(pedido.ok).toBe(true);
    const [order] = await db.select().from(schema.orders);
    expect(order.shippingCents).toBe(4290);
    expect(order.shippingService).toBe("SEDEX");
    expect(order.shippingQuoteId).toMatch(/^[0-9a-f-]{36}$/);
    expect(order.deliveryWindow).toBeNull();
    // A recotação do fechamento reaproveitou o cache: uma chamada só ao provedor.
    expect(correios.calls).toHaveLength(1);
  });

  it("cotação vencida no fechamento: a recotação reemite (id novo) e a guarda casa pelo nome; preço diferente na renovação recusa e pede nova cotação", async () => {
    await enableCorreiosAuto();
    await createSimpleProduct("CANECA-AZUL", "Caneca Azul", 4990, { weightGrams: 800 });
    const correios = new FakeCorreiosQuoter();
    const conversationId = await createConversation();
    const executor = executorFor(conversationId, false, undefined, correios);
    await executor("adicionar_a_sacola", { sku: "CANECA-AZUL" });
    await executor("cotar_frete", { cep: "01310-100" });

    // A cotação venceu entre a conversa e o fechamento (o cache também: a recotação gera ids novos, mesmo nome e preço).
    await db.update(schema.shippingQuotes).set({ expiresAt: new Date(Date.now() - 1000) });
    const pedido = await executor("criar_pedido", { ...IDENTITY, frete: "pac" });
    expect(pedido.ok).toBe(true);
    const [order] = await db.select().from(schema.orders);
    expect(order.shippingService).toBe("PAC");
    expect(order.shippingCents).toBe(2590);

    // Preço do provedor mudou na renovação: a guarda recusa e pede nova cotação.
    await executor("adicionar_a_sacola", { sku: "CANECA-AZUL" });
    await executor("cotar_frete", { cep: "01310-100" });
    await db.update(schema.shippingQuotes).set({ expiresAt: new Date(Date.now() - 1000) });
    correios.set([{ service: "PAC", serviceCode: "1", priceCents: 2990, deliveryDaysMin: 6, deliveryDaysMax: 9, raw: null }]);
    const recusa = await executor("criar_pedido", { ...IDENTITY, frete: "pac" });
    expect(recusa.ok).toBe(false);
    expect(recusa.text).toContain(`mudou de ${formatCentsBRL(2590)} para ${formatCentsBRL(3290)}`);
    expect(recusa.text).toContain("Chame cotar_frete de novo");
  });

  it("provedor fora do ar: o texto de 'frete pela equipe' de sempre, caderninho com cotação vazia; no ensaio (dryRun) a cotação também aparece", async () => {
    await enableCorreiosAuto();
    await createSimpleProduct("CANECA-AZUL", "Caneca Azul", 4990);
    const correios = new FakeCorreiosQuoter();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const conversationId = await createConversation();
    const executor = executorFor(conversationId, false, undefined, correios);
    await executor("adicionar_a_sacola", { sku: "CANECA-AZUL" });

    correios.failNext("timeout");
    const fora = await executor("cotar_frete", { cep: "01310100" });
    expect(fora.ok).toBe(true);
    expect(fora.text).toContain("FRETE É CALCULADO PELA EQUIPE");
    expect(fora.text).toContain("transferir_para_atendente");
    expect((await botState(conversationId)).lastQuotes).toEqual([]);

    const rehearsal = executorFor(conversationId, true, undefined, correios);
    const ensaio = await rehearsal("cotar_frete", { cep: "01310100" });
    expect(ensaio.ok).toBe(true);
    expect(ensaio.text).toContain(`1. PAC — ${formatCentsBRL(2590)}`);
    expect(ensaio.text).toContain(`2. SEDEX — ${formatCentsBRL(4290)}`);
    // O ensaio cota de verdade, mas não grava cache.
    expect(await db.$count(schema.shippingQuotes)).toBe(0);
    vi.restoreAllMocks();
  });
});

describe("cotar_frete com endereço pelo CEP", () => {
  it("com o adapter, a cotação traz rua/bairro/cidade/UF e guarda no caderninho; vendor fora não atrapalha", async () => {
    await createSimpleProduct("CANECA-AZUL", "Caneca Azul", 4990);
    await createRate("PAC", 1990);
    const cep = new FakeCepLookup();
    const conversationId = await createConversation();
    const executor = executorFor(conversationId, false, cep);

    const result = await executor("cotar_frete", { cep: "01310100" });
    expect(result.ok).toBe(true);
    expect(result.text).toContain("Endereço do CEP: Avenida Paulista, Bela Vista — São Paulo/SP.");
    expect(result.text).toContain("peça SÓ número e complemento");
    expect((await botState(conversationId)).lastCepAddress).toEqual({
      street: "Avenida Paulista",
      district: "Bela Vista",
      city: "São Paulo",
      state: "SP",
    });

    cep.failNext();
    const semEndereco = await executor("cotar_frete", { cep: "01310100" });
    expect(semEndereco.ok).toBe(true);
    expect(semEndereco.text).toContain("1. PAC");
    expect(semEndereco.text).not.toContain("Endereço do CEP");
    expect((await botState(conversationId)).lastCepAddress).toBeUndefined();
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
    // O CEP também sai: no próximo fechamento o frete tem de ser cotado de novo.
    expect(state.lastCep).toBeUndefined();
    expect(state.lastQuotedAt).toBeUndefined();
    expect(state.lastOrderNumber).toBe(order.orderNumber);
  });

  it("frete pelo nome (sem caixa) também vale", async () => {
    await createSimpleProduct("CANECA-AZUL", "Caneca Azul", 4990);
    await createRate("PAC", 1990);
    await createRate("SEDEX", 2990);
    const executor = executorFor(await createConversation());
    await executor("cotar_frete", { cep: IDENTITY.cep });
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
    await executor("cotar_frete", { cep: IDENTITY.cep });
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
// Fechamento só com o endereço e o frete que a cliente aprovou (#1012)
// ---------------------------------------------------------------------------

async function createRangedRate(
  name: string,
  priceCents: number,
  cepStart: string,
  cepEnd: string,
): Promise<string> {
  const [rate] = await db
    .insert(schema.shippingRates)
    .values({ name, priceCents, cepStart, cepEnd, deliveryDaysMin: 1, deliveryDaysMax: 3 })
    .returning({ id: schema.shippingRates.id });
  return rate.id;
}

type AddressFixture = {
  postalCode: string;
  street: string;
  number: string;
  district: string;
  city: string;
  state: string;
};

const BELEM: AddressFixture = {
  postalCode: "66045335",
  street: "Travessa Quintino Bocaiúva",
  number: "1500",
  district: "Batista Campos",
  city: "Belém",
  state: "PA",
};
const BENEVIDES: AddressFixture = {
  postalCode: "68795000",
  street: "Rua da Praça",
  number: "12",
  district: "Centro",
  city: "Benevides",
  state: "PA",
};
const VESTIDO_NA_SACOLA = {
  cart: [{ sku: "VEST-DUNAS-M", quantidade: 1, nome: "Vestido Dunas", variacao: "", precoCents: 28900 }],
};

/** Cliente já cadastrada com este telefone; o primeiro endereço é o padrão (e o mais antigo). */
async function createSavedCustomer(addresses: AddressFixture[]): Promise<string> {
  const [customer] = await db
    .insert(schema.customers)
    .values({
      fullName: "Marcielen Trindade",
      phoneE164: PHONE,
      documentType: "cpf",
      documentNumber: VALID_CPF,
    })
    .returning({ id: schema.customers.id });
  for (const [index, address] of addresses.entries()) {
    await db.insert(schema.customerAddresses).values({
      customerId: customer.id,
      ...address,
      isDefault: index === 0,
      createdAt: new Date(Date.now() - (addresses.length - index) * 86_400_000),
    });
  }
  return customer.id;
}

async function setupIncidente(): Promise<void> {
  await createSimpleProduct("VEST-DUNAS-M", "Vestido Dunas", 28900);
  await createRangedRate("Belém", 1000, "66000000", "66999999");
  await createRangedRate("Benevides", 800, "68795000", "68797999");
  await createSavedCustomer([BELEM, BENEVIDES]);
}

describe("fechamento só com endereço e frete aprovados (incidente #1012)", () => {
  it("cadastro com Belém (padrão) e Benevides, CEP de Benevides sem cotação: recusa; após cotar, fecha em Benevides a R$ 8,00", async () => {
    await setupIncidente();
    // O caderninho como estava: sacola montada hoje, CEP de outro dia, sem cotação.
    const conversationId = await createConversation({
      botState: { ...VESTIDO_NA_SACOLA, lastCep: "68795000" },
    });
    const executor = executorFor(conversationId);

    const semCotacao = await executor("criar_pedido", { usar_cadastro_salvo: true });
    expect(semCotacao.ok).toBe(false);
    expect(semCotacao.text).toContain("Ainda não há cotação de frete");
    expect(semCotacao.text).toContain("68795-000");
    expect(await db.select().from(schema.orders)).toHaveLength(0);

    const cotacao = await executor("cotar_frete", { cep: "68795000" });
    expect(cotacao.ok).toBe(true);
    expect(cotacao.text).toContain(`1. Benevides — ${formatCentsBRL(800)}`);
    expect(cotacao.text).not.toContain("Belém");

    const result = await executor("criar_pedido", { usar_cadastro_salvo: true });
    expect(result.ok).toBe(true);
    expect(result.text).toContain(`Frete (Benevides): ${formatCentsBRL(800)}`);
    expect(result.text).toContain(`TOTAL: ${formatCentsBRL(28900 + 800)}`);

    const [order] = await db.select().from(schema.orders);
    expect(order.shippingCents).toBe(800);
    expect(order.shippingAddress).toMatchObject({ city: "Benevides", postalCode: "68795000" });
    // Nome e CPF vieram do cadastro; a cliente não foi duplicada.
    expect(await db.select().from(schema.customers)).toHaveLength(1);

    const state = await botState(conversationId);
    expect(state.lastCep).toBeUndefined();
    expect(state.lastQuotedAt).toBeUndefined();
  });

  it("frete cotado para Belém e o modelo escreve 'Benevides': recusa listando só o que foi cotado", async () => {
    await setupIncidente();
    const conversationId = await createConversation({ botState: VESTIDO_NA_SACOLA });
    const executor = executorFor(conversationId);
    await executor("cotar_frete", { cep: "66045335" });

    const result = await executor("criar_pedido", { usar_cadastro_salvo: true, frete: "Benevides" });
    expect(result.ok).toBe(false);
    expect(result.text).toContain('"Benevides" não é nenhuma das cotadas');
    expect(result.text).toContain(`1. Belém — ${formatCentsBRL(1000)}`);
    expect(await db.select().from(schema.orders)).toHaveLength(0);
  });

  it("dois endereços salvos e nenhuma cotação: pede QUAL antes de cotar, com os CEPs", async () => {
    await setupIncidente();
    const executor = executorFor(await createConversation({ botState: VESTIDO_NA_SACOLA }));
    const result = await executor("criar_pedido", { usar_cadastro_salvo: true });
    expect(result.ok).toBe(false);
    expect(result.text).toContain("mais de um endereço salvo");
    expect(result.text).toContain("CEP 66045-335 (padrão)");
    expect(result.text).toContain("CEP 68795-000");
    expect(await db.select().from(schema.orders)).toHaveLength(0);
  });

  it("CEP cotado que não é de nenhum endereço salvo: pede confirmação ou o endereço novo completo", async () => {
    await createSimpleProduct("VEST-DUNAS-M", "Vestido Dunas", 28900);
    await createRate("PAC", 1990);
    await createSavedCustomer([BELEM]);
    const executor = executorFor(await createConversation({ botState: VESTIDO_NA_SACOLA }));
    await executor("cotar_frete", { cep: "04538132" });

    const result = await executor("criar_pedido", { usar_cadastro_salvo: true });
    expect(result.ok).toBe(false);
    expect(result.text).toContain("cotado para o CEP 04538-132, mas nenhum endereço salvo tem esse CEP");
    expect(result.text).toContain("Travessa Quintino Bocaiúva, 1500");
    expect(result.text).toContain("passe COMPLETO nos campos");
    expect(await db.select().from(schema.orders)).toHaveLength(0);
  });

  it("dois endereços salvos com o mesmo CEP: pede para confirmar qual", async () => {
    await createSimpleProduct("VEST-DUNAS-M", "Vestido Dunas", 28900);
    await createRate("PAC", 1990);
    await createSavedCustomer([BELEM, { ...BELEM, number: "200" }]);
    const executor = executorFor(await createConversation({ botState: VESTIDO_NA_SACOLA }));
    await executor("cotar_frete", { cep: "66045335" });

    const result = await executor("criar_pedido", { usar_cadastro_salvo: true });
    expect(result.ok).toBe(false);
    expect(result.text).toContain("Há 2 endereços salvos com o CEP 66045-335");
    expect(result.text).toContain("1500");
    expect(result.text).toContain("200");
    expect(await db.select().from(schema.orders)).toHaveLength(0);
  });

  it("usar_cadastro_salvo + endereço novo completo: nome e CPF do cadastro, entrega no endereço novo, cliente não duplicada", async () => {
    await createSimpleProduct("VEST-DUNAS-M", "Vestido Dunas", 28900);
    await createRate("PAC", 1990);
    const customerId = await createSavedCustomer([BELEM]);
    const executor = executorFor(await createConversation({ botState: VESTIDO_NA_SACOLA }));
    await executor("cotar_frete", { cep: "04538132" });

    const result = await executor("criar_pedido", {
      usar_cadastro_salvo: true,
      cep: "04538132",
      rua: "Rua Nova",
      numero: "7",
      bairro: "Itaim Bibi",
      cidade: "São Paulo",
      uf: "SP",
    });
    expect(result.ok).toBe(true);

    const [order] = await db.select().from(schema.orders);
    expect(order.customerId).toBe(customerId);
    expect(order.shippingAddress).toMatchObject({ street: "Rua Nova", city: "São Paulo", state: "SP" });
    expect(await db.select().from(schema.customers)).toHaveLength(1);
    const addresses = await db
      .select()
      .from(schema.customerAddresses)
      .orderBy(schema.customerAddresses.createdAt);
    expect(addresses).toHaveLength(2);
    // O endereço novo é guardado, mas o padrão continua o de antes.
    expect(addresses.map((a) => [a.city, a.isDefault])).toEqual([
      ["Belém", true],
      ["São Paulo", false],
    ]);
  });

  it("usar_cadastro_salvo + endereço pela metade: recusado antes de qualquer efeito", async () => {
    await createSimpleProduct("VEST-DUNAS-M", "Vestido Dunas", 28900);
    await createRate("PAC", 1990);
    await createSavedCustomer([BELEM]);
    const executor = executorFor(await createConversation({ botState: VESTIDO_NA_SACOLA }));
    await executor("cotar_frete", { cep: "04538132" });

    const result = await executor("criar_pedido", {
      usar_cadastro_salvo: true,
      cep: "04538132",
      numero: "7",
      bairro: "Itaim Bibi",
      cidade: "São Paulo",
      uf: "SP",
    });
    expect(result.ok).toBe(false);
    expect(result.text).toContain("falta rua");
    expect(await db.select().from(schema.orders)).toHaveLength(0);
  });

  it("cliente nova sem cotar_frete: recusa e nenhum pedido", async () => {
    await createSimpleProduct("CANECA-AZUL", "Caneca Azul", 4990);
    await createRate("PAC", 1990);
    const executor = executorFor(await createConversation());
    const result = await executor("criar_pedido", {
      ...IDENTITY,
      itens: [{ sku: "CANECA-AZUL", quantidade: 1 }],
    });
    expect(result.ok).toBe(false);
    expect(result.text).toContain("Ainda não há cotação de frete");
    expect(result.text).toContain("01310-100");
    expect(await db.select().from(schema.orders)).toHaveLength(0);
  });

  it("CEP cotado diferente do CEP do endereço: recusa citando os dois", async () => {
    await createSimpleProduct("CANECA-AZUL", "Caneca Azul", 4990);
    await createRate("PAC", 1990);
    const executor = executorFor(await createConversation());
    await executor("cotar_frete", { cep: "01310100" });
    const result = await executor("criar_pedido", {
      ...IDENTITY,
      cep: "04538132",
      itens: [{ sku: "CANECA-AZUL", quantidade: 1 }],
    });
    expect(result.ok).toBe(false);
    expect(result.text).toContain("cotado para o CEP 01310-100");
    expect(result.text).toContain("CEP 04538-132");
    expect(await db.select().from(schema.orders)).toHaveLength(0);
  });

  it("cotação antiga no caderninho: recusa e manda cotar de novo", async () => {
    await createSimpleProduct("CANECA-AZUL", "Caneca Azul", 4990);
    const rateId = await createRate("PAC", 1990);
    const executor = executorFor(
      await createConversation({
        botState: {
          lastCep: "01310100",
          lastQuotes: [{ rateId, name: "PAC", priceCents: 1990, deliveryDaysMin: 3, deliveryDaysMax: 10 }],
          lastQuotedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
          chosenRateId: rateId,
        },
      }),
    );
    const result = await executor("criar_pedido", {
      ...IDENTITY,
      itens: [{ sku: "CANECA-AZUL", quantidade: 1 }],
    });
    expect(result.ok).toBe(false);
    expect(result.text).toContain("antiga");
    expect(await db.select().from(schema.orders)).toHaveLength(0);
  });

  it("preço mudou entre a cotação e o fechamento: recusa com os dois valores", async () => {
    await createSimpleProduct("CANECA-AZUL", "Caneca Azul", 4990);
    await createRate("PAC", 1990);
    const sedexId = await createRate("SEDEX", 2990);
    const executor = executorFor(await createConversation());
    await executor("cotar_frete", { cep: "01310100" });
    await db
      .update(schema.shippingRates)
      .set({ priceCents: 3490 })
      .where(eq(schema.shippingRates.id, sedexId));

    const result = await executor("criar_pedido", {
      ...IDENTITY,
      itens: [{ sku: "CANECA-AZUL", quantidade: 1 }],
      frete: "2",
    });
    expect(result.ok).toBe(false);
    expect(result.text).toContain(`O frete SEDEX mudou de ${formatCentsBRL(2990)} para ${formatCentsBRL(3490)}`);
    expect(await db.select().from(schema.orders)).toHaveLength(0);
  });

  it("o número da opção aponta para a lista que a cliente viu, mesmo que a ordem de hoje seja outra", async () => {
    await createSimpleProduct("CANECA-AZUL", "Caneca Azul", 4990);
    const pacId = await createRate("PAC", 1990);
    await createRate("SEDEX", 2990);
    const executor = executorFor(await createConversation());
    const cotacao = await executor("cotar_frete", { cep: "01310100" });
    expect(cotacao.text).toContain("2. SEDEX");
    // PAC encareceu: hoje a lista por preço seria SEDEX (1), PAC (2).
    await db
      .update(schema.shippingRates)
      .set({ priceCents: 3990 })
      .where(eq(schema.shippingRates.id, pacId));

    const result = await executor("criar_pedido", {
      ...IDENTITY,
      itens: [{ sku: "CANECA-AZUL", quantidade: 1 }],
      frete: "2",
    });
    expect(result.ok).toBe(true);
    expect(result.text).toContain(`Frete (SEDEX): ${formatCentsBRL(2990)}`);
    const [order] = await db.select().from(schema.orders);
    expect(order.shippingCents).toBe(2990);
  });

  it("tarifa desativada depois da cotação: recusa e manda cotar de novo", async () => {
    await createSimpleProduct("CANECA-AZUL", "Caneca Azul", 4990);
    await createRate("PAC", 1990);
    const sedexId = await createRate("SEDEX", 2990);
    const executor = executorFor(await createConversation());
    await executor("cotar_frete", { cep: "01310100" });
    await db
      .update(schema.shippingRates)
      .set({ isActive: false })
      .where(eq(schema.shippingRates.id, sedexId));

    const result = await executor("criar_pedido", {
      ...IDENTITY,
      itens: [{ sku: "CANECA-AZUL", quantidade: 1 }],
      frete: "SEDEX",
    });
    expect(result.ok).toBe(false);
    expect(result.text).toContain("A opção SEDEX não está mais disponível para o CEP 01310-100");
    expect(await db.select().from(schema.orders)).toHaveLength(0);
  });

  it("buscar_cadastro lista os endereços com CEP, marca o cotado e avisa quando o CEP cotado não bate", async () => {
    await setupIncidente();
    const conversationId = await createConversation({ botState: VESTIDO_NA_SACOLA });
    const executor = executorFor(conversationId);

    const semCotacao = await executor("buscar_cadastro", {});
    expect(semCotacao.text).toContain("• Endereços salvos (2):");
    expect(semCotacao.text).toContain("CEP 66045-335 (padrão)");
    expect(semCotacao.text).toContain("CEP 68795-000");
    expect(semCotacao.text).toContain("EM QUAL destes endereços é a entrega");
    expect(semCotacao.text).not.toContain(VALID_CPF);

    await executor("cotar_frete", { cep: "68795000" });
    const cotado = await executor("buscar_cadastro", {});
    expect(cotado.text).toContain("CEP 68795-000 (CEP já cotado nesta conversa)");
    expect(cotado.text).not.toContain("ATENÇÃO");

    await createRate("PAC", 1990);
    await executor("cotar_frete", { cep: "04538132" });
    const semBater = await executor("buscar_cadastro", {});
    expect(semBater.text).toContain(
      "ATENÇÃO: o CEP cotado nesta conversa (04538-132) não é de nenhum endereço salvo",
    );
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

  it("os tempos do turno (fila, preparo, modelo, ferramentas, entrega, total, mensagem → 1º balão) vão no audit", async () => {
    const conversationId = await createConversation();
    await addInbound(conversationId, "oi");
    assistant.enqueueScript({
      toolCalls: [{ name: "ver_sacola", input: {} }],
      replyTemplate: "Sacola vazia por enquanto!",
    });
    const enqueuedAt = new Date(Date.now() - 1_500);
    // Prazo da fila curto demais (esperou o lock da conversa): o turno nem começa — erro próprio, sem chamar o modelo.
    await expect(runBotTurn(sdb, assistant, provider, { conversationId, enqueuedAt, deadlineAt: new Date(Date.now() + 12_000) })).rejects.toBeInstanceOf(BotTurnOutOfTimeError);
    expect(assistant.turns).toHaveLength(0);
    await runBotTurn(sdb, assistant, provider, { conversationId, enqueuedAt, source: "inline" });

    const [trail] = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "wa.bot_turn"));
    const timings = (trail.after as { timings: Record<string, number | string | null> }).timings;
    expect(timings.enqueuedAt).toBe(enqueuedAt.toISOString());
    expect(timings.source).toBe("inline");
    expect(timings.queueWaitMs).toBeGreaterThanOrEqual(1_500);
    expect(timings.queueWaitMs).toBeLessThan(60_000);
    for (const key of ["prepMs", "modelMs", "toolsMs", "deliveryMs", "totalMs", "inboundToFirstBubbleMs"]) {
      expect(typeof timings[key], key).toBe("number");
      expect(timings[key] as number, key).toBeGreaterThanOrEqual(0);
    }
    expect(timings.toolsMs as number).toBeLessThanOrEqual(timings.modelMs as number);
    expect(timings.totalMs as number).toBeGreaterThanOrEqual((timings.prepMs as number) + (timings.modelMs as number));
    expect((trail.after as { durationMs: number }).durationMs).toBe(timings.modelMs);
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
    expect(texto).toContain("12 peças encontradas — mostrando 11 a 12 (página 2 de 2; é a última)");
    expect(provider.sentOptionLists).toHaveLength(1);
    expect(provider.sentOptionLists[0].options).toHaveLength(2);
    expect(provider.sentOptionLists[0].message).toContain("(11–12 de 12)");
  });

  it("sem pagina, o catálogo inteiro vai em até 3 listas de uma vez, na ordem, depois do texto; a mesma pergunta em 30 min manda só a primeira", async () => {
    for (let i = 1; i <= 25; i++) {
      await createSimpleProduct(`PECA-${String(i).padStart(2, "0")}`, `Peça ${i}`, 1000 * i);
    }
    const conversationId = await createConversation();
    await addInbound(conversationId, "me mostra o catálogo");
    assistant.enqueueScript({
      toolCalls: [{ name: "listar_produtos", input: {} }],
      replyTemplate: (texts) => texts[0],
    });
    await runBotTurn(sdb, assistant, provider, { conversationId });

    const texto = assistant.turns[0].reply ?? "";
    expect(texto).toContain("25 peças encontradas — todas enviadas em 3 listas tocáveis.");
    expect(texto).toContain("• Peça 1 —");
    expect(texto).toContain("foi enviada ao cliente em 3 listas — o catálogo completo. Responda em 1 ou 2 frases curtas: diga que mandou o catálogo completo");
    expect(texto).not.toContain("passe pagina");
    expect(provider.sentOptionLists).toHaveLength(3);
    expect(provider.sentOptionLists.map((list) => list.options.length)).toEqual([10, 10, 5]);
    expect(provider.sentOptionLists.map((list) => list.message)).toEqual([
      "Toque abaixo e veja o catálogo 👇 (1–10 de 25)",
      "Toque abaixo e veja o catálogo 👇 (11–20 de 25)",
      "Toque abaixo e veja o catálogo 👇 (21–25 de 25)",
    ]);
    // Mais nova primeiro: a última linha da última lista é a peça mais antiga.
    expect(provider.sentOptionLists[2].options[4].title).toBe("Peça 1");
    // O balão de texto sai antes das três listas, que seguem na ordem.
    const seq = (id: string) => Number(id.split("-").at(-1));
    const listas = provider.sentOptionLists.map((list) => seq(list.providerMessageId));
    expect(listas[0]).toBeLessThan(listas[1]);
    expect(listas[1]).toBeLessThan(listas[2]);
    const balao = provider.sentMessages.find((m) => m.body.includes("25 peças encontradas"));
    expect(balao).toBeDefined();
    expect(seq(balao!.providerMessageId)).toBeLessThan(listas[0]);
    // As mensagens do turno têm created_at crescente: a thread e o histórico saem na ordem de envio.
    const rows = await db
      .select({ kind: schema.waMessages.kind, body: schema.waMessages.body, createdAt: schema.waMessages.createdAt })
      .from(schema.waMessages)
      .where(eq(schema.waMessages.conversationId, conversationId))
      .orderBy(schema.waMessages.createdAt, schema.waMessages.id);
    const ordem = rows.filter((row) => row.kind === "option_list" || row.body.includes("25 peças encontradas")).map((row) => (row.kind === "option_list" ? row.body.match(/\((\d+–\d+)/)?.[1] : "texto"));
    expect(ordem).toEqual(["texto", "1–10", "11–20", "21–25"]);

    // "Quero ver outra" logo depois: só a primeira lista de novo, e o modelo sabe que o resto já está na conversa.
    provider.sentOptionLists.length = 0;
    await addInbound(conversationId, "quero ver outra");
    assistant.enqueueScript({
      toolCalls: [{ name: "listar_produtos", input: {} }],
      replyTemplate: (texts) => texts[0],
    });
    await runBotTurn(sdb, assistant, provider, { conversationId });
    expect(provider.sentOptionLists).toHaveLength(1);
    expect(provider.sentOptionLists[0].message).toContain("(1–10 de 25)");
    const repetida = assistant.turns[1].reply ?? "";
    expect(repetida).toContain("25 peças encontradas — a 1ª lista reenviada; as listas 2 a 3 já estão na conversa");
    expect(repetida).toContain("Só chame pagina: 2 a 3 se ela disser que não acha as listas");
    expect(repetida).not.toContain("todas enviadas");
    expect(repetida).not.toContain("• Peça 1 —");
    // O histórico mostra as faixas das listas anteriores: o modelo sabe que o catálogo inteiro já está na conversa.
    expect(assistant.inputs[1].history.map((message) => message.text)).toContain("[lista tocável do catálogo (21–25 de 25) enviada ao cliente]");

    // Filtro diferente (outra chave) não conta como repetição: sai inteiro — mas respeita o teto do turno.
    provider.sentOptionLists.length = 0;
    await addInbound(conversationId, "e até 120 reais?");
    assistant.enqueueScript({
      toolCalls: [{ name: "listar_produtos", input: { preco_maximo_reais: 120 } }],
      replyTemplate: (texts) => texts[0],
    });
    await runBotTurn(sdb, assistant, provider, { conversationId });
    expect(provider.sentOptionLists).toHaveLength(2);
    expect(provider.sentOptionLists.map((list) => list.message)).toEqual([
      "Toque abaixo e veja o catálogo 👇 (1–10 de 12)",
      "Toque abaixo e veja o catálogo 👇 (11–12 de 12)",
    ]);
    expect(assistant.turns[2].reply ?? "").toContain(`12 peças encontradas (até ${formatCentsBRL(12000)}) — todas enviadas em 2 listas tocáveis.`);

    // A guarda expira: com as listas 2 e 3 enviadas há 31 min, o catálogo sai inteiro de novo.
    await db
      .update(schema.waMessages)
      .set({ createdAt: new Date(Date.now() - 31 * 60 * 1000) })
      .where(eq(schema.waMessages.conversationId, conversationId));
    provider.sentOptionLists.length = 0;
    await addInbound(conversationId, "manda o catálogo de novo");
    assistant.enqueueScript({
      toolCalls: [{ name: "listar_produtos", input: {} }],
      replyTemplate: (texts) => texts[0],
    });
    await runBotTurn(sdb, assistant, provider, { conversationId });
    expect(provider.sentOptionLists).toHaveLength(3);
  });

  it("lista do meio que falhou na Z-API não conta como entregue: o catálogo sai inteiro de novo e o histórico avisa que ela não chegou", async () => {
    for (let i = 1; i <= 25; i++) {
      await createSimpleProduct(`PECA-${String(i).padStart(2, "0")}`, `Peça ${i}`, 1000 * i);
    }
    const conversationId = await createConversation();
    await addInbound(conversationId, "catálogo");
    assistant.enqueueScript({ toolCalls: [{ name: "listar_produtos", input: {} }], replyTemplate: (texts) => texts[0] });
    await runBotTurn(sdb, assistant, provider, { conversationId });
    expect(provider.sentOptionLists).toHaveLength(3);
    // A 2ª lista "falhou" no provedor.
    await db
      .update(schema.waMessages)
      .set({ status: "failed" })
      .where(and(eq(schema.waMessages.conversationId, conversationId), eq(schema.waMessages.kind, "option_list"), ilike(schema.waMessages.body, "%(11–20 de 25)%")));

    provider.sentOptionLists.length = 0;
    await addInbound(conversationId, "quero ver outra");
    assistant.enqueueScript({ toolCalls: [{ name: "listar_produtos", input: {} }], replyTemplate: (texts) => texts[0] });
    await runBotTurn(sdb, assistant, provider, { conversationId });
    expect(provider.sentOptionLists).toHaveLength(3);
    expect(assistant.inputs[1].history.map((message) => message.text)).toContain("[lista tocável do catálogo (11–20 de 25) que NÃO chegou à cliente (falhou)]");
  });

  it("duas buscas no mesmo turno: a segunda leva só a primeira lista (teto de 3 por turno) e a nota manda esperar a próxima mensagem", async () => {
    for (let i = 1; i <= 25; i++) {
      await createSimpleProduct(`PECA-${String(i).padStart(2, "0")}`, `Peça ${i}`, 1000 * i);
    }
    const conversationId = await createConversation();
    await addInbound(conversationId, "me mostra tudo e também o que tem até 150");
    assistant.enqueueScript({
      toolCalls: [
        { name: "listar_produtos", input: {} },
        { name: "listar_produtos", input: { preco_maximo_reais: 150 } },
      ],
      replyTemplate: (texts) => texts.join("\n=====\n"),
    });
    await runBotTurn(sdb, assistant, provider, { conversationId });
    expect(provider.sentOptionLists.map((list) => list.message)).toEqual([
      "Toque abaixo e veja o catálogo 👇 (1–10 de 25)",
      "Toque abaixo e veja o catálogo 👇 (11–20 de 25)",
      "Toque abaixo e veja o catálogo 👇 (21–25 de 25)",
      "Toque abaixo e veja o catálogo 👇 (1–10 de 15)",
    ]);
    const segunda = ((assistant.turns[0].reply ?? "").split("=====")[1] ?? "").trim();
    expect(segunda).toContain(`15 peças encontradas (até ${formatCentsBRL(15000)}) — as 10 primeiras enviadas em 1 lista tocável.`);
    expect(segunda).toContain("Teto de 3 listas por mensagem já alcançado neste turno");
    expect(segunda).toContain("pagina: 2 numa PRÓXIMA mensagem dela");
  });

  it("acima de 30 peças: 3 listas e a nota de que há mais (pagina: 4, só numa próxima mensagem); página além do fim não reenvia nada", async () => {
    for (let i = 1; i <= 31; i++) {
      await createSimpleProduct(`PECA-${String(i).padStart(2, "0")}`, `Peça ${i}`, 1000 * i);
    }
    const conversationId = await createConversation();
    const attachments: { kind: string }[] = [];
    const executor = buildToolExecutor(sdb, { conversationId, phoneE164: PHONE, customerId: null, lastInboundId: DUMMY_INBOUND_ID, onAttachment: (a) => attachments.push(a) });
    const tudo = await executor("listar_produtos", {});
    expect(tudo.ok).toBe(true);
    expect(tudo.text).toContain("31 peças encontradas — as 30 primeiras enviadas em 3 listas tocáveis.");
    expect(tudo.text).toContain("[Há mais 1 peça além destas 30. NÃO chame pagina agora");
    expect(tudo.text).toContain("pagina: 4");
    expect(tudo.text).not.toContain("catálogo completo");
    expect(attachments.filter((a) => a.kind === "option_list")).toHaveLength(3);
    // Mais nova primeiro: a que fica de fora é a mais antiga.
    expect(tudo.text).not.toContain("• Peça 1 —");

    const pagina4 = await executor("listar_produtos", { pagina: 4 });
    expect(pagina4.text).toContain("mostrando 31 a 31 (página 4 de 4; é a última)");
    expect(pagina4.text).toContain("• Peça 1 —");

    const alem = await executor("listar_produtos", { pagina: 5 });
    expect(alem.ok).toBe(false);
    expect(alem.text).toContain("Não existe a página 5");
    expect(attachments.filter((a) => a.kind === "option_list")).toHaveLength(4);
  });
});

describe("sacola robusta (incidente de 18/09: SKU velho, remover pelo nome, sem duplicar)", () => {
  it("remover pelo nome como está na sacola, pelo SKU atual quando a linha guarda o velho, e ambíguo lista com [sku: …]", async () => {
    const { variantId } = await createSimpleProduct("CROPPED-IRIS-MARR-TAUN", "Cropped Íris", 4499);
    await createSimpleProduct("VEST-DUNAS-PRET-M", "Vestido Dunas", 28900);
    const conversationId = await createConversation();
    // A linha entrou quando a peça se chamava "Cropped Íris Suplex" e tinha outro SKU (a dona renomeou depois).
    await db
      .update(schema.waConversations)
      .set({
        botState: {
          cart: [
            { sku: "CROPPED-IRIS-SUPLEX-MARR-TAUN", variantId, quantidade: 1, nome: "Cropped Íris Suplex", variacao: "Marrom · Tam Único", precoCents: 4499 },
            { sku: "VEST-DUNAS-PRET-M", quantidade: 1, nome: "Vestido Dunas", variacao: "Preto · M", precoCents: 28900 },
          ],
        },
      })
      .where(eq(schema.waConversations.id, conversationId));
    const executor = executorFor(conversationId);

    // Pelo SKU atual (o que detalhar_produto devolve): a variante casa com a linha velha.
    const porSkuAtual = await executor("remover_da_sacola", { sku: "CROPPED-IRIS-MARR-TAUN" });
    expect(porSkuAtual.ok).toBe(true);
    expect(porSkuAtual.text).toContain("Tirei 1× Cropped Íris Suplex (Marrom · Tam Único) da sacola.");
    expect((await botState(conversationId)).cart).toMatchObject([{ sku: "VEST-DUNAS-PRET-M" }]);

    // Pelo nome, como a cliente fala.
    const porNome = await executor("remover_da_sacola", { sku: "vestido dunas preto" });
    expect(porNome.ok).toBe(true);
    expect((await botState(conversationId)).cart).toEqual([]);

    // Duas linhas parecidas: a ferramenta lista e pede o [sku: …].
    await db
      .update(schema.waConversations)
      .set({
        botState: {
          cart: [
            { sku: "CROPPED-IRIS-MARR-TAUN", variantId, quantidade: 1, nome: "Cropped Íris", variacao: "Marrom · Tam Único", precoCents: 4499 },
            { sku: "CROPPED-IRIS-PRET-TAUN", quantidade: 1, nome: "Cropped Íris", variacao: "Preto · Tam Único", precoCents: 4499 },
          ],
        },
      })
      .where(eq(schema.waConversations.id, conversationId));
    const ambiguo = await executor("remover_da_sacola", { sku: "cropped íris" });
    expect(ambiguo.ok).toBe(false);
    expect(ambiguo.text).toContain("serve para mais de uma linha");
    expect(ambiguo.text).toContain("[sku: CROPPED-IRIS-MARR-TAUN]");
    expect(ambiguo.text).toContain("[sku: CROPPED-IRIS-PRET-TAUN]");
  });

  it("ver_sacola cura a linha com SKU/nome velhos pela variante, junta a duplicata, e marca a peça que saiu de venda; criar_pedido manda tirar pelo nome", async () => {
    const { variantId } = await createSimpleProduct("CROPPED-IRIS-MARR-TAUN", "Cropped Íris", 4499);
    const morta = await createSimpleProduct("SAIA-LUA-P", "Saia Lua", 15900);
    await db.update(schema.productVariants).set({ isActive: false }).where(eq(schema.productVariants.id, morta.variantId));
    const conversationId = await createConversation();
    await db
      .update(schema.waConversations)
      .set({
        botState: {
          cart: [
            { sku: "CROPPED-IRIS-SUPLEX-MARR-TAUN", variantId, quantidade: 1, nome: "Cropped Íris Suplex", variacao: "Marrom · Tam Único", precoCents: 3999 },
            { sku: "CROPPED-IRIS-MARR-TAUN", variantId, quantidade: 1, nome: "Cropped Íris", variacao: "Marrom · Tam Único", precoCents: 4499 },
            { sku: "SAIA-LUA-P", variantId: morta.variantId, quantidade: 1, nome: "Saia Lua", variacao: "", precoCents: 15900 },
          ],
        },
      })
      .where(eq(schema.waConversations.id, conversationId));
    const executor = executorFor(conversationId);

    const ver = await executor("ver_sacola", {});
    expect(ver.ok).toBe(true);
    expect(ver.text).toContain("• 1× Cropped Íris — R$");
    expect(ver.text).toContain('[Linha "Cropped Íris Suplex (Marrom · Tam Único)": o SKU mudou de CROPPED-IRIS-SUPLEX-MARR-TAUN para CROPPED-IRIS-MARR-TAUN; o nome mudou de "Cropped Íris Suplex" para "Cropped Íris"; o PREÇO mudou de');
    expect(ver.text).toContain("[Linhas da mesma peça foram juntadas numa só");
    expect(ver.text).toContain('[A linha "Saia Lua" não está mais à venda');
    // A linha velha só aparece na nota da cura, não na sacola.
    expect(ver.text.split("\n").filter((line) => line.startsWith("•")).join("\n")).not.toContain("SUPLEX");
    const cart = (await botState(conversationId)).cart as { sku: string; quantidade: number; precoCents: number }[];
    expect(cart.map((item) => [item.sku, item.quantidade, item.precoCents])).toEqual([
      ["CROPPED-IRIS-MARR-TAUN", 1, 4499],
      ["SAIA-LUA-P", 1, 15900],
    ]);

    const pedido = await executor("criar_pedido", { ...IDENTITY, frete: "1" });
    expect(pedido.ok).toBe(false);
    expect(pedido.text).toContain('A sacola tem uma linha que não está mais à venda: "Saia Lua". Chame remover_da_sacola com esse nome');

    const tirou = await executor("remover_da_sacola", { sku: "Saia Lua" });
    expect(tirou.ok).toBe(true);
    expect((await botState(conversationId)).cart).toMatchObject([{ sku: "CROPPED-IRIS-MARR-TAUN" }]);
  });

  it("SKU reaproveitado por OUTRA peça não troca a linha em silêncio; linha velha da mesma variante + SKU atual vira uma linha só; linha da ponte (sem variantId) repetida é 'nada mudou'", async () => {
    // A dona apagou "Vestido Aurora" (SKU TRV-001) e criou "Blusa Brisa" com o mesmo SKU.
    const brisa = await createSimpleProduct("TRV-001", "Blusa Brisa", 9900);
    const { variantId: croppedId } = await createSimpleProduct("CROPPED-IRIS-MARR-TAUN", "Cropped Íris", 4499);
    const conversationId = await createConversation();
    await db
      .update(schema.waConversations)
      .set({
        botState: {
          cart: [
            { sku: "TRV-001", quantidade: 1, nome: "Vestido Aurora", variacao: "", precoCents: 28900 },
            { sku: "CROPPED-IRIS-SUPLEX-MARR-TAUN", variantId: croppedId, quantidade: 2, nome: "Cropped Íris Suplex", variacao: "", precoCents: 4499 },
          ],
        },
      })
      .where(eq(schema.waConversations.id, conversationId));
    const executor = executorFor(conversationId);

    const ver = await executor("ver_sacola", {});
    expect(ver.text).toContain('[O SKU TRV-001 hoje é de outra peça ("Blusa Brisa"); a linha "Vestido Aurora" não está mais à venda');
    expect(ver.text).not.toContain("1× Blusa Brisa");
    expect(ver.text).toContain("• 2× Cropped Íris — R$");
    // A linha da Blusa nunca entrou; o Cropped foi curado (SKU atual) sem duplicar.
    let cart = (await botState(conversationId)).cart as { sku: string; nome: string; quantidade: number }[];
    expect(cart.map((item) => [item.sku, item.nome, item.quantidade])).toEqual([
      ["TRV-001", "Vestido Aurora", 1],
      ["CROPPED-IRIS-MARR-TAUN", "Cropped Íris", 2],
    ]);

    // "Quero só uma": a Lia manda o SKU atual com quantidade 1 → ajusta a MESMA linha (não cria outra).
    const uma = await executor("adicionar_a_sacola", { sku: "CROPPED-IRIS-MARR-TAUN", quantidade: 1 });
    expect(uma.ok).toBe(true);
    expect(uma.text).toContain("Ajustei Cropped Íris de 2× para 1×");
    cart = (await botState(conversationId)).cart as { sku: string; nome: string; quantidade: number }[];
    expect(cart.filter((item) => item.sku === "CROPPED-IRIS-MARR-TAUN")).toHaveLength(1);
    expect(cart.find((item) => item.sku === "CROPPED-IRIS-MARR-TAUN")?.quantidade).toBe(1);

    // Linha que veio da ponte do site (sem variantId): repetir sem quantidade é "nada mudou" e a cotação fica.
    await db
      .update(schema.waConversations)
      .set({
        botState: {
          cart: [{ sku: "TRV-001", quantidade: 1, nome: "Blusa Brisa", variacao: "", precoCents: 9900 }],
          lastCep: "01310100",
          lastQuotes: [{ rateId: "x", name: "PAC", priceCents: 1, deliveryDaysMin: 1, deliveryDaysMax: 1 }],
          lastQuotedAt: new Date().toISOString(),
        },
      })
      .where(eq(schema.waConversations.id, conversationId));
    const repetida = await executor("adicionar_a_sacola", { sku: "TRV-001" });
    expect(repetida.ok).toBe(true);
    expect(repetida.text).toContain("nada mudou");
    expect(repetida.text).not.toContain("Ajustei");
    const state = await botState(conversationId);
    expect(state.lastQuotes).toHaveLength(1);
    expect((state.cart as { variantId?: string }[])[0].variantId).toBe(brisa.variantId);
  });

  it("preço que mudou no catálogo: ver_sacola avisa e criar_pedido pede o resumo de novo em vez de fechar com valor que a cliente não viu", async () => {
    const { variantId } = await createSimpleProduct("VEST-AURORA-M", "Vestido Aurora", 44990);
    const conversationId = await createConversation();
    await db
      .update(schema.waConversations)
      .set({ botState: { cart: [{ sku: "VEST-AURORA-M", variantId, quantidade: 1, nome: "Vestido Aurora", variacao: "", precoCents: 39900 }] } })
      .where(eq(schema.waConversations.id, conversationId));
    const executor = executorFor(conversationId);
    const pedido = await executor("criar_pedido", { ...IDENTITY, frete: "1" });
    expect(pedido.ok).toBe(false);
    expect(pedido.text).toContain("A sacola mudou desde o resumo");
    expect(pedido.text).toContain(`o PREÇO mudou de ${formatCentsBRL(39900)} para ${formatCentsBRL(44990)}`);
    // Curada e gravada: a segunda chamada já passa desta checagem (cai na cotação de frete, que não existe).
    const deNovo = await executor("criar_pedido", { ...IDENTITY, frete: "1" });
    expect(deNovo.text).not.toContain("A sacola mudou desde o resumo");
    expect((await botState(conversationId)).cart).toMatchObject([{ precoCents: 44990 }]);
  });

  it("busca por SKU é exata: '_' e '%' não são curingas (antes um '%' devolvia a primeira variante da tabela)", async () => {
    await createSimpleProduct("CANECA-AZUL", "Caneca Azul", 4990);
    const executor = executorFor(await createConversation());
    expect((await executor("adicionar_a_sacola", { sku: "CANECA_AZUL" })).ok).toBe(false);
    expect((await executor("adicionar_a_sacola", { sku: "%" })).ok).toBe(false);
    expect((await executor("adicionar_a_sacola", { sku: " caneca-azul " })).ok).toBe(true);
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
      .set({
        description: descricao,
        brand: "TRIVÉ",
        composition: "100% linho",
        careNotes: "hand_wash\ndry_shade\nNão torcer",
        fitNotes: "Caimento fluido",
        curatorNote: "Escolhi este linho pelo caimento no calor.",
        curatorAudioPath: `products/${productId}/nota-curadora-abc.webm`,
        curatorAudioMime: "audio/webm",
      })
      .where(eq(schema.products.id, productId));
    await db
      .update(schema.productVariants)
      .set({ measurements: { bust: 88, length: 110.5 } })
      .where(eq(schema.productVariants.id, variantId));
    await db
      .update(schema.priceVersions)
      .set({ compareAtPriceCents: 25900 })
      .where(eq(schema.priceVersions.productVariantId, variantId));
    const executor = executorFor(await createConversation());

    const result = await executor("detalhar_produto", { produto: "Vestido Um" });
    expect(result.text).toContain("Categoria: Vestidos · Marca: TRIVÉ");
    expect(result.text).toContain(descricao);
    expect(result.text).toContain(`Promoção: de ${formatCentsBRL(25900)} por ${formatCentsBRL(18900)}.`);
    // Ficha da peça e fita métrica entram no texto da Lia.
    expect(result.text).toContain("Composição: 100% linho");
    expect(result.text).toContain("Cuidados: Lavar à mão · Secar à sombra · Não torcer");
    expect(result.text).toContain("Como veste: Caimento fluido");
    // A nota da curadora, para a Lia citar — e o aviso do áudio na página.
    expect(result.text).toContain("Nota da curadora (cite com as palavras dela): «Escolhi este linho pelo caimento no calor.»");
    expect(result.text).toMatch(/A nota também está em áudio, na voz da curadora, na página da peça \(https?:\/\/[^)]+\/produto\/[a-z0-9-]+\)\./);
    expect(result.text.indexOf("Nota da curadora")).toBeLessThan(result.text.indexOf("Composição: 100% linho"));
    expect(result.text).toContain("Tabela de medidas da peça (cm, peça deitada):");
    expect(result.text).toContain("Único — busto 88, comprimento 110,5");

    await createSimpleProduct("SEM-DESC", "Peça Muda", 5000);
    const muda = await executor("detalhar_produto", { produto: "Peça Muda" });
    expect(muda.text).toContain("[Sem descrição cadastrada: não afirme tecido nem caimento");
    expect(muda.text).not.toContain("Nota da curadora");
    // Sem descrição mas com nota: a instrução manda ficar na nota, não "não afirme".
    await db.update(schema.products).set({ curatorNote: "Linho que respira." }).where(eq(schema.products.name, "Peça Muda"));
    const comNota = await executor("detalhar_produto", { produto: "Peça Muda" });
    expect(comNota.text).toContain("[Sem descrição cadastrada: sobre tecido e caimento, fique na nota da curadora e na ficha abaixo.]");
    expect(comNota.text).toContain("«Linho que respira.»");
    expect(muda.text).toContain("[Sem tabela de medidas cadastrada");
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

describe("criar_pedido com presente", () => {
  it("passa o presente ao pedido (sem preço na embalagem, bilhete dela) e entra no resumo", async () => {
    await createSimpleProduct("CANECA-AZUL", "Caneca Azul", 4990);
    await createRate("PAC", 1990);
    const conversationId = await createConversation();
    const executor = executorFor(conversationId);
    await executor("adicionar_a_sacola", { sku: "CANECA-AZUL", quantidade: 1 });
    await executor("cotar_frete", { cep: "01310100" });

    const result = await executor("criar_pedido", {
      ...IDENTITY,
      presente: { para: "minha mãe", bilhete: "Mãe, você é única 🤎", entregar_ate: "2026-10-05" },
    });
    expect(result.ok).toBe(true);
    expect(result.text).toContain("🎁 Presente para minha mãe — bilhete incluído, sem preço na embalagem.");

    const [order] = await db.select().from(schema.orders);
    expect(order.isGift).toBe(true);
    expect(order.giftRecipientName).toBe("minha mãe");
    expect(order.giftMessage).toBe("Mãe, você é única");
    expect(order.giftDeliverBy).toBe("2026-10-05");
    const events = await db.select().from(schema.outboxEvents);
    expect(events.map((event) => event.eventType)).toContain("order.gift_note");
  });

  it("entregar_ate fora do formato é recusado antes de criar o pedido", async () => {
    const conversationId = await createConversation();
    const executor = executorFor(conversationId);
    const result = await executor("criar_pedido", { ...IDENTITY, presente: { para: "Ana", entregar_ate: "05/10/2026" } });
    expect(result.ok).toBe(false);
    expect(result.text).toContain("AAAA-MM-DD");
    expect(await db.select().from(schema.orders)).toHaveLength(0);
  });
});
