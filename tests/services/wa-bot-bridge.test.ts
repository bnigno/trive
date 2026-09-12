// A ponte do site dentro do turno da Lia (PGlite + FakeSalesAssistant): o
// caderninho abre com "Veio do site" e, se a ponte é recente (1 h), com o
// estoque ao vivo das peças que ela estava vendo — sem ferramenta, para a
// Lia não inventar disponibilidade. Ponte velha não gasta consulta. Quando
// o pedido fecha nessa conversa, a ponte ganha o order_id (o funil conta a
// venda) — e só a ponte dessa conversa.
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeSalesAssistant } from "@/adapters/assistant/fake";
import { FakeMessagingProvider } from "@/adapters/zapi/fake";
import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { consumeSiteCartByCode, createSiteCart } from "@/services/site-carts";
import { runBotTurn } from "@/services/wa-bot";
import { createTestDb, createTestVariant, type TestDb } from "../helpers/db";

let db: TestDb;
let sdb: DbOrTx;
let close: () => Promise<void>;
let assistant: FakeSalesAssistant;
let provider: FakeMessagingProvider;

const PHONE = "+5591988880000";
const VALID_CPF = "52998224725";

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  sdb = db as unknown as DbOrTx;
  assistant = new FakeSalesAssistant();
  provider = new FakeMessagingProvider();
  vi.stubEnv("ADAPTER_MODE", "fake");
  await db.insert(schema.settings).values([
    { key: "wa_enabled", value: true },
    { key: "bot_enabled", value: true },
    { key: "store_whatsapp", value: "(91) 98888-7777" },
    { key: "bot_seller_name", value: "Lia" },
  ]);
});

afterEach(async () => {
  await close();
  vi.unstubAllEnvs();
});

async function priced(variantId: string, priceCents: number) {
  await db.insert(schema.priceVersions).values({
    productVariantId: variantId,
    versionNumber: 1,
    status: "active",
    priceCents,
    origin: "initial",
    breakdown: {},
    costSnapshotCents: 9000,
    computedMarginRate: "0.3000",
    activatedAt: new Date(),
  });
}

async function dunas(onHand = 3) {
  const created = await createTestVariant(db, { sku: "DUNAS-AREIA-M", costCents: 9000, onHand, name: "Longo Dunas" });
  await db.update(schema.products).set({ slug: "longo-dunas", attributesSchema: ["cor", "tamanho"] }).where(eq(schema.products.id, created.productId));
  await db.update(schema.productVariants).set({ attributes: { cor: "Areia", tamanho: "M" } }).where(eq(schema.productVariants.id, created.variantId));
  await priced(created.variantId, 28900);
  return created;
}

async function createConversation(phoneE164 = PHONE): Promise<string> {
  const [conversation] = await db
    .insert(schema.waConversations)
    .values({ phoneE164, status: "open" })
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
      createdAt: new Date(Date.now() - 60_000 + inboundSequence * 1000),
    })
    .returning({ id: schema.waMessages.id });
  return message.id;
}

/** Simula o que o inbound faz: consome a ponte e guarda no caderninho. */
async function bridgeInto(conversationId: string, code: string, at = new Date()) {
  const bridge = (await consumeSiteCartByCode(sdb, { code, conversationId, now: at }))!;
  const { mergeBridgeIntoState, parseBotState } = await import("@/core/bot/memory");
  const [row] = await db.select({ botState: schema.waConversations.botState }).from(schema.waConversations).where(eq(schema.waConversations.id, conversationId));
  await db
    .update(schema.waConversations)
    .set({ botState: mergeBridgeIntoState(parseBotState(row.botState), { ...bridge, at: at.toISOString() }) })
    .where(eq(schema.waConversations.id, conversationId));
  return bridge;
}

describe("runBotTurn com a ponte do site", () => {
  it("ponte recente: o caderninho abre com 'Veio do site' e traz o estoque ao vivo da peça", async () => {
    await dunas(3);
    const link = await createSiteCart(sdb, { source: "pdp", productSlug: "longo-dunas", variantSku: "DUNAS-AREIA-M" });
    const conversationId = await createConversation();
    await bridgeInto(conversationId, link.code);
    await addInbound(conversationId, link.message);
    assistant.enqueueScript({ replyTemplate: "Oi! O Longo Dunas em areia, M, tem 3 na maison. Quer que eu guarde?" });

    const result = await runBotTurn(sdb, assistant, provider, { conversationId });
    expect(result).toEqual({ replied: true, handedOff: false });

    const note = assistant.inputs[0].history[0];
    expect(note.role).toBe("user");
    expect(note.text).toContain("CADERNINHO");
    expect(note.text).toContain("• Veio do site agora (página da peça): Longo Dunas (Areia · M)");
    expect(note.text).toContain("• Peça em vista: Longo Dunas");
    expect(note.text).toContain("Estoque agora das peças da ponte: Longo Dunas (Areia · M): 3 disponíveis, SKU DUNAS-AREIA-M");
    // A mensagem da cliente segue depois do caderninho.
    expect(assistant.inputs[0].history[1]).toEqual({ role: "user", text: link.message });
  });

  it("peça esgotada ou fora do catálogo: o estoque diz isso com todas as letras", async () => {
    const { variantId } = await dunas(0);
    const link = await createSiteCart(sdb, { source: "pdp", productSlug: "longo-dunas", variantSku: "DUNAS-AREIA-M" });
    const conversationId = await createConversation();
    await bridgeInto(conversationId, link.code);
    await addInbound(conversationId, link.message);
    await runBotTurn(sdb, assistant, provider, { conversationId });
    expect(assistant.inputs[0].history[0].text).toContain("Longo Dunas (Areia · M): esgotada, SKU DUNAS-AREIA-M");

    // Peça desativada DEPOIS do toque: a sacola fotografou a peça; a Lia só
    // descobre no turno que ela "saiu do catálogo".
    const other = await createConversation("+5591977770000");
    const link2 = await createSiteCart(sdb, { source: "cart", items: [{ sku: "DUNAS-AREIA-M", quantity: 1 }] });
    expect(link2.message).toContain("Longo Dunas");
    await bridgeInto(other, link2.code);
    await db.update(schema.productVariants).set({ isActive: false }).where(eq(schema.productVariants.id, variantId));
    await addInbound(other, link2.message);
    await runBotTurn(sdb, assistant, provider, { conversationId: other });
    expect(assistant.inputs[1].history[0].text).toContain("Longo Dunas (Areia · M): saiu do catálogo");
  });

  it("ponte velha (mais de 1 h): 'Veio do site há N h' fica, mas o estoque ao vivo não é consultado", async () => {
    await dunas(3);
    const link = await createSiteCart(sdb, { source: "pdp", productSlug: "longo-dunas", variantSku: "DUNAS-AREIA-M" });
    const conversationId = await createConversation();
    await bridgeInto(conversationId, link.code, new Date(Date.now() - 3 * 60 * 60 * 1000));
    await addInbound(conversationId, "oi, ainda tem?");
    await runBotTurn(sdb, assistant, provider, { conversationId });
    const text = assistant.inputs[0].history[0].text;
    expect(text).toContain("• Veio do site há 3 h (página da peça): Longo Dunas (Areia · M)");
    expect(text).not.toContain("Estoque agora");
  });

  it("criar_pedido nessa conversa: a ponte ganha o pedido; a ponte de outra conversa fica intacta", async () => {
    await dunas(3);
    await db.insert(schema.shippingRates).values({ name: "PAC", priceCents: 1990 });
    const mine = await createSiteCart(sdb, { source: "pdp", productSlug: "longo-dunas", variantSku: "DUNAS-AREIA-M" });
    const theirs = await createSiteCart(sdb, { source: "footer" });
    const conversationId = await createConversation();
    const otherConversation = await createConversation("+5591977770000");
    await bridgeInto(conversationId, mine.code);
    await bridgeInto(otherConversation, theirs.code);
    await addInbound(conversationId, "quero fechar");

    assistant.enqueueScript({
      toolCalls: [
        { name: "cotar_frete", input: { cep: "66010000" } },
        {
          name: "criar_pedido",
          input: {
            itens: [{ sku: "DUNAS-AREIA-M", quantidade: 1 }],
            nome_completo: "Ana Cliente",
            cpf: VALID_CPF,
            cep: "66010000",
            rua: "Avenida Nazaré",
            numero: "100",
            bairro: "Nazaré",
            cidade: "Belém",
            uf: "PA",
          },
        },
      ],
      replyTemplate: (toolTexts) => toolTexts[toolTexts.length - 1],
    });
    const result = await runBotTurn(sdb, assistant, provider, { conversationId });
    expect(result).toEqual({ replied: true, handedOff: false });
    expect(assistant.turns[0].toolCalls.map((c) => c.ok)).toEqual([true, true]);

    const [order] = await db.select().from(schema.orders);
    const carts = await db.select().from(schema.siteCarts);
    const attributed = carts.find((c) => c.id === mine.id)!;
    const untouched = carts.find((c) => c.id === theirs.id)!;
    expect(attributed.orderId).toBe(order.id);
    expect(attributed.conversationId).toBe(conversationId);
    expect(untouched.orderId).toBeNull();
    expect(untouched.conversationId).toBe(otherConversation);
  });
});
