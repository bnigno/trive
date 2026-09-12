// Links de story: a dona cria "dunas" (slug normalizado, único para sempre),
// o toque em /ig/dunas grava a ponte com origem 'campaign' e devolve o
// WhatsApp com "no story"; desligado, o toque não conta; o funil por link
// soma toques → conversas → pedidos; a Lia vê a origem pelo RÓTULO do link.
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import {
  createCampaignLink,
  getCampaignCurtain,
  listCampaignLinks,
  tapCampaignLink,
  updateCampaignLink,
} from "@/services/campaign-links";
import { consumeSiteCartByCode } from "@/services/site-carts";
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

describe("createCampaignLink / updateCampaignLink", () => {
  it("normaliza o slug, guarda rótulo e peça, e audita; slug repetido ou inválido é recusado", async () => {
    const { productId } = await dunas();
    const link = await createCampaignLink(sdb, { slug: "Círio 2026", label: "Dunas no story do Círio", productId, userId: FIXED_USER_ID });
    expect(link).toMatchObject({ slug: "cirio-2026", label: "Dunas no story do Círio", productId, productName: "Longo Dunas", productSlug: "longo-dunas", isActive: true, taps: 0, conversations: 0, orders: 0 });

    await expect(createCampaignLink(sdb, { slug: "CIRIO-2026", label: "outro", userId: FIXED_USER_ID })).rejects.toMatchObject({ code: "slug_em_uso" });
    await expect(createCampaignLink(sdb, { slug: "!", label: "x", userId: FIXED_USER_ID })).rejects.toMatchObject({ code: "slug_invalido" });
    await expect(createCampaignLink(sdb, { slug: "ok", label: "x", productId: "00000000-0000-4000-8000-000000000000", userId: FIXED_USER_ID })).rejects.toMatchObject({ code: "peca_nao_encontrada" });

    const audit = await db.select().from(schema.auditLog);
    expect(audit.map((a) => a.action)).toEqual(["campaign_link.create"]);
  });

  it("rótulo, peça e ligado/desligado mudam; o slug não", async () => {
    const link = await createCampaignLink(sdb, { slug: "dunas", label: "Dunas", userId: FIXED_USER_ID });
    const { productId } = await dunas();
    const updated = await updateCampaignLink(sdb, { id: link.id, label: "Dunas no story", productId, isActive: false, userId: FIXED_USER_ID });
    expect(updated).toMatchObject({ slug: "dunas", label: "Dunas no story", productId, isActive: false });
    await expect(updateCampaignLink(sdb, { id: "00000000-0000-4000-8000-000000000000", label: "x", userId: FIXED_USER_ID })).rejects.toMatchObject({ code: "link_nao_encontrado" });
  });
});

describe("tapCampaignLink / getCampaignCurtain", () => {
  it("toque em link ativo grava a ponte com origem 'campaign' e a mensagem diz 'no story'", async () => {
    const { productId } = await dunas();
    await createCampaignLink(sdb, { slug: "dunas", label: "Dunas no story", productId, userId: FIXED_USER_ID });
    const tap = (await tapCampaignLink(sdb, { slug: "dunas" }))!;
    expect(tap.message).toBe(`Oi Lia, vi o Longo Dunas no story (#${tap.code})`);
    expect(tap.waUrl).toContain("https://wa.me/5591988887777?text=");
    const [cart] = await db.select().from(schema.siteCarts);
    expect(cart).toMatchObject({ source: "campaign", campaignSlug: "dunas", productId, consumedAt: null });
    // Slug com maiúscula/acento chega ao mesmo link; link sem peça diz "vim pelo story".
    await createCampaignLink(sdb, { slug: "geral", label: "Link geral", userId: FIXED_USER_ID });
    const generic = (await tapCampaignLink(sdb, { slug: "GERAL" }))!;
    expect(generic.message).toBe(`Oi Lia, vim pelo story (#${generic.code})`);
  });

  it("link desligado ou inexistente: o toque não conta; a cortina sabe a peça para redirecionar", async () => {
    const { productId } = await dunas();
    const link = await createCampaignLink(sdb, { slug: "dunas", label: "Dunas", productId, userId: FIXED_USER_ID });
    await updateCampaignLink(sdb, { id: link.id, isActive: false, userId: FIXED_USER_ID });
    expect(await tapCampaignLink(sdb, { slug: "dunas" })).toBeNull();
    expect(await tapCampaignLink(sdb, { slug: "nao-existe" })).toBeNull();
    expect(await tapCampaignLink(sdb, { slug: "!!" })).toBeNull();
    expect(await db.select().from(schema.siteCarts)).toHaveLength(0);

    const curtain = (await getCampaignCurtain(sdb, "dunas"))!;
    expect(curtain).toMatchObject({ slug: "dunas", label: "Dunas", isActive: false, productSlug: "longo-dunas", sellerName: "Lia" });
    expect(curtain.product?.name).toBe("Longo Dunas");
    expect(curtain.plainWaUrl).toContain("wa.me/5591988887777");
    expect(await getCampaignCurtain(sdb, "nao-existe")).toBeNull();
  });
});

describe("listCampaignLinks (funil) e a origem na Lia", () => {
  it("toques → conversas → pedidos por link; a ponte consumida leva o RÓTULO do link como origem", async () => {
    const { productId } = await dunas();
    await createCampaignLink(sdb, { slug: "dunas", label: "Dunas no story", productId, userId: FIXED_USER_ID });
    await createCampaignLink(sdb, { slug: "vazio", label: "Sem toque", userId: FIXED_USER_ID });
    const t1 = (await tapCampaignLink(sdb, { slug: "dunas" }))!;
    const t2 = (await tapCampaignLink(sdb, { slug: "dunas" }))!;
    await tapCampaignLink(sdb, { slug: "dunas" });

    const [conversation] = await db.insert(schema.waConversations).values({ phoneE164: "+5591988880000" }).returning({ id: schema.waConversations.id });
    const bridge = (await consumeSiteCartByCode(sdb, { code: t1.code, conversationId: conversation.id, now: new Date() }))!;
    expect(bridge.sourceLabel).toBe("story «Dunas no story»");
    expect(bridge.productName).toBe("Longo Dunas");
    await consumeSiteCartByCode(sdb, { code: t2.code, conversationId: conversation.id, now: new Date() });

    const [customer] = await db.insert(schema.customers).values({ fullName: "Ana", phoneE164: "+5591988880000" }).returning({ id: schema.customers.id });
    const [order] = await db
      .insert(schema.orders)
      .values({ customerId: customer.id, status: "pending_payment", channel: "whatsapp", subtotalCents: 28900, totalCents: 28900 })
      .returning({ id: schema.orders.id });
    await db.update(schema.siteCarts).set({ orderId: order.id }).where(eq(schema.siteCarts.code, t1.code));

    const links = await listCampaignLinks(sdb);
    expect(links.map((l) => [l.slug, l.taps, l.conversations, l.orders])).toEqual([
      ["vazio", 0, 0, 0],
      ["dunas", 3, 2, 1],
    ]);
  });
});
