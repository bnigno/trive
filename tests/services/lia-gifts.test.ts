// Gentilezas da Lia: a cota do dia, o cooldown, a idempotência por conversa e
// o executor da ferramenta (turno real grava o caderninho; ensaio não emite;
// copiloto e turno proativo recusam).
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { countLiaGiftsToday, loadLiaGiftPolicy, offerLiaGift, type LiaGiftInput } from "@/services/lia-gifts";
import { buildToolExecutor } from "@/services/wa-bot";
import { createTestCustomer, createTestDb, createTestVariant, FIXED_USER_ID, type TestDb } from "../helpers/db";

let db: TestDb;
let close: () => Promise<void>;
let sdb: DbOrTx;

const PHONE = "+5591999998888";
const CONVERSATION_ID = "11111111-1111-4111-8111-111111111111";
const INBOUND_ID = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-09-21T18:00:00.000Z"); // 15:00 SP

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  sdb = db as unknown as DbOrTx;
  await db.insert(schema.settings).values([
    { key: "lia_gift_enabled", value: true },
    { key: "lia_gift_percent", value: 10 },
    { key: "lia_gift_daily_quota", value: 2 },
    { key: "lia_gift_min_purchases", value: 1 },
    { key: "lia_gift_min_cart_cents", value: 15_000 },
    { key: "lia_gift_days", value: 2 },
    { key: "lia_gift_cooldown_days", value: 60 },
    { key: "bot_enabled", value: true },
  ]);
  await db.insert(schema.waConversations).values({ id: CONVERSATION_ID, phoneE164: PHONE, status: "open" });
});

afterEach(async () => {
  await close();
});

/** Cliente da casa (1 pedido pago) com o telefone da conversa. */
async function customerOfTheHouse(name = "Maria da Silva", phone = PHONE): Promise<string> {
  const customerId = await createTestCustomer(db, name);
  await db.update(schema.customers).set({ phoneE164: phone }).where(eq(schema.customers.id, customerId));
  await db.insert(schema.orders).values({ customerId, status: "paid", paidAt: new Date("2026-08-01T12:00:00.000Z"), subtotalCents: 1000, discountCents: 0, shippingCents: 0, totalCents: 1000 });
  return customerId;
}

async function sellable(priceCents: number, sku?: string) {
  const { variantId } = await createTestVariant(db, { sku, onHand: 5 });
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
  return variantId;
}

function giftInput(customerId: string | null, variantId: string, over: Partial<LiaGiftInput> = {}): LiaGiftInput {
  return {
    conversationId: CONVERSATION_ID,
    customerId,
    items: [{ variantId, quantity: 1 }],
    cartSubtotalCents: 28_900,
    motivo: "hesitou no preço do Longo Dunas",
    now: NOW,
    alreadyOfferedInConversation: false,
    hasValidatedCoupon: false,
    copilot: false,
    proactive: false,
    ...over,
  };
}

describe("offerLiaGift", () => {
  it("emite MARIA-CARINHO (pessoal, 1 uso, mínimo da sacola, motivo na nota, conversa ligada), audit; a mesma conversa no dia devolve o mesmo", async () => {
    const customerId = await customerOfTheHouse();
    const variantId = await sellable(28_900);
    const result = await offerLiaGift(sdb, giftInput(customerId, variantId));
    expect(result).toMatchObject({ ok: true, code: "MARIA-CARINHO", percent: 10, created: true });
    if (!result.ok) throw new Error("esperava gentileza");
    expect(result.quote.discountCents).toBe(2890);
    expect(result.expiresAt).toEqual(new Date("2026-09-24T02:59:59.000Z")); // 23:59:59 SP de 23/09

    const [coupon] = await db.select().from(schema.coupons).where(eq(schema.coupons.id, result.couponId));
    expect(coupon).toMatchObject({
      origin: "lia_gift",
      customerId,
      conversationId: CONVERSATION_ID,
      maxUses: 1,
      perCustomerLimit: 1,
      minOrderCents: 15_000,
      note: "hesitou no preço do Longo Dunas",
      dedupeKey: `lia_gift:${CONVERSATION_ID}:2026-09-21`,
    });
    expect(await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "coupon.lia_gift"))).toHaveLength(1);
    expect(await countLiaGiftsToday(sdb, NOW)).toBe(1);

    const again = await offerLiaGift(sdb, giftInput(customerId, variantId));
    expect(again).toMatchObject({ ok: true, code: "MARIA-CARINHO", created: false });
    expect(await db.select().from(schema.coupons)).toHaveLength(1);
  });

  it("cota do dia (2): a terceira conversa recusa; cooldown: a mesma cliente não ganha de novo; sem compra suficiente recusa", async () => {
    const variantId = await sellable(28_900);
    const a = await customerOfTheHouse("Ana", "+5591911110001");
    const b = await customerOfTheHouse("Bia", "+5591911110002");
    const c = await customerOfTheHouse("Cris", "+5591911110003");
    const conv = async (id: string, phone: string) => {
      await db.insert(schema.waConversations).values({ id, phoneE164: phone, status: "open" });
      return id;
    };
    expect((await offerLiaGift(sdb, giftInput(a, variantId, { conversationId: await conv("33333333-3333-4333-8333-333333333333", "+5591911110001") }))).ok).toBe(true);
    expect((await offerLiaGift(sdb, giftInput(b, variantId, { conversationId: await conv("44444444-4444-4444-8444-444444444444", "+5591911110002") }))).ok).toBe(true);
    expect(await offerLiaGift(sdb, giftInput(c, variantId, { conversationId: await conv("55555555-5555-4555-8555-555555555555", "+5591911110003") }))).toMatchObject({ ok: false, refusal: "quota" });

    // Amanhã a cota volta, mas Ana está em cooldown.
    const tomorrow = new Date(NOW.getTime() + 86_400_000);
    expect(await offerLiaGift(sdb, giftInput(a, variantId, { conversationId: "33333333-3333-4333-8333-333333333333", now: tomorrow }))).toMatchObject({ ok: false, refusal: "cooldown" });
    expect((await offerLiaGift(sdb, giftInput(c, variantId, { conversationId: "55555555-5555-4555-8555-555555555555", now: tomorrow }))).ok).toBe(true);

    const nova = await createTestCustomer(db, "Nova");
    expect(await offerLiaGift(sdb, giftInput(nova, variantId, { now: new Date(tomorrow.getTime() + 86_400_000) }))).toMatchObject({ ok: false, refusal: "few_purchases" });
    expect(await offerLiaGift(sdb, giftInput(null, variantId))).toMatchObject({ ok: false, refusal: "unidentified" });
  });

  it("desligado não toca no banco; política torta cai nos padrões", async () => {
    await db.update(schema.settings).set({ value: false }).where(eq(schema.settings.key, "lia_gift_enabled"));
    const customerId = await customerOfTheHouse();
    const variantId = await sellable(28_900);
    expect(await offerLiaGift(sdb, giftInput(customerId, variantId))).toMatchObject({ ok: false, refusal: "disabled" });
    expect(await db.select().from(schema.coupons)).toHaveLength(0);

    await db.update(schema.settings).set({ value: 999 }).where(eq(schema.settings.key, "lia_gift_percent"));
    expect((await loadLiaGiftPolicy(sdb)).percent).toBe(10);
  });
});

describe("oferecer_gentileza (executor)", () => {
  async function setupCart() {
    const customerId = await customerOfTheHouse();
    const variantId = await sellable(28_900, "DUNAS-AREIA-M");
    await db.update(schema.waConversations).set({ customerId }).where(eq(schema.waConversations.id, CONVERSATION_ID));
    return { customerId, variantId };
  }
  function executor(over: Partial<Parameters<typeof buildToolExecutor>[1]> = {}) {
    return buildToolExecutor(sdb, { conversationId: CONVERSATION_ID, phoneE164: PHONE, customerId: null, lastInboundId: INBOUND_ID, now: NOW, ...over });
  }
  async function botState() {
    const [row] = await db.select({ botState: schema.waConversations.botState }).from(schema.waConversations).where(eq(schema.waConversations.id, CONVERSATION_ID));
    return (row.botState ?? {}) as Record<string, unknown>;
  }

  it("turno real: emite, valida no caderninho e devolve o texto; segunda vez na conversa recusa em silêncio", async () => {
    await setupCart();
    const execute = executor();
    await execute("adicionar_a_sacola", { sku: "DUNAS-AREIA-M", quantidade: 1 });
    const result = await execute("oferecer_gentileza", { motivo: "hesitou no preço" });
    expect(result.ok).toBe(true);
    expect(result.text).toContain("Gentileza registrada: cupom MARIA-CARINHO — 10% na sacola atual");
    expect(result.text).toContain("vale até 23/09");
    const state = await botState();
    expect(state.coupon).toMatchObject({ code: "MARIA-CARINHO", discountCents: 2890 });
    expect(state.liaGift).toMatchObject({ code: "MARIA-CARINHO", motivo: "hesitou no preço" });

    const again = await execute("oferecer_gentileza", { motivo: "de novo" });
    expect(again.ok).toBe(false);
    expect(again.text).toContain("Sem gentileza agora (já ofereceu nesta conversa)");
    expect(again.text).toContain("NÃO mencione desconto");
    expect(await db.select().from(schema.coupons)).toHaveLength(1);
  });

  it("sacola vazia recusa; ensaio prevê sem criar cupom; copiloto recusa", async () => {
    await setupCart();
    const vazia = await executor()("oferecer_gentileza", { motivo: "hesitou no preço" });
    expect(vazia.ok).toBe(false);
    expect(vazia.text).toContain("sacola vazia");

    const rehearsal = executor({ dryRun: true });
    await rehearsal("adicionar_a_sacola", { sku: "DUNAS-AREIA-M", quantidade: 1 });
    const preview = await rehearsal("oferecer_gentileza", { motivo: "hesitou" });
    expect(preview.ok).toBe(true);
    expect(preview.text).toContain("Ensaio: as condições estão OK");
    expect(preview.text).toContain("ENSAIO-CARINHO");
    expect(await db.select().from(schema.coupons)).toHaveLength(0);
    // No ensaio, a regra de uma por conversa também vale (caderninho em memória).
    const previewAgain = await rehearsal("oferecer_gentileza", { motivo: "de novo" });
    expect(previewAgain.ok).toBe(false);
    expect(previewAgain.text).toContain("já ofereceu nesta conversa");

    // Copiloto: recusa em silêncio (não é "a equipe cuida disso" — a Lia não pode prometer desconto).
    const copilot = executor({ copilot: true });
    await copilot("adicionar_a_sacola", { sku: "DUNAS-AREIA-M", quantidade: 1 });
    const blocked = await copilot("oferecer_gentileza", { motivo: "hesitou" });
    expect(blocked.ok).toBe(false);
    expect(blocked.text).toContain("Sem gentileza agora (copiloto)");
    expect(blocked.text).toContain("NÃO mencione desconto");
  });

  it("cupom que não vale para a sacola de agora: nada fica gravado e a Lia segue sem gentileza", async () => {
    const { customerId } = await setupCart();
    // Sacola abaixo do mínimo da política — a decisão passa (mínimo checado com o subtotal do caderninho),
    // mas a cotação de verdade recusa (COUPON_MIN_ORDER): transação desfeita.
    const cheap = await sellable(1000, "BARATA");
    const result = await offerLiaGift(sdb, giftInput(customerId, cheap, { cartSubtotalCents: 28_900 }));
    expect(result).toMatchObject({ ok: false, refusal: "unquotable" });
    expect(await db.select().from(schema.coupons)).toHaveLength(0);
    expect(await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "coupon.lia_gift"))).toHaveLength(0);
  });
});
