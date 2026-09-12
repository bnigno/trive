// A ponte do site chegando pelo WhatsApp: a primeira mensagem traz "#K7F2";
// dentro da MESMA transação do inbound a ponte é consumida (uma vez só),
// a conversa fica ligada a ela, o caderninho ganha "Veio do site" (peça em
// vista ou sacola fundida) e o turno do bot é enfileirado como sempre.
// Código inventado, já usado ou velho demais não faz nada. Com o bot
// desligado, a linha "Veio do site" vai junto no encaminhamento ao dono.
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { createSiteCart } from "@/services/site-carts";
import { processZapiInbound } from "@/services/wa-inbound";
import { createTestDb, createTestVariant, type TestDb } from "../helpers/db";

const SECRET = "segredo-webhook-zapi";
const PHONE_E164 = "+5591988880000";
const PHONE_ZAPI = "5591988880000";

function receivedMessage(messageId: string, text: string, phone = PHONE_ZAPI) {
  return {
    type: "ReceivedCallback",
    instanceId: "instancia-x",
    messageId,
    phone,
    fromMe: false,
    isGroup: false,
    senderName: "Ana Cliente",
    momment: Date.now(),
    status: "RECEIVED",
    text: { message: text },
  };
}

let db: TestDb;
let sdb: DbOrTx;
let close: () => Promise<void>;
const originalSecret = process.env.ZAPI_WEBHOOK_SECRET;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  sdb = db as unknown as DbOrTx;
  process.env.ZAPI_WEBHOOK_SECRET = SECRET;
  delete process.env.ZAPI_CLIENT_TOKEN;
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
  if (originalSecret === undefined) delete process.env.ZAPI_WEBHOOK_SECRET;
  else process.env.ZAPI_WEBHOOK_SECRET = originalSecret;
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
  await db.update(schema.products).set({ slug: "longo-dunas", attributesSchema: ["cor", "tamanho"] }).where(eq(schema.products.id, created.productId));
  await db.update(schema.productVariants).set({ attributes: { cor: "Areia", tamanho: "M" } }).where(eq(schema.productVariants.id, created.variantId));
  await priced(created.variantId, 28900);
  return created;
}

async function conversationState(conversationId: string) {
  const [row] = await db.select().from(schema.waConversations).where(eq(schema.waConversations.id, conversationId));
  return { row, state: (row.botState ?? {}) as Record<string, unknown> };
}

describe("processZapiInbound → ponte do site", () => {
  it("mensagem pronta da página da peça: consome a ponte, liga a conversa, põe a peça em vista e enfileira o turno", async () => {
    await dunas();
    const link = await createSiteCart(sdb, { source: "pdp", productSlug: "longo-dunas", variantSku: "DUNAS-AREIA-M" });

    const result = await processZapiInbound(sdb, {
      providedSecret: SECRET,
      body: receivedMessage("MSG-PONTE-1", link.message),
    });
    expect(result.action).toBe("bot_queued");
    if (result.action !== "bot_queued") throw new Error("unreachable");

    const [cart] = await db.select().from(schema.siteCarts);
    expect(cart.consumedAt).not.toBeNull();
    expect(cart.conversationId).toBe(result.conversationId);
    expect(cart.orderId).toBeNull();

    const { state } = await conversationState(result.conversationId);
    expect(state.bridge).toMatchObject({
      siteCartId: link.id,
      code: link.code,
      source: "pdp",
      sourceLabel: "página da peça",
      productSlug: "longo-dunas",
      productName: "Longo Dunas",
      variation: "Areia · M",
    });
    expect(state.focus).toEqual({ slug: "longo-dunas", nome: "Longo Dunas", cor: null });
    expect(state.cart).toBeUndefined();
    // O nome do WhatsApp gravado antes da ponte não se perde.
    expect(state.displayName).toBe("Ana Cliente");

    const outbox = await db.select().from(schema.outboxEvents);
    expect(outbox.map((e) => e.eventType)).toEqual(["wa.bot_turn"]);
  });

  it("sacola do site: as peças entram na sacola da conversa, somando com o que já estava", async () => {
    await dunas();
    const tote = await createTestVariant(db, { sku: "TOTE", costCents: 4000, onHand: 5, name: "Bolsa Tote" });
    await priced(tote.variantId, 12900);
    await db.insert(schema.waConversations).values({
      phoneE164: PHONE_E164,
      status: "open",
      botState: { cart: [{ sku: "DUNAS-AREIA-M", quantidade: 1, nome: "Longo Dunas", variacao: "Areia · M", precoCents: 28900 }] },
    });
    const link = await createSiteCart(sdb, {
      source: "cart",
      items: [
        { sku: "DUNAS-AREIA-M", quantity: 1 },
        { sku: "TOTE", quantity: 2 },
      ],
    });

    const result = await processZapiInbound(sdb, { providedSecret: SECRET, body: receivedMessage("MSG-PONTE-2", link.message) });
    expect(result.action).toBe("bot_queued");
    if (result.action !== "bot_queued") throw new Error("unreachable");

    const { state } = await conversationState(result.conversationId);
    expect(state.cart).toEqual([
      { sku: "DUNAS-AREIA-M", quantidade: 2, nome: "Longo Dunas", variacao: "Areia · M", precoCents: 28900 },
      { sku: "TOTE", quantidade: 2, nome: "Bolsa Tote", variacao: "", precoCents: 12900 },
    ]);
    expect(state.focus).toBeUndefined();
    expect((state.bridge as { source: string }).source).toBe("cart");
  });

  it("código inventado, já usado ou velho demais: nada acontece e o turno segue normal", async () => {
    await dunas();
    const link = await createSiteCart(sdb, { source: "pdp", productSlug: "longo-dunas" });

    // Inventado.
    const fake = await processZapiInbound(sdb, { providedSecret: SECRET, body: receivedMessage("MSG-X-1", "Oi Lia, vi o Longo Dunas (#ZZZZ)") });
    expect(fake.action).toBe("bot_queued");
    if (fake.action !== "bot_queued") throw new Error("unreachable");
    expect((await conversationState(fake.conversationId)).state.bridge).toBeUndefined();
    expect((await db.select().from(schema.siteCarts))[0].consumedAt).toBeNull();

    // Válido: consome.
    const real = await processZapiInbound(sdb, { providedSecret: SECRET, body: receivedMessage("MSG-X-2", link.message) });
    expect(real.action).toBe("bot_queued");

    // Já usado, de outro telefone: não rouba a ponte nem ganha o caderninho.
    const again = await processZapiInbound(sdb, { providedSecret: SECRET, body: receivedMessage("MSG-X-3", link.message, "5511977770000") });
    expect(again.action).toBe("bot_queued");
    if (again.action !== "bot_queued") throw new Error("unreachable");
    expect((await conversationState(again.conversationId)).state.bridge).toBeUndefined();
    const [cart] = await db.select().from(schema.siteCarts);
    expect(cart.conversationId).toBe(fake.conversationId);

    // Velha demais (8 dias): mesmo aberta, não vale mais.
    const old = await createSiteCart(sdb, { source: "footer" });
    await db.update(schema.siteCarts).set({ createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) }).where(eq(schema.siteCarts.id, old.id));
    const late = await processZapiInbound(sdb, { providedSecret: SECRET, body: receivedMessage("MSG-X-4", old.message, "5511966660000") });
    expect(late.action).toBe("bot_queued");
    expect((await db.select().from(schema.siteCarts).where(eq(schema.siteCarts.id, old.id)))[0].consumedAt).toBeNull();
  });

  it("bot desligado: a ponte é consumida mesmo assim e o encaminhamento ao dono começa com 'Veio do site'", async () => {
    await dunas();
    await db.update(schema.settings).set({ value: false }).where(eq(schema.settings.key, "bot_enabled"));
    const link = await createSiteCart(sdb, { source: "pdp", productSlug: "longo-dunas", variantSku: "DUNAS-AREIA-M" });

    const result = await processZapiInbound(sdb, { providedSecret: SECRET, body: receivedMessage("MSG-PONTE-3", link.message) });
    expect(result.action).toBe("forwarded");

    const [forward] = await db.select().from(schema.outboxEvents).where(eq(schema.outboxEvents.eventType, "wa.owner_forward"));
    const body = (forward.payload as { body: string }).body;
    expect(body.startsWith("Veio do site agora (página da peça): Longo Dunas (Areia · M)\n")).toBe(true);
    expect(body).toContain(link.message);

    const [cart] = await db.select().from(schema.siteCarts);
    expect(cart.consumedAt).not.toBeNull();
  });

  it("conversa assumida pelo dono ('human'): a ponte vale do mesmo jeito — o dono vê de onde ela veio", async () => {
    await dunas();
    await db.insert(schema.waConversations).values({ phoneE164: PHONE_E164, status: "human" });
    const link = await createSiteCart(sdb, { source: "pdp", productSlug: "longo-dunas" });

    const result = await processZapiInbound(sdb, { providedSecret: SECRET, body: receivedMessage("MSG-PONTE-4", link.message) });
    expect(result.action).toBe("forwarded");
    if (result.action !== "forwarded") throw new Error("unreachable");
    expect((await conversationState(result.conversationId)).state.bridge).toMatchObject({ code: link.code });
  });
});
