// A vendedora com o cartão editorial: listar_produtos na primeira página com
// 2+ peças com foto manda a lista E o cartão (um por turno, melhor esforço,
// com interruptor); montar_look escolhe complementos reais e manda o look.
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeFileStorage } from "@/adapters/storage/fake";
import type { CardData } from "@/core/cards/types";
import * as schema from "@/db/schema";
import { formatCentsBRL } from "@/lib/money";
import type { DbOrTx } from "@/queue/enqueue";
import { createCityEdition, setCityEditionProducts } from "@/services/city-editions";
import { saveStyleProfile } from "@/services/style-profiles";
import { buildToolExecutor, type BotAttachment } from "@/services/wa-bot";
import { createTestDb, createTestVariant, FIXED_USER_ID, type TestDb } from "../helpers/db";

let db: TestDb;
let sdb: DbOrTx;
let close: () => Promise<void>;
let storage: FakeFileStorage;

const PHONE = "+5511999998888";
const CONVERSATION_ID = "00000000-0000-4000-8000-00000000c0de";

const render = vi.fn(async (_data: CardData) =>
  sharp({ create: { width: 108, height: 135, channels: 3, background: "#faf7f0" } }).png().toBuffer(),
);

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

async function createCategory(name: string, slug: string): Promise<string> {
  const [category] = await db.insert(schema.categories).values({ name, slug }).returning({ id: schema.categories.id });
  return category.id;
}

async function createProduct(
  sku: string,
  name: string,
  priceCents: number,
  opts: { categoryId?: string; photo?: boolean; onHand?: number } = {},
): Promise<string> {
  const { productId, variantId } = await createTestVariant(db, { sku, name, onHand: opts.onHand ?? 5 });
  await activatePrice(variantId, priceCents);
  if (opts.categoryId) {
    await db.update(schema.products).set({ categoryId: opts.categoryId }).where(eq(schema.products.id, productId));
  }
  if (opts.photo !== false) {
    const path = `products/${sku.toLowerCase()}/1-full.webp`;
    await db.insert(schema.productImages).values({ productId, storagePath: path, sortOrder: 0 });
    await storage.upload({
      path,
      data: await sharp({ create: { width: 600, height: 800, channels: 3, background: "#b08968" } }).webp().toBuffer(),
      contentType: "image/webp",
    });
  }
  return productId;
}

async function seedCatalog(): Promise<void> {
  const vestuario = await createCategory("Vestuário", "vestuario");
  const acessorios = await createCategory("Acessórios", "acessorios");
  await createProduct("DUNAS", "LONGO DUNAS", 30900, { categoryId: vestuario });
  await createProduct("TOTE", "Bolsa Tote de Algodão", 12900, { categoryId: acessorios });
  await createProduct("BONE", "Boné Bordado", 8900, { categoryId: acessorios });
  await createProduct("CAMISETA", "Camiseta Essencial", 7900, { categoryId: vestuario, photo: false });
}

const INBOUND_ID = "00000000-0000-4000-8000-00000000feed";

/** Por padrão em ensaio (dryRun): o cartão é desenhado inline. `real: true` = conversa de verdade (fila). */
function executor(opts: { cards?: boolean; real?: boolean } = {}) {
  const attachments: BotAttachment[] = [];
  const executeTool = buildToolExecutor(sdb, {
    conversationId: CONVERSATION_ID,
    phoneE164: PHONE,
    customerId: null,
    lastInboundId: INBOUND_ID,
    onAttachment: (attachment) => attachments.push(attachment),
    ...(opts.real ? {} : { dryRun: true }),
    ...(opts.cards === false ? {} : { cards: { storage, render } }),
  });
  return { executeTool, attachments };
}

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  sdb = db as unknown as DbOrTx;
  storage = new FakeFileStorage();
  render.mockClear();
  vi.stubEnv("ADAPTER_MODE", "fake");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://x.supabase.co");
  await db.insert(schema.waConversations).values({ id: CONVERSATION_ID, phoneE164: PHONE, status: "open" });
  await seedCatalog();
});

afterEach(async () => {
  await close();
  vi.unstubAllEnvs();
});

describe("listar_produtos + cartão editorial", () => {
  it("primeira página com 2+ peças com foto: lista tocável E cartão com até 3 fotos, e o modelo é avisado", async () => {
    const { executeTool, attachments } = executor();
    const result = await executeTool("listar_produtos", {});
    expect(result.ok).toBe(true);
    expect(attachments.map((attachment) => attachment.kind)).toEqual(["option_list", "image"]);
    const card = attachments[1];
    expect(card.kind === "image" && card.imageUrl.startsWith("memory://cards/")).toBe(true);
    expect(card.kind === "image" ? card.caption : "").toBe("Vitrine: Boné Bordado · Bolsa Tote de Algodão · LONGO DUNAS");
    expect(render).toHaveBeenCalledTimes(1);
    const data = render.mock.calls[0][0];
    expect(data.kind).toBe("catalog");
    expect(data.title).toBe("Três peças para você");
    expect(data.eyebrow).toBe("A VITRINE DE HOJE");
    expect(result.text).toContain("Um cartão com as fotos de");
    expect(await db.select().from(schema.botCards)).toHaveLength(1);
  });

  it("edicao: só as peças da Edição de Belém, na ordem da dona, com o eyebrow da edição; edição desconhecida é recusada sem inventar", async () => {
    const { editionId } = await createCityEdition(sdb, { isActive: true, fields: { name: "Edição Círio" }, userId: FIXED_USER_ID });
    const ids = await db.select({ id: schema.products.id, name: schema.products.name }).from(schema.products);
    const byName = new Map(ids.map((p) => [p.name, p.id]));
    await setCityEditionProducts(sdb, { editionId, productIds: [byName.get("Boné Bordado")!, byName.get("LONGO DUNAS")!], userId: FIXED_USER_ID });

    const { executeTool, attachments } = executor();
    const result = await executeTool("listar_produtos", { edicao: "círio" });
    expect(result.ok).toBe(true);
    expect(result.text).toContain("2 peças encontradas (edição Edição Círio)");
    const list = attachments[0];
    expect(list.kind === "option_list" ? list.options.map((o) => o.title) : []).toEqual(["Boné Bordado", "LONGO DUNAS"]);
    expect(render.mock.calls[0][0].eyebrow).toBe("EDIÇÃO EDIÇÃO CÍRIO".replace("EDIÇÃO EDIÇÃO", "EDIÇÃO EDIÇÃO"));

    const unknown = await executor().executeTool("listar_produtos", { edicao: "carnaval" });
    expect(unknown.ok).toBe(false);
    expect(unknown.text).toContain("Não existe a edição");
  });

  it("filtros viram o eyebrow; segunda página não manda cartão; um cartão por turno", async () => {
    const { executeTool, attachments } = executor();
    await executeTool("listar_produtos", { categoria: "acessorios" });
    expect(render.mock.calls[0][0].eyebrow).toBe("ACESSORIOS");
    expect(render.mock.calls[0][0].title).toBe("Duas peças para você");
    await executeTool("listar_produtos", {});
    expect(attachments.filter((attachment) => attachment.kind === "image")).toHaveLength(1);
    expect(render).toHaveBeenCalledTimes(1);

    // 13 peças com foto → a página 2 existe (2 peças com foto) e não manda cartão.
    for (let index = 1; index <= 10; index += 1) {
      await createProduct(`EXTRA${index}`, `Peça Extra ${index}`, 9900);
    }
    const second = executor();
    const result = await second.executeTool("listar_produtos", { pagina: 2 });
    expect(result.ok).toBe(true);
    expect(result.text).toContain("página 2 de 2");
    expect(second.attachments.map((attachment) => attachment.kind)).toEqual(["option_list"]);
  });

  it("com bot_cards_enabled=false, sem deps ou com render falhando: só a lista, e o texto segue", async () => {
    await db.insert(schema.settings).values({ key: "bot_cards_enabled", value: false });
    const off = executor();
    await off.executeTool("listar_produtos", {});
    expect(off.attachments.map((attachment) => attachment.kind)).toEqual(["option_list"]);
    expect(render).not.toHaveBeenCalled();
    await db.delete(schema.settings);

    const noDeps = executor({ cards: false });
    await noDeps.executeTool("listar_produtos", {});
    expect(noDeps.attachments.map((attachment) => attachment.kind)).toEqual(["option_list"]);

    render.mockRejectedValueOnce(new Error("satori caiu"));
    const failing = executor();
    const result = await failing.executeTool("listar_produtos", {});
    expect(result.ok).toBe(true);
    expect(result.text).not.toContain("Um cartão");
    expect(failing.attachments.map((attachment) => attachment.kind)).toEqual(["option_list"]);
  });

  it("o mesmo catálogo em outro turno vem do cache (sem novo render)", async () => {
    await executor().executeTool("listar_produtos", {});
    const again = executor();
    await again.executeTool("listar_produtos", {});
    expect(render).toHaveBeenCalledTimes(1);
    expect(again.attachments.map((attachment) => attachment.kind)).toEqual(["option_list", "image"]);
  });

  it("na conversa real, sem cache: só a lista sai no turno e o cartão vai para a fila wa.card_render", async () => {
    const { executeTool, attachments } = executor({ real: true });
    const result = await executeTool("listar_produtos", {});
    expect(attachments.map((attachment) => attachment.kind)).toEqual(["option_list"]);
    expect(render).not.toHaveBeenCalled();
    expect(result.text).toContain("chega logo depois da sua resposta");

    const events = await db.select().from(schema.outboxEvents);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: "wa.card_render",
      dedupeKey: `wa.card:${INBOUND_ID}`,
      aggregateId: CONVERSATION_ID,
    });
    expect(events[0].payload).toMatchObject({
      conversationId: CONVERSATION_ID,
      phoneE164: PHONE,
      customerId: null,
      lastInboundId: INBOUND_ID,
      caption: "Vitrine: Boné Bordado · Bolsa Tote de Algodão · LONGO DUNAS",
      request: { kind: "catalog", title: "Três peças para você", eyebrow: "A VITRINE DE HOJE" },
    });

    // Com o cartão já no cache (o ensaio desenhou), a conversa real anexa na hora.
    await executor().executeTool("listar_produtos", {});
    const warm = executor({ real: true });
    const warmResult = await warm.executeTool("listar_produtos", {});
    expect(warm.attachments.map((attachment) => attachment.kind)).toEqual(["option_list", "image"]);
    expect(warmResult.text).toContain("foi enviado junto com a lista");
    expect(await db.select().from(schema.outboxEvents)).toHaveLength(1);
  });
});

describe("montar_look", () => {
  it("escolhe complementos reais de outra família, manda o cartão do look e devolve o total", async () => {
    const { executeTool, attachments } = executor();
    const result = await executeTool("montar_look", { produto: "LONGO DUNAS" });
    expect(result.ok).toBe(true);
    expect(result.text).toContain(`Look com LONGO DUNAS (${formatCentsBRL(30900)})`);
    expect(result.text).toContain(`Bolsa Tote de Algodão — ${formatCentsBRL(12900)}`);
    expect(result.text).toContain(`Boné Bordado — ${formatCentsBRL(8900)}`);
    expect(result.text).toContain(`Total do look: ${formatCentsBRL(52700)}`);
    expect(result.text).toContain("cartão do look");
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({ kind: "image", caption: "Look: LONGO DUNAS + Bolsa Tote de Algodão + Boné Bordado" });
    const data = render.mock.calls[0][0];
    expect(data.kind).toBe("look");
    expect(data.title).toBe("Um look com LONGO DUNAS");
    expect(data.kind === "look" ? data.complements.map((item) => item.slug) : []).toEqual(["tote", "bone"]);
  });

  it("respeita o orçamento e, sem complemento honesto, diz isso sem cartão", async () => {
    const budget = executor();
    const result = await budget.executeTool("montar_look", { produto: "LONGO DUNAS", orcamento_reais: 400 });
    expect(result.text).toContain("Boné Bordado");
    expect(result.text).not.toContain("Bolsa Tote");

    const none = executor();
    const honest = await none.executeTool("montar_look", { produto: "LONGO DUNAS", orcamento_reais: 310 });
    expect(honest.ok).toBe(true);
    expect(honest.text).toContain("Não invente combinação");
    expect(none.attachments).toHaveLength(0);
  });

  it("cartela: peça só em cor que ela evita fica fora do look e a cor amada ganha; o modelo é avisado", async () => {
    // Bolsa Tote passa a existir só em vermelho; o Boné em terra.
    const [tote] = await db.select({ id: schema.productVariants.id }).from(schema.productVariants).where(eq(schema.productVariants.sku, "TOTE"));
    await db.update(schema.productVariants).set({ attributes: { cor: "Vermelho" } }).where(eq(schema.productVariants.id, tote.id));
    const [bone] = await db.select({ id: schema.productVariants.id }).from(schema.productVariants).where(eq(schema.productVariants.sku, "BONE"));
    await db.update(schema.productVariants).set({ attributes: { cor: "Terra" } }).where(eq(schema.productVariants.id, bone.id));
    await saveStyleProfile(sdb, {
      phoneE164: PHONE,
      source: "lia",
      patch: { colorsAvoid: ["vermelho"], colorsLove: ["terra"] },
    });

    const { executeTool } = executor();
    const result = await executeTool("montar_look", { produto: "LONGO DUNAS" });
    expect(result.ok).toBe(true);
    expect(result.text).toContain("Boné Bordado");
    expect(result.text).toContain("tem em Terra, cor que ela ama");
    expect(result.text).not.toContain("Bolsa Tote");
    expect(result.text).toContain("[Cartela considerada: peças só em vermelho ficaram de fora; preferência por terra.]");
    expect(result.text).toContain(`Total do look: ${formatCentsBRL(30900 + 8900)}`);
  });

  it("peça desconhecida ou ambígua orienta o modelo", async () => {
    const { executeTool } = executor();
    expect((await executeTool("montar_look", { produto: "Saia Inexistente" })).ok).toBe(false);
    await createProduct("DUNAS2", "LONGO DUNAS AREIA", 29900);
    const ambiguous = await executeTool("montar_look", { produto: "DUNAS" });
    expect(ambiguous.text).toMatch(/peças com "DUNAS" no nome|Look com/);
  });
});
