// A ponte do site: cada toque grava a peça (ou a sacola) com preço na hora e
// um código único entre pontes abertas; o link do WhatsApp leva a mensagem
// pronta; sem telefone da loja não há link; código repetido tenta de novo.
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { createSiteCart, getSiteCart, loadBridgeSettings, plainBridgeUrl } from "@/services/site-carts";
import { createTestDb, createTestVariant, type TestDb } from "../helpers/db";

let db: TestDb;
let sdb: DbOrTx;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  sdb = db as unknown as DbOrTx;
  await db.insert(schema.settings).values([
    { key: "store_whatsapp", value: "(91) 98888-7777" },
    { key: "bot_seller_name", value: "Lia" },
  ]);
});

afterEach(async () => {
  await close();
  vi.restoreAllMocks();
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

async function dunas() {
  const created = await createTestVariant(db, { sku: "DUNAS-AREIA-M", costCents: 9000, onHand: 3, name: "Longo Dunas" });
  await db
    .update(schema.products)
    .set({ slug: "longo-dunas", attributesSchema: ["cor", "tamanho"] })
    .where(eq(schema.products.id, created.productId));
  await db.update(schema.productVariants).set({ attributes: { cor: "Areia", tamanho: "M" } }).where(eq(schema.productVariants.id, created.variantId));
  await priced(created.variantId, 28900);
  return created;
}

describe("createSiteCart", () => {
  it("página da peça com variação: fotografa a peça, o preço e monta a mensagem com o código", async () => {
    const { productId } = await dunas();
    const link = await createSiteCart(sdb, { source: "pdp", productSlug: "longo-dunas", variantSku: "DUNAS-AREIA-M" });
    expect(link.code).toMatch(/^[A-Z2-9]{4}$/);
    expect(link.message).toBe(`Oi Lia, vi o Longo Dunas em areia · m (#${link.code})`);
    expect(link.waUrl).toBe(`https://wa.me/5591988887777?text=${encodeURIComponent(link.message)}`);
    const row = (await getSiteCart(sdb, link.id))!;
    expect(row).toMatchObject({ source: "pdp", productId, variantSku: "DUNAS-AREIA-M", consumedAt: null, conversationId: null });
    expect(row.items).toEqual([{ sku: "DUNAS-AREIA-M", name: "Longo Dunas", variation: "Areia · M", quantity: 1, priceCents: 28900 }]);
  });

  it("peça sem variação escolhida: só a peça; SKU inexistente cai na peça pelo slug", async () => {
    await dunas();
    const link = await createSiteCart(sdb, { source: "pdp", productSlug: "longo-dunas", variantSku: "NAO-EXISTE" });
    expect(link.message).toBe(`Oi Lia, vi o Longo Dunas (#${link.code})`);
    expect((await getSiteCart(sdb, link.id))!.items).toEqual([{ sku: "DUNAS-AREIA-M", name: "Longo Dunas", variation: "", quantity: 1, priceCents: 28900 }]);
  });

  it("sacola: cada linha com preço da hora; SKU que saiu do ar fica de fora sem derrubar", async () => {
    await dunas();
    const tote = await createTestVariant(db, { sku: "TOTE", costCents: 4000, onHand: 5, name: "Bolsa Tote" });
    await priced(tote.variantId, 12900);
    const link = await createSiteCart(sdb, {
      source: "cart",
      items: [
        { sku: "dunas-areia-m", quantity: 1 },
        { sku: "TOTE", quantity: 2 },
        { sku: "SUMIU", quantity: 1 },
      ],
    });
    expect(link.message).toBe(`Oi Lia, minha sacola no site: 1× Longo Dunas em areia · m, 2× Bolsa Tote (#${link.code})`);
    const row = (await getSiteCart(sdb, link.id))!;
    expect(row.items).toEqual([
      { sku: "DUNAS-AREIA-M", name: "Longo Dunas", variation: "Areia · M", quantity: 1, priceCents: 28900 },
      { sku: "TOTE", name: "Bolsa Tote", variation: "", quantity: 2, priceCents: 12900 },
    ]);
    expect(row.productId).toBeNull();
  });

  it("rodapé e story: sem peça; o slug do story fica guardado só no story", async () => {
    const footer = await createSiteCart(sdb, { source: "footer" });
    expect(footer.message).toBe(`Oi Lia, vim pelo site (#${footer.code})`);
    expect((await getSiteCart(sdb, footer.id))!.campaignSlug).toBeNull();
    await dunas();
    const story = await createSiteCart(sdb, { source: "campaign", campaignSlug: "verao", productSlug: "longo-dunas" });
    expect(story.message).toBe(`Oi Lia, vi o Longo Dunas no story (#${story.code})`);
    expect((await getSiteCart(sdb, story.id))!.campaignSlug).toBe("verao");
    // Fora do story, o slug de campanha é ignorado.
    const pdp = await createSiteCart(sdb, { source: "pdp", campaignSlug: "verao", productSlug: "longo-dunas" });
    expect((await getSiteCart(sdb, pdp.id))!.campaignSlug).toBeNull();
  });

  it("sem WhatsApp da loja não há link (o botão nem aparece); o nome da vendedora vem da ficha", async () => {
    await db.update(schema.settings).set({ value: "" }).where(eq(schema.settings.key, "store_whatsapp"));
    await db.update(schema.settings).set({ value: "Marina" }).where(eq(schema.settings.key, "bot_seller_name"));
    const settings = await loadBridgeSettings(sdb);
    expect(settings).toEqual({ storeWhatsapp: "", sellerName: "Marina" });
    expect(plainBridgeUrl(settings)).toBeNull();
    const link = await createSiteCart(sdb, { source: "footer" });
    expect(link.waUrl).toBeNull();
    expect(link.message).toBe(`Oi Marina, vim pelo site (#${link.code})`);
  });

  it("código repetido entre pontes abertas: tenta outro; consumida, o código pode voltar", async () => {
    // O aleatório fixo faz o primeiro código ser sempre "AAAA".
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    const first = await createSiteCart(sdb, { source: "footer" });
    expect(first.code).toBe("AAAA");
    // Próximo toque: "AAAA" colide; o retry sorteia "BBBB".
    random.mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(1 / 30);
    const second = await createSiteCart(sdb, { source: "footer" });
    expect(second.code).toBe("BBBB");
    // Ponte consumida libera o código para uma nova.
    await db.update(schema.siteCarts).set({ consumedAt: new Date() }).where(eq(schema.siteCarts.id, first.id));
    random.mockReturnValue(0);
    const third = await createSiteCart(sdb, { source: "footer" });
    expect(third.code).toBe("AAAA");
    expect(third.id).not.toBe(first.id);
  });

  it("sacola pelo id da variação: SKU renomeado depois da sacola não perde a linha; SKU só é reserva", async () => {
    const { variantId } = await dunas();
    await db.update(schema.productVariants).set({ sku: "LD-AREIA-M" }).where(eq(schema.productVariants.id, variantId));
    const byId = await createSiteCart(sdb, { source: "cart", items: [{ variantId, sku: "DUNAS-AREIA-M", quantity: 2 }] });
    expect((await getSiteCart(sdb, byId.id))!.items).toEqual([
      { sku: "LD-AREIA-M", name: "Longo Dunas", variation: "Areia · M", quantity: 2, priceCents: 28900 },
    ]);
    // Só o SKU (sacolas antigas no celular): compara exato, sem curinga.
    const bySku = await createSiteCart(sdb, { source: "cart", items: [{ sku: "ld-areia-m", quantity: 1 }] });
    expect((await getSiteCart(sdb, bySku.id))!.items).toHaveLength(1);
    const wildcard = await createSiteCart(sdb, { source: "cart", items: [{ sku: "%", quantity: 1 }] });
    expect((await getSiteCart(sdb, wildcard.id))!.items).toEqual([]);
    expect(wildcard.message).toBe(`Oi Lia, vim pelo site (#${wildcard.code})`);
  });

  it("peça de lançamento ainda escondida (janela VIP) não entra na ponte pública, nem por SKU nem por id", async () => {
    const { productId, variantId } = await dunas();
    await db.update(schema.products).set({ visibleFrom: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) }).where(eq(schema.products.id, productId));
    const link = await createSiteCart(sdb, { source: "cart", items: [{ variantId, quantity: 1 }, { sku: "DUNAS-AREIA-M", quantity: 1 }] });
    expect((await getSiteCart(sdb, link.id))!.items).toEqual([]);
    const pdp = await createSiteCart(sdb, { source: "pdp", productSlug: "longo-dunas", variantSku: "DUNAS-AREIA-M" });
    expect(pdp.message).toBe(`Oi Lia, vim pelo site (#${pdp.code})`);
    expect((await getSiteCart(sdb, pdp.id))!.productId).toBeNull();
  });

  it("sacola grande (mais de 20 linhas ou de 20 unidades) entra inteira: os tetos são os da sacola", async () => {
    const { variantId } = await dunas();
    const link = await createSiteCart(sdb, { source: "cart", items: [{ variantId, quantity: 24 }] });
    expect((await getSiteCart(sdb, link.id))!.items).toEqual([expect.objectContaining({ quantity: 24 })]);
    const lines = Array.from({ length: 30 }, () => ({ variantId, quantity: 1 }));
    const many = await createSiteCart(sdb, { source: "cart", items: lines });
    expect((await getSiteCart(sdb, many.id))!.items).toHaveLength(30);
  });

  it("entrada inválida é recusada na fronteira", async () => {
    await expect(createSiteCart(sdb, { source: "pdp", items: [{ sku: "x", quantity: 0 }] })).rejects.toThrow();
    await expect(createSiteCart(sdb, { source: "loja" as never })).rejects.toThrow();
  });
});
