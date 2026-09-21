// Os vales de papel na caixa: nascem ao gerar os cartões (idempotentes),
// presente sai só com o da amiga, sem WhatsApp não saem; a amiga paga com o
// vale e quem indicou ganha o prêmio; pedido de origem cancelado desativa.
import { asc, eq } from "drizzle-orm";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeFileStorage } from "@/adapters/storage/fake";
import { FakeMessagingProvider } from "@/adapters/zapi/fake";
import type { DebutLetterData, EditionCardData } from "@/core/edition/types";
import type { VoucherCardData } from "@/core/edition/voucher";
import * as schema from "@/db/schema";
import { initialWaTemplates } from "@/db/seed-data";
import type { DbOrTx } from "@/queue/enqueue";
import { sendCouponIssuedWa } from "@/services/coupon-notices";
import { deactivateIssuedCouponsForOrder } from "@/services/coupons";
import { getEditionCards, publishEditionCards, voucherStoragePath } from "@/services/edition-cards";
import { transitionOrder } from "@/services/orders";
import { ensureOrderVouchers, rewardReferrerForPaidOrder } from "@/services/paper-vouchers";
import { createStoreOrder } from "@/services/store-orders";
import { createTestDb, createTestVariant, FIXED_USER_ID, type TestDb } from "../helpers/db";

const VALID_CPF = "529.982.247-25";
const FRIEND_CPF = "168.995.350-09";

let db: TestDb;
let sdb: DbOrTx;
let close: () => Promise<void>;
let storage: FakeFileStorage;
const render = vi.fn(async (_data: EditionCardData) => sharp({ create: { width: 108, height: 144, channels: 3, background: "#fdfbf6" } }).png().toBuffer());
const renderLetter = vi.fn(async (_data: DebutLetterData) => sharp({ create: { width: 108, height: 72, channels: 3, background: "#fdfbf6" } }).png().toBuffer());
const renderVoucher = vi.fn(async (_data: VoucherCardData) => sharp({ create: { width: 108, height: 72, channels: 3, background: "#fdfbf6" } }).png().toBuffer());
const renderers = { card: render, letter: renderLetter, voucher: renderVoucher };

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  sdb = db as unknown as DbOrTx;
  storage = new FakeFileStorage();
  render.mockClear();
  renderLetter.mockClear();
  renderVoucher.mockClear();
  vi.stubEnv("ADAPTER_MODE", "fake");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://trivemaison.com.br");
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  await db.insert(schema.settings).values([
    { key: "paper_voucher_enabled", value: true },
    { key: "paper_voucher_percent", value: 10 },
    { key: "referral_percent", value: 15 },
    { key: "referral_reward_percent", value: 12 },
    { key: "paper_voucher_days", value: 45 },
    { key: "store_whatsapp", value: "+5591999990000" },
    { key: "bot_seller_name", value: "Lia" },
    { key: "wa_enabled", value: true },
  ]);
  const template = initialWaTemplates.find((row) => row.key === "referral_reward_coupon");
  if (!template) throw new Error("template referral_reward_coupon ausente no seed");
  await db.insert(schema.waTemplates).values({ key: template.key, label: template.label, bodyTemplate: template.bodyTemplate, variables: template.variables });
});

afterEach(async () => {
  await close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function setupStore() {
  const dunas = await createTestVariant(db, { sku: "DUNAS-M", costCents: 9000, onHand: 10, name: "Longo Dunas" });
  await db.update(schema.products).set({ slug: "longo-dunas" }).where(eq(schema.products.id, dunas.productId));
  await db.insert(schema.priceVersions).values({ productVariantId: dunas.variantId, versionNumber: 1, status: "active", priceCents: 28900, origin: "initial", breakdown: {}, costSnapshotCents: 9000, computedMarginRate: "0.3000", activatedAt: new Date() });
  const [rate] = await db.insert(schema.shippingRates).values({ name: "PAC", priceCents: 1990 }).returning({ id: schema.shippingRates.id });
  return { variantId: dunas.variantId, rateId: rate.id };
}

async function paidOrder(input: { variantId: string; rateId: string; gift?: boolean; customer?: { fullName: string; document: string; phone: string }; couponCode?: string }) {
  const created = await createStoreOrder(sdb, {
    customer: { ...(input.customer ?? { fullName: "Juliana Ramos", document: VALID_CPF, phone: "(11) 99999-8888" }), marketingOptIn: true },
    address: { postalCode: "01310-100", street: "Avenida Paulista", number: "1000", district: "Bela Vista", city: "São Paulo", state: "SP" },
    items: [{ variantId: input.variantId, quantity: 1, expectedUnitPriceCents: 28900 }],
    shippingRateId: input.rateId,
    expectedShippingCents: 1990,
    ...(input.gift ? { gift: { recipientName: "Mãe", message: "Com amor" } } : {}),
    ...(input.couponCode ? { couponCode: input.couponCode } : {}),
  });
  await transitionOrder(sdb, { orderId: created.orderId, to: "paid", userId: FIXED_USER_ID });
  return created;
}

async function outbox(eventType: string) {
  return (await db.select().from(schema.outboxEvents).orderBy(asc(schema.outboxEvents.createdAt))).filter((e) => e.eventType === eventType);
}

describe("ensureOrderVouchers", () => {
  it("dois vales por pedido pago (para você = pessoal; para uma amiga = aberto, 1ª compra, 1 por cliente, 3 usos, quem indicou); idempotente", async () => {
    const { variantId, rateId } = await setupStore();
    const { orderId } = await paidOrder({ variantId, rateId });
    const [order] = await db.select({ customerId: schema.orders.customerId }).from(schema.orders).where(eq(schema.orders.id, orderId));

    const vouchers = await ensureOrderVouchers(sdb, { orderId, now: new Date("2026-09-21T15:00:00.000Z") });
    expect(vouchers.map((v) => [v.kind, v.percent, v.expiresLabel, v.firstName, v.storeName])).toEqual([
      ["para_voce", 10, "até 05/11", "Juliana", "TRIVÉ"],
      ["para_uma_amiga", 15, "até 05/11", "Juliana", "TRIVÉ"],
    ]);
    expect(vouchers[0].code).toMatch(/^JULIANA-[A-Z2-9]{5}$/);
    expect(vouchers[1].code).toMatch(/^AMIGA-[A-Z2-9]{5}$/);
    expect(vouchers[0].qrUrl).toBe(`https://wa.me/5591999990000?text=${encodeURIComponent(`Oi, Lia! Tenho o vale ${vouchers[0].code}`)}`);

    const rows = await db.select().from(schema.coupons).orderBy(asc(schema.coupons.origin));
    expect(rows.map((r) => r.origin)).toEqual(["paper_voucher", "referral"]);
    expect(rows[0]).toMatchObject({ customerId: order.customerId, orderId, maxUses: 1, perCustomerLimit: 1, value: 10, dedupeKey: `paper_voucher:${orderId}` });
    expect(rows[1]).toMatchObject({ customerId: null, phoneE164: null, orderId, maxUses: 3, perCustomerLimit: 1, firstPurchaseOnly: true, referrerCustomerId: order.customerId, value: 15, dedupeKey: `referral:${orderId}` });

    const again = await ensureOrderVouchers(sdb, { orderId });
    expect(again.map((v) => v.code)).toEqual(vouchers.map((v) => v.code));
    expect(await db.select().from(schema.coupons)).toHaveLength(2);
  });

  it("presente: só o da amiga; sem WhatsApp da loja: nenhum; desligado: nenhum; pedido não pago: nenhum", async () => {
    const { variantId, rateId } = await setupStore();
    const gift = await paidOrder({ variantId, rateId, gift: true });
    expect((await ensureOrderVouchers(sdb, { orderId: gift.orderId })).map((v) => v.kind)).toEqual(["para_uma_amiga"]);

    const unpaid = await createStoreOrder(sdb, {
      customer: { fullName: "Bia", document: FRIEND_CPF, phone: "(21) 97777-6666", marketingOptIn: true },
      address: { postalCode: "01310-100", street: "Avenida Paulista", number: "1000", district: "Bela Vista", city: "São Paulo", state: "SP" },
      items: [{ variantId, quantity: 1, expectedUnitPriceCents: 28900 }],
      shippingRateId: rateId,
      expectedShippingCents: 1990,
    });
    expect(await ensureOrderVouchers(sdb, { orderId: unpaid.orderId })).toEqual([]);

    await db.update(schema.settings).set({ value: "" }).where(eq(schema.settings.key, "store_whatsapp"));
    const noWa = await paidOrder({ variantId, rateId, customer: { fullName: "Carla", document: "111.444.777-35", phone: "(31) 96666-5555" } });
    expect(await ensureOrderVouchers(sdb, { orderId: noWa.orderId })).toEqual([]);
    expect(await db.select().from(schema.coupons)).toHaveLength(1);
  });
});

describe("cartões da edição com os vales", () => {
  it("gerar desenha e sobe os vales, a impressão digital os inclui, a tela os lista com URL; gerar de novo reaproveita os códigos; mudar o % deixa velho", async () => {
    const { variantId, rateId } = await setupStore();
    const { orderId } = await paidOrder({ variantId, rateId });

    const before = await getEditionCards(sdb, storage, orderId);
    expect(before.vouchers).toEqual([]);
    expect(before.plannedVouchers).toEqual(["para_voce", "para_uma_amiga"]);

    const result = await publishEditionCards(sdb, storage, renderers, { orderId });
    expect(renderVoucher).toHaveBeenCalledTimes(2);
    expect(result.voucherPaths).toEqual([voucherStoragePath(orderId, "para_voce"), voucherStoragePath(orderId, "para_uma_amiga")]);
    expect(storage.get(result.voucherPaths[0])?.contentType).toBe("image/jpeg");
    const [row] = await db.select({ fp: schema.orders.editionCardsFingerprint }).from(schema.orders).where(eq(schema.orders.id, orderId));
    expect(Object.keys(row.fp as Record<string, string>).sort()).toEqual(expect.arrayContaining(["vale_amiga", "vale_voce"]));

    const view = await getEditionCards(sdb, storage, orderId);
    expect(view.stale).toBe(false);
    expect(view.vouchers.map((v) => [v.kind, v.url !== null, v.stale])).toEqual([
      ["para_voce", true, false],
      ["para_uma_amiga", true, false],
    ]);
    const codes = view.vouchers.map((v) => v.code);

    renderVoucher.mockClear();
    await publishEditionCards(sdb, storage, renderers, { orderId });
    expect((await getEditionCards(sdb, storage, orderId)).vouchers.map((v) => v.code)).toEqual(codes);
    expect(await db.select().from(schema.coupons)).toHaveLength(2);

    // O nome da loja muda: o vale diria outra coisa → velho (a tela pede gerar de novo).
    await db.insert(schema.settings).values({ key: "store_name", value: "TRIVÉ Maison" });
    expect((await getEditionCards(sdb, storage, orderId)).vouchers.every((v) => v.stale)).toBe(true);
  });
});

describe("prêmio da indicação", () => {
  it("a amiga fecha com o vale (1ª compra) e paga → quem indicou ganha o prêmio + aviso; reprocessar não duplica; a mesma amiga não usa de novo", async () => {
    const { variantId, rateId } = await setupStore();
    const juliana = await paidOrder({ variantId, rateId });
    const [amiga] = (await ensureOrderVouchers(sdb, { orderId: juliana.orderId })).filter((v) => v.kind === "para_uma_amiga");

    const friendOrder = await paidOrder({ variantId, rateId, customer: { fullName: "Bia Lima", document: FRIEND_CPF, phone: "(21) 97777-6666" }, couponCode: amiga.code });
    expect(friendOrder.totalCents).toBe(28900 - Math.floor(28900 * 0.15) + 1990);

    const reward = await rewardReferrerForPaidOrder(sdb, { orderId: friendOrder.orderId, now: new Date("2026-09-21T15:00:00.000Z") });
    expect(reward).toMatchObject({ rewarded: true, created: true });
    if (!("rewarded" in reward)) throw new Error("esperava prêmio");
    const [julianaRow] = await db.select({ customerId: schema.orders.customerId }).from(schema.orders).where(eq(schema.orders.id, juliana.orderId));
    const [coupon] = await db.select().from(schema.coupons).where(eq(schema.coupons.id, reward.couponId));
    expect(coupon).toMatchObject({ origin: "referral_reward", customerId: julianaRow.customerId, value: 12, maxUses: 1, orderId: friendOrder.orderId });
    expect(coupon.code).toMatch(/^JULIANA-/);
    const issued = await outbox("coupon.issued");
    expect(issued.map((e) => e.payload)).toContainEqual({ couponId: reward.couponId, vars: { amiga: "Bia" } });

    expect(await rewardReferrerForPaidOrder(sdb, { orderId: friendOrder.orderId })).toMatchObject({ rewarded: true, created: false });
    expect(await db.select().from(schema.coupons).where(eq(schema.coupons.origin, "referral_reward"))).toHaveLength(1);

    // O aviso pelo template.
    const provider = new FakeMessagingProvider();
    expect(await sendCouponIssuedWa(sdb, provider, { couponId: reward.couponId, vars: { amiga: "Bia" }, now: new Date("2026-09-22T13:00:00.000Z") })).toMatchObject({ sent: true });
    expect(provider.sentMessages[0].body).toContain("Juliana, Bia usou o seu vale e fez a primeira compra");
    expect(provider.sentMessages[0].body).toContain(`cupom ${coupon.code} de 12%`);

    // Pedido sem cupom / com cupom comum: nada.
    expect(await rewardReferrerForPaidOrder(sdb, { orderId: juliana.orderId })).toEqual({ skipped: "sem_cupom" });

    // A amiga que já comprou não usa o vale de novo (1ª compra); outra amiga sim.
    await expect(paidOrder({ variantId, rateId, customer: { fullName: "Bia Lima", document: FRIEND_CPF, phone: "(21) 97777-6666" }, couponCode: amiga.code })).rejects.toMatchObject({ code: "COUPON_FIRST_PURCHASE_ONLY" });
  });

  it("pedido de origem cancelado: os vales não usados são desativados e não voltam ao papel; recurso ligado depois da geração pede gerar de novo", async () => {
    const { variantId, rateId } = await setupStore();
    const { orderId } = await paidOrder({ variantId, rateId });
    await ensureOrderVouchers(sdb, { orderId });
    expect(await deactivateIssuedCouponsForOrder(sdb, { orderId, origins: ["price_protection", "paper_voucher", "referral"] })).toBe(2);
    expect((await db.select().from(schema.coupons)).every((c) => !c.isActive)).toBe(true);
    // Desativados não são redesenhados.
    expect((await getEditionCards(sdb, storage, orderId)).vouchers).toEqual([]);

    // Outro pedido gerado com o recurso desligado: ao ligar, a tela sabe que falta gerar de novo.
    await db.update(schema.settings).set({ value: false }).where(eq(schema.settings.key, "paper_voucher_enabled"));
    const second = await paidOrder({ variantId, rateId, customer: { fullName: "Bia Lima", document: FRIEND_CPF, phone: "(21) 97777-6666" } });
    await publishEditionCards(sdb, storage, renderers, { orderId: second.orderId });
    expect((await getEditionCards(sdb, storage, second.orderId)).stale).toBe(false);
    await db.update(schema.settings).set({ value: true }).where(eq(schema.settings.key, "paper_voucher_enabled"));
    const view = await getEditionCards(sdb, storage, second.orderId);
    expect(view.vouchers).toEqual([]);
    expect(view.plannedVouchers).toEqual(["para_voce", "para_uma_amiga"]);
    expect(view.stale).toBe(true);
  });
});
