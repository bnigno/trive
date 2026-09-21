// Emissão automática (issueCoupon), devolução do uso, exclusão, relatório de
// quem usou e o destino do link /c/CODIGO.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import {
  createCoupon,
  deleteCoupon,
  getCouponReport,
  issueCoupon,
  listIssuedCouponsForCustomer,
  listIssuedCouponsForOrder,
  redeemCouponInTx,
  releaseCouponRedemptionInTx,
  resolveCouponLink,
  ServiceError,
  type IssueCouponInput,
} from "@/services/coupons";
import { createTestCustomer, createTestDb, createTestVariant, FIXED_USER_ID, type TestDb } from "../helpers/db";

let db: TestDb;
let close: () => Promise<void>;
let sdb: DbOrTx;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  sdb = db as unknown as DbOrTx;
});

afterEach(async () => {
  await close();
});

const EXPIRES = new Date("2026-10-20T02:59:59.000Z");

async function makeOrder(customerId: string): Promise<string> {
  const [order] = await db
    .insert(schema.orders)
    .values({ customerId, status: "paid", paidAt: new Date(), subtotalCents: 1000, discountCents: 0, shippingCents: 0, totalCents: 1000 })
    .returning({ id: schema.orders.id });
  return order.id;
}

function issue(over: Partial<IssueCouponInput> & { customerId: string | null }): ReturnType<typeof issueCoupon> {
  return issueCoupon(sdb, {
    dedupeKey: "late_delivery:pedido-1",
    origin: "late_delivery",
    type: "percent",
    value: 10,
    expiresAt: EXPIRES,
    note: "Entrega 42 min depois da janela",
    random: () => 0.42,
    ...over,
  });
}

describe("issueCoupon", () => {
  it("emite um cupom pessoal com o nome da cliente, uso único, e é idempotente pela dedupe_key", async () => {
    const maria = await createTestCustomer(db, "María José da Silva");
    const orderId = await makeOrder(maria);

    const first = await issue({ customerId: maria, orderId });
    expect(first.created).toBe(true);
    expect(first.code).toMatch(/^MARIA-[A-Z2-9]{5}$/);
    expect(first.expiresAt).toEqual(EXPIRES);

    const [row] = await db.select().from(schema.coupons).where(eq(schema.coupons.id, first.couponId));
    expect(row).toMatchObject({
      origin: "late_delivery",
      type: "percent",
      value: 10,
      maxUses: 1,
      perCustomerLimit: 1,
      customerId: maria,
      orderId,
      dedupeKey: "late_delivery:pedido-1",
      note: "Entrega 42 min depois da janela",
      isActive: true,
    });
    expect(row.phoneE164).toMatch(/^\+55/);

    const again = await issue({ customerId: maria, orderId, value: 99 });
    expect(again).toEqual({ couponId: first.couponId, code: first.code, expiresAt: EXPIRES, created: false });
    expect(await db.select().from(schema.coupons)).toHaveLength(1);

    const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "coupon.issue"));
    expect(audits).toHaveLength(1);
    expect(audits[0].actorType).toBe("system");
    expect(audits[0].reason).toBe("Entrega 42 min depois da janela");
  });

  it("sem cliente (vale para uma amiga): prefixo AMIGA, várias usos, 1 por cliente, primeira compra, quem indicou", async () => {
    const maria = await createTestCustomer(db, "Maria");
    const orderId = await makeOrder(maria);
    const voucher = await issue({
      dedupeKey: "referral:pedido-1",
      origin: "referral",
      customerId: null,
      orderId,
      referrerCustomerId: maria,
      maxUses: 3,
      firstPurchaseOnly: true,
    });
    expect(voucher.code).toMatch(/^AMIGA-/);
    const [row] = await db.select().from(schema.coupons).where(eq(schema.coupons.id, voucher.couponId));
    expect(row).toMatchObject({ customerId: null, phoneE164: null, maxUses: 3, perCustomerLimit: 1, firstPurchaseOnly: true, referrerCustomerId: maria });
  });

  it("colisão de código sorteia outro sufixo; prefixo pode ser dado", async () => {
    const ana = await createTestCustomer(db, "Ana");
    // Um cupom manual já ocupa o código que o primeiro sorteio geraria.
    const first = await issue({ customerId: ana, codePrefix: "DESCULPA", random: () => 0.42 });
    let calls = 0;
    // Dentro de uma transação de verdade: a colisão não pode abortá-la.
    const second = await db.transaction(async (tx) =>
      issueCoupon(tx as unknown as DbOrTx, {
        dedupeKey: "outra-chave",
        origin: "late_delivery",
        type: "percent",
        value: 10,
        expiresAt: EXPIRES,
        note: "",
        customerId: ana,
        codePrefix: "DESCULPA",
        // Mesmo sufixo na 1ª tentativa (colide), diferente na 2ª.
        random: () => (calls++ < 5 ? 0.42 : 0.1),
      }),
    );
    expect(first.code).toMatch(/^DESCULPA-/);
    expect(second.created).toBe(true);
    expect(second.code).not.toBe(first.code);
    // Sufixo sempre igual → desiste com erro claro, sem gravar nada a mais.
    await expect(issue({ customerId: ana, dedupeKey: "terceira", codePrefix: "DESCULPA", random: () => 0.42 })).rejects.toMatchObject({ code: "COUPON_CODE_COLLISION" });
  });

  it("sem cadastro mas com telefone: o cupom fica preso ao telefone; valor fora da régua é erro antes do INSERT", async () => {
    const lead = await issue({ customerId: null, phoneE164: "+5591988880000", dedupeKey: "lead-1", random: Math.random });
    const [row] = await db.select().from(schema.coupons).where(eq(schema.coupons.id, lead.couponId));
    expect(row).toMatchObject({ customerId: null, phoneE164: "+5591988880000" });

    await expect(issue({ customerId: null, dedupeKey: "ruim-1", type: "percent", value: 0 })).rejects.toThrowError(/entre 1 e 100/);
    await expect(issue({ customerId: null, dedupeKey: "ruim-2", type: "fixed", value: 0 })).rejects.toThrowError(/maior que zero/);
    await expect(issue({ customerId: null, dedupeKey: "ruim-3", type: "free_shipping", value: 5 })).rejects.toThrowError(/não tem valor/);
  });

  it("frete grátis emitido nasce com value 0 e escopo; cliente desconhecida é erro", async () => {
    const ana = await createTestCustomer(db, "Ana");
    const frete = await issue({ customerId: ana, type: "free_shipping", value: 0, freeShippingScope: "motoboy" });
    const [row] = await db.select().from(schema.coupons).where(eq(schema.coupons.id, frete.couponId));
    expect(row).toMatchObject({ type: "free_shipping", value: 0, freeShippingScope: "motoboy" });

    await expect(issue({ customerId: "00000000-0000-4000-8000-00000000dead", dedupeKey: "x" })).rejects.toMatchObject({ code: "CUSTOMER_NOT_FOUND" });
  });

  it("listIssuedCouponsForOrder / ForCustomer", async () => {
    const ana = await createTestCustomer(db, "Ana");
    const orderId = await makeOrder(ana);
    await issue({ customerId: ana, orderId, dedupeKey: "a", random: Math.random });
    await issue({ customerId: ana, orderId, dedupeKey: "b", origin: "price_protection", type: "fixed", value: 2000, random: Math.random });
    await issue({ customerId: ana, dedupeKey: "c", origin: "lia_gift", random: Math.random });

    expect((await listIssuedCouponsForOrder(sdb, orderId)).map((c) => c.origin)).toEqual(["late_delivery", "price_protection"]);
    expect(await listIssuedCouponsForCustomer(sdb, ana)).toHaveLength(3);
  });
});

describe("releaseCouponRedemptionInTx", () => {
  it("devolve o uso uma vez só; sem resgate não faz nada", async () => {
    const coupon = await createCoupon(sdb, { code: "DEZ", type: "percent", value: 10, userId: FIXED_USER_ID });
    const ana = await createTestCustomer(db, "Ana");
    const orderId = await makeOrder(ana);
    await redeemCouponInTx(sdb, { couponId: coupon.id, orderId, customerId: ana, phoneE164: null, code: "DEZ", discountCents: 100, shippingDiscountCents: 0, appliedValue: 10 });

    expect(await releaseCouponRedemptionInTx(sdb, orderId)).toBe(coupon.id);
    expect(await releaseCouponRedemptionInTx(sdb, orderId)).toBeNull();
    expect(await releaseCouponRedemptionInTx(sdb, "00000000-0000-4000-8000-00000000dead")).toBeNull();
    const [row] = await db.select().from(schema.coupons).where(eq(schema.coupons.id, coupon.id));
    expect(row.usedCount).toBe(0);
  });
});

describe("deleteCoupon e getCouponReport", () => {
  it("apaga só cupom nunca usado (com audit); usado fica no histórico", async () => {
    const livre = await createCoupon(sdb, { code: "LIVRE", type: "percent", value: 10, userId: FIXED_USER_ID, productRefs: [] });
    await deleteCoupon(sdb, { couponId: livre.id, userId: FIXED_USER_ID });
    expect(await db.select().from(schema.coupons)).toHaveLength(0);
    expect(await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "coupon.delete"))).toHaveLength(1);

    const usado = await createCoupon(sdb, { code: "USADO", type: "percent", value: 10, userId: FIXED_USER_ID });
    const ana = await createTestCustomer(db, "Ana Lima");
    const orderId = await makeOrder(ana);
    await redeemCouponInTx(sdb, { couponId: usado.id, orderId, customerId: ana, phoneE164: null, code: "USADO", discountCents: 100, shippingDiscountCents: 50, appliedValue: 10 });
    await expect(deleteCoupon(sdb, { couponId: usado.id, userId: FIXED_USER_ID })).rejects.toMatchObject({ code: "COUPON_IN_USE" });

    const report = await getCouponReport(sdb, usado.id);
    expect(report?.coupon.code).toBe("USADO");
    expect(report?.redemptions).toHaveLength(1);
    expect(report?.redemptions[0]).toMatchObject({ orderId, customerId: ana, customerName: "Ana Lima", discountCents: 100, shippingDiscountCents: 50, orderStatus: "paid", releasedAt: null });
    expect(await getCouponReport(sdb, "00000000-0000-4000-8000-00000000dead")).toBeNull();
    await expect(deleteCoupon(sdb, { couponId: "00000000-0000-4000-8000-00000000dead", userId: FIXED_USER_ID })).rejects.toBeInstanceOf(ServiceError);
  });
});

describe("resolveCouponLink", () => {
  it("cupom de uma peça publicada → a peça; senão a vitrine; inativo/vencido/inexistente → null", async () => {
    const { productId } = await createTestVariant(db, { sku: "LONGO-DUNAS" });
    await createCoupon(sdb, { code: "DUNAS", type: "percent", value: 10, userId: FIXED_USER_ID, productRefs: ["longo-dunas"] });
    await createCoupon(sdb, { code: "GERAL", type: "percent", value: 10, userId: FIXED_USER_ID });
    await createCoupon(sdb, { code: "PAUSADO", type: "percent", value: 10, userId: FIXED_USER_ID, isActive: false });
    await createCoupon(sdb, { code: "VENCIDO", type: "percent", value: 10, userId: FIXED_USER_ID, expiresAt: new Date(Date.now() - 1000) });

    expect(await resolveCouponLink(sdb, "dunas")).toEqual({ code: "DUNAS", redirectTo: "/produto/longo-dunas" });
    expect(await resolveCouponLink(sdb, "GERAL")).toEqual({ code: "GERAL", redirectTo: "/" });
    expect(await resolveCouponLink(sdb, "PAUSADO")).toBeNull();
    expect(await resolveCouponLink(sdb, "VENCIDO")).toBeNull();
    expect(await resolveCouponLink(sdb, "NADA")).toBeNull();

    // Peça arquivada: cai na vitrine.
    await db.update(schema.products).set({ status: "archived" }).where(eq(schema.products.id, productId));
    expect(await resolveCouponLink(sdb, "DUNAS")).toEqual({ code: "DUNAS", redirectTo: "/" });
  });
});
