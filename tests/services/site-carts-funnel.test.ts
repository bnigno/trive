// "De onde vieram": por origem (e por link de story), no período, toques →
// conversas → pedidos → pagos; conta pontes, não clientes; o rótulo do link
// dá nome ao story; fora do período fica de fora; sem toque, vazio.
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { mergeBridgeIntoState, parseBotState } from "@/core/bot/memory";
import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { createCampaignLink, tapCampaignLink } from "@/services/campaign-links";
import { consumeSiteCartByCode, createSiteCart, siteBridgeFunnel } from "@/services/site-carts";
import { listWaConversations } from "@/services/wa-conversations";
import { createTestDb, createTestVariant, FIXED_USER_ID, type TestDb } from "../helpers/db";

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
});

async function dunas() {
  const created = await createTestVariant(db, { sku: "DUNAS-AREIA-M", costCents: 9000, onHand: 3, name: "Longo Dunas" });
  await db.update(schema.products).set({ slug: "longo-dunas" }).where(eq(schema.products.id, created.productId));
  await db.insert(schema.priceVersions).values({
    productVariantId: created.variantId,
    versionNumber: 1,
    status: "active",
    priceCents: 28900,
    origin: "initial",
    breakdown: {},
    costSnapshotCents: 9000,
    computedMarginRate: "0.3000",
    activatedAt: new Date(),
  });
  return created;
}

/** O que o inbound faz ao ver o código: consome a ponte e guarda no caderninho. */
async function bridgeInto(conversationId: string, code: string, now: Date) {
  const bridge = (await consumeSiteCartByCode(sdb, { code, conversationId, now }))!;
  const [row] = await db.select({ botState: schema.waConversations.botState }).from(schema.waConversations).where(eq(schema.waConversations.id, conversationId));
  await db
    .update(schema.waConversations)
    .set({ botState: mergeBridgeIntoState(parseBotState(row.botState), bridge) })
    .where(eq(schema.waConversations.id, conversationId));
}

async function conversation(phone: string) {
  const [row] = await db.insert(schema.waConversations).values({ phoneE164: phone }).returning({ id: schema.waConversations.id });
  return row.id;
}

async function order(customerPhone: string, paid: boolean) {
  const [customer] = await db.insert(schema.customers).values({ fullName: "Ana", phoneE164: customerPhone }).returning({ id: schema.customers.id });
  const [row] = await db
    .insert(schema.orders)
    .values({
      customerId: customer.id,
      status: paid ? "paid" : "pending_payment",
      channel: "whatsapp",
      subtotalCents: 28900,
      totalCents: 28900,
      ...(paid ? { paidAt: new Date() } : {}),
    })
    .returning({ id: schema.orders.id });
  return row.id;
}

describe("siteBridgeFunnel", () => {
  it("agrupa por origem e por link, com toques → conversas → pedidos → pagos (e a soma), ordenado por toques", async () => {
    const { productId } = await dunas();
    await createCampaignLink(sdb, { slug: "dunas", label: "Dunas no story", productId, userId: FIXED_USER_ID });
    const now = new Date();

    // Página da peça: 2 toques, 1 conversa, 1 pedido pago — ligado às DUAS
    // pontes (defesa: dinheiro e pedido contam uma vez).
    const pdp1 = await createSiteCart(sdb, { source: "pdp", productSlug: "longo-dunas" });
    const pdp2 = await createSiteCart(sdb, { source: "pdp", productSlug: "longo-dunas" });
    const c1 = await conversation("+5591988880001");
    await bridgeInto(c1, pdp1.code, now);
    const paid = await order("+5591988880001", true);
    await db.update(schema.siteCarts).set({ orderId: paid }).where(eq(schema.siteCarts.id, pdp1.id));
    await db.update(schema.siteCarts).set({ orderId: paid }).where(eq(schema.siteCarts.id, pdp2.id));

    // Story «dunas»: 3 toques, 2 códigos na MESMA conversa (= 1 conversa), 1 pedido sem pagar.
    const s1 = (await tapCampaignLink(sdb, { slug: "dunas" }))!;
    const s2 = (await tapCampaignLink(sdb, { slug: "dunas" }))!;
    await tapCampaignLink(sdb, { slug: "dunas" });
    const c2 = await conversation("+5591988880002");
    await bridgeInto(c2, s1.code, now);
    await bridgeInto(c2, s2.code, now);
    const unpaid = await order("+5591988880002", false);
    await db.update(schema.siteCarts).set({ orderId: unpaid }).where(eq(schema.siteCarts.id, s1.id));
    // A cliente da página da peça também tocou no story: no total é UMA conversa a mais, não duas.
    const s3 = (await tapCampaignLink(sdb, { slug: "dunas" }))!;
    await bridgeInto(c1, s3.code, now);
    // Pedido pago e depois reembolsado não é venda (regra dos Relatórios).
    const refunded = await order("+5591988880009", true);
    await db.update(schema.orders).set({ status: "refunded" }).where(eq(schema.orders.id, refunded));
    const s4 = (await tapCampaignLink(sdb, { slug: "dunas" }))!;
    await bridgeInto(c2, s4.code, now);
    await db.update(schema.siteCarts).set({ orderId: refunded }).where(eq(schema.siteCarts.id, s4.id));

    // Rodapé: 1 toque, nada mais. Sacola: 1 toque, fora do período (40 dias atrás).
    await createSiteCart(sdb, { source: "footer" });
    const old = await createSiteCart(sdb, { source: "cart", items: [{ sku: "DUNAS-AREIA-M", quantity: 1 }] });
    await db.update(schema.siteCarts).set({ createdAt: new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000) }).where(eq(schema.siteCarts.id, old.id));

    const funnel = await siteBridgeFunnel(sdb, { from: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000), to: new Date(now.getTime() + 60_000) });
    expect(funnel.rows).toEqual([
      { source: "campaign", campaignSlug: "dunas", label: "story «Dunas no story»", taps: 5, conversations: 2, orders: 2, paidOrders: 0, paidCents: 0 },
      { source: "pdp", campaignSlug: null, label: "página da peça", taps: 2, conversations: 1, orders: 1, paidOrders: 1, paidCents: 28900 },
      { source: "footer", campaignSlug: null, label: "rodapé do site", taps: 1, conversations: 0, orders: 0, paidOrders: 0, paidCents: 0 },
    ]);
    // Totais sobre o período inteiro: c1 aparece em duas origens e conta uma vez.
    expect(funnel.totals).toEqual({ taps: 8, conversations: 2, orders: 3, paidOrders: 1, paidCents: 28900 });

    // Janela de 90 dias pega a sacola velha também.
    const wide = await siteBridgeFunnel(sdb, { from: new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000), to: new Date(now.getTime() + 60_000) });
    expect(wide.rows.map((r) => [r.label, r.taps])).toContainEqual(["sacola", 1]);
    expect(wide.totals.taps).toBe(9);

    // A lista de conversas ganha a etiqueta de origem; conversa sem ponte fica sem.
    await conversation("+5591988880003");
    const list = await listWaConversations(sdb);
    const byPhone = new Map(list.map((item) => [item.phoneE164, item.originLabel]));
    // c1 tocou depois no story: a etiqueta é a da última ponte.
    expect(byPhone.get("+5591988880001")).toBe("story «Dunas no story»");
    expect(byPhone.get("+5591988880002")).toBe("story «Dunas no story»");
    expect(byPhone.get("+5591988880003")).toBeNull();
  });

  it("link de story apagado: a origem cai no slug; sem toques no período, vazio", async () => {
    await dunas();
    const link = await createCampaignLink(sdb, { slug: "verao", label: "Verão", userId: FIXED_USER_ID });
    await tapCampaignLink(sdb, { slug: "verao" });
    await db.delete(schema.campaignLinks).where(eq(schema.campaignLinks.id, link.id));
    const now = new Date();
    const funnel = await siteBridgeFunnel(sdb, { from: new Date(now.getTime() - 86_400_000), to: new Date(now.getTime() + 60_000) });
    expect(funnel.rows).toEqual([{ source: "campaign", campaignSlug: "verao", label: "story «verao»", taps: 1, conversations: 0, orders: 0, paidOrders: 0, paidCents: 0 }]);
    const empty = await siteBridgeFunnel(sdb, { from: new Date(now.getTime() + 60_000), to: new Date(now.getTime() + 120_000) });
    expect(empty).toEqual({ rows: [], totals: { taps: 0, conversations: 0, orders: 0, paidOrders: 0, paidCents: 0 } });
  });
});
