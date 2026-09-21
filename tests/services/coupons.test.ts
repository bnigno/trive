import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import * as schema from "@/db/schema";
import { formatCentsBRL } from "@/lib/money";
import type { DbOrTx } from "@/queue/enqueue";
import {
  createCoupon,
  listCoupons,
  quoteCoupon,
  redeemCouponInTx,
  ServiceError,
  updateCoupon,
  type CreateCouponInput,
  type RedeemCouponInput,
} from "@/services/coupons";
import { createTestCustomer, createTestDb, createTestVariant, FIXED_USER_ID, type TestDb } from "../helpers/db";

let db: TestDb;
let close: () => Promise<void>;
// PGlite (testes) e postgres-js (produção) divergem apenas no tipo de
// retorno de execute(); a API drizzle usada pelos serviços é idêntica.
let sdb: DbOrTx;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  sdb = db as unknown as DbOrTx;
});

afterEach(async () => {
  await close();
});

function makeCoupon(over: Partial<CreateCouponInput> = {}) {
  return createCoupon(sdb, {
    code: "DEZ10",
    type: "percent",
    value: 10,
    userId: FIXED_USER_ID,
    ...over,
  });
}

/** Uma peça vendável (variante ativa com preço ativo) — devolve a linha da sacola com 1 unidade. */
async function sellable(priceCents: number, opts: { sku?: string; quantity?: number } = {}) {
  const { variantId, productId } = await createTestVariant(db, { sku: opts.sku, onHand: 10 });
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
  return { variantId, productId, quantity: opts.quantity ?? 1 };
}

async function quote(code: string, subtotalCents: number) {
  const item = await sellable(subtotalCents);
  return quoteCoupon(sdb, { code, items: [item] });
}

async function getRow(couponId: string) {
  const [row] = await db.select().from(schema.coupons).where(eq(schema.coupons.id, couponId));
  return row;
}

/** Um pedido mínimo para o resgate apontar (a FK exige pedido real). */
async function makeOrder(customerId: string): Promise<string> {
  const [order] = await db
    .insert(schema.orders)
    .values({ customerId, status: "draft", subtotalCents: 1000, discountCents: 0, shippingCents: 0, totalCents: 1000 })
    .returning({ id: schema.orders.id });
  return order.id;
}

async function redeemInput(couponId: string, over: Partial<RedeemCouponInput> = {}): Promise<RedeemCouponInput> {
  const customerId = over.customerId ?? (await createTestCustomer(db));
  return {
    couponId,
    orderId: over.orderId ?? (await makeOrder(customerId)),
    customerId,
    phoneE164: null,
    code: "X",
    discountCents: 100,
    shippingDiscountCents: 0,
    appliedValue: 10,
    ...over,
  };
}

describe("quoteCoupon", () => {
  it("percent: arredonda o desconto para BAIXO (floor) e devolve appliedValue", async () => {
    await makeCoupon({ code: "DEZ10", type: "percent", value: 10 });

    // 10% de R$ 9,99 = 99,9 centavos → 99 (nunca arredonda a favor da loja).
    const q = await quote("DEZ10", 999);
    expect(q.discountCents).toBe(99);
    expect(q.code).toBe("DEZ10");
    expect(q.appliedValue).toBe(10);
    expect(q.freeShipping).toBe(false);
    expect(q.pending).toEqual([]);

    const exact = await quote("DEZ10", 10000);
    expect(exact.discountCents).toBe(1000);
  });

  it("normaliza o código: minúsculas e espaços do cliente encontram o cupom", async () => {
    const created = await makeCoupon({ code: "dez10" });
    expect(created.code).toBe("DEZ10"); // armazenado UPPERCASE

    const q = await quote("  dez10  ", 5000);
    expect(q.couponId).toBe(created.id);
    expect(q.code).toBe("DEZ10");
  });

  it("fixed maior que o subtotal: desconto é limitado ao subtotal (clamp)", async () => {
    await makeCoupon({ code: "VALE100", type: "fixed", value: 10000 });
    expect((await quote("VALE100", 4990)).discountCents).toBe(4990);
  });

  it("mínimo não atingido: mensagem contém o valor mínimo formatado em BRL", async () => {
    await makeCoupon({ code: "MIN50", minOrderCents: 5000 });

    const error = await quote("MIN50", 4999).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceError);
    expect((error as ServiceError).code).toBe("COUPON_MIN_ORDER");
    expect((error as Error).message).toContain(formatCentsBRL(5000));

    // No limite exato o cupom vale.
    expect((await quote("MIN50", 5000)).discountCents).toBe(500);
  });

  it("cupom inexistente: mensagem cita o código digitado", async () => {
    const error = await quote("nao-existe", 1000).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceError);
    expect((error as ServiceError).code).toBe("COUPON_NOT_FOUND");
    expect((error as Error).message).toContain("NAO-EXISTE");
    expect((error as Error).message).toContain("não existe");
  });

  it("cupom inativo é recusado", async () => {
    await makeCoupon({ code: "PAUSADO", isActive: false });
    await expect(quote("PAUSADO", 1000)).rejects.toMatchObject({ code: "COUPON_INACTIVE" });
  });

  it("vigência que começa no futuro é recusada; depois do início, vale", async () => {
    await makeCoupon({ code: "FUTURO", startsAt: new Date(Date.now() + 60 * 60_000) });
    await expect(quote("FUTURO", 1000)).rejects.toMatchObject({ code: "COUPON_NOT_STARTED" });

    await makeCoupon({ code: "VIGENTE", startsAt: new Date(Date.now() - 60_000) });
    expect((await quote("VIGENTE", 1000)).discountCents).toBe(100);
  });

  it("cupom expirado é recusado", async () => {
    await makeCoupon({
      code: "VENCIDO",
      startsAt: new Date(Date.now() - 2 * 60_000),
      expiresAt: new Date(Date.now() - 60_000),
    });
    await expect(quote("VENCIDO", 1000)).rejects.toMatchObject({ code: "COUPON_EXPIRED" });
  });

  it("esgotado (used_count >= max_uses) é recusado na cotação", async () => {
    const created = await makeCoupon({ code: "UNICO", maxUses: 1 });
    await db.update(schema.coupons).set({ usedCount: 1 }).where(eq(schema.coupons.id, created.id));

    const error = await quote("UNICO", 1000).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceError);
    expect((error as ServiceError).code).toBe("COUPON_EXHAUSTED");
    expect((error as Error).message).toContain("esgotou");
  });

  it("variante sem preço ativo não soma no subtotal", async () => {
    await makeCoupon({ code: "DEZ10" });
    const semPreco = await createTestVariant(db, { onHand: 1 });
    const comPreco = await sellable(1000);
    const q = await quoteCoupon(sdb, { code: "DEZ10", items: [comPreco, { variantId: semPreco.variantId, quantity: 3 }] });
    expect(q.discountCents).toBe(100);
  });

  it("restrição por peça: desconto só sobre as peças do cupom; sem nenhuma delas, recusa", async () => {
    const vestido = await sellable(20000, { sku: "VESTIDO-1" });
    const blusa = await sellable(8000, { sku: "BLUSA-1" });
    await makeCoupon({ code: "SOVESTIDO", productRefs: ["vestido-1"] });

    const q = await quoteCoupon(sdb, { code: "SOVESTIDO", items: [vestido, blusa] });
    expect(q.discountCents).toBe(2000);

    await expect(quoteCoupon(sdb, { code: "SOVESTIDO", items: [blusa] })).rejects.toMatchObject({ code: "COUPON_NO_ELIGIBLE_ITEMS" });
  });

  it("restrição por categoria casa pela categoria direta da peça", async () => {
    const [cat] = await db.insert(schema.categories).values({ name: "Blusas", slug: "blusas" }).returning({ id: schema.categories.id });
    const blusa = await sellable(8000, { sku: "BLUSA-2" });
    await db.update(schema.products).set({ categoryId: cat.id }).where(eq(schema.products.id, blusa.productId));
    const outra = await sellable(5000, { sku: "OUTRA-2" });
    await makeCoupon({ code: "BLUSAS", categoryIds: [cat.id] });

    const q = await quoteCoupon(sdb, { code: "BLUSAS", items: [blusa, outra] });
    expect(q.discountCents).toBe(800);
  });

  it("frete grátis: perdoa o frete informado; escopo motoboy recusa Correios", async () => {
    await makeCoupon({ code: "FRETE", type: "free_shipping", value: 0 });
    const item = await sellable(9000);
    const q = await quoteCoupon(sdb, { code: "FRETE", items: [item], shipping: { cents: 1500, kind: "motoboy" } });
    expect(q).toMatchObject({ freeShipping: true, discountCents: 0, shippingDiscountCents: 1500, appliedValue: 0 });

    await makeCoupon({ code: "MOTO", type: "free_shipping", value: 0, freeShippingScope: "motoboy" });
    await expect(quoteCoupon(sdb, { code: "MOTO", items: [item], shipping: { cents: 3000, kind: "correios" } })).rejects.toMatchObject({ code: "COUPON_SHIPPING_SCOPE" });
    const pendente = await quoteCoupon(sdb, { code: "MOTO", items: [item], shipping: null });
    expect(pendente.pending).toEqual(["shipping_scope"]);
  });

  it("cupom pessoal: acha o cadastro pelo CPF/telefone; de outra cliente recusa; anônima fica pendente", async () => {
    const dona = await createTestCustomer(db, "Maria Dona");
    const [row] = await db.select({ phone: schema.customers.phoneE164 }).from(schema.customers).where(eq(schema.customers.id, dona));
    await db.update(schema.customers).set({ documentNumber: "52998224725", documentType: "cpf" }).where(eq(schema.customers.id, dona));
    await makeCoupon({ code: "SODELA", customerPhone: row.phone });
    const item = await sellable(9000);

    const porCpf = await quoteCoupon(sdb, { code: "SODELA", items: [item], identity: { documentDigits: "52998224725" } });
    expect(porCpf.pending).toEqual([]);
    const porTelefone = await quoteCoupon(sdb, { code: "SODELA", items: [item], identity: { phoneE164: row.phone } });
    expect(porTelefone.pending).toEqual([]);

    await expect(quoteCoupon(sdb, { code: "SODELA", items: [item], identity: { phoneE164: "+5591000000000", documentDigits: "16899535009" } })).rejects.toMatchObject({ code: "COUPON_NOT_YOURS" });

    const anonima = await quoteCoupon(sdb, { code: "SODELA", items: [item] });
    expect(anonima.pending).toEqual(["personal"]);
  });

  it("primeira compra: cliente com pedido pago é recusada; nova cliente passa; anônima fica pendente", async () => {
    const veterana = await createTestCustomer(db, "Ana Veterana");
    await db.insert(schema.orders).values({ customerId: veterana, status: "paid", paidAt: new Date(), subtotalCents: 1000, discountCents: 0, shippingCents: 0, totalCents: 1000 });
    await makeCoupon({ code: "ESTREIA", firstPurchaseOnly: true });
    const item = await sellable(9000);

    await expect(quoteCoupon(sdb, { code: "ESTREIA", items: [item], identity: { customerId: veterana } })).rejects.toMatchObject({ code: "COUPON_FIRST_PURCHASE_ONLY" });
    const nova = await quoteCoupon(sdb, { code: "ESTREIA", items: [item], identity: { phoneE164: "+5591988887777" } });
    expect(nova.pending).toEqual([]);
    expect((await quoteCoupon(sdb, { code: "ESTREIA", items: [item] })).pending).toEqual(["first_purchase"]);

    // Pedido ainda aguardando o Pix também conta: a estreia não vale duas vezes seguidas.
    const pendente = await createTestCustomer(db, "Bia Pendente");
    await db.insert(schema.orders).values({ customerId: pendente, status: "pending_payment", subtotalCents: 1000, discountCents: 0, shippingCents: 0, totalCents: 1000 });
    await expect(quoteCoupon(sdb, { code: "ESTREIA", items: [item], identity: { customerId: pendente } })).rejects.toMatchObject({ code: "COUPON_FIRST_PURCHASE_ONLY" });
    // Cancelado sem pagar deixa de contar.
    await db.update(schema.orders).set({ status: "canceled" }).where(eq(schema.orders.customerId, pendente));
    expect((await quoteCoupon(sdb, { code: "ESTREIA", items: [item], identity: { customerId: pendente } })).pending).toEqual([]);
  });

  it("janela de horário e dia da semana no relógio de São Paulo", async () => {
    // Sábado 2026-09-19 às 14:30 SP = 17:30Z.
    await makeCoupon({ code: "CHUVA", validFromMinute: 840, validToMinute: 900 });
    await makeCoupon({ code: "FIMDESEMANA", validWeekdays: [0, 6] });
    const item = await sellable(9000);
    const sabado1430 = new Date("2026-09-19T17:30:00.000Z");
    const segunda1030 = new Date("2026-09-21T13:30:00.000Z");

    expect((await quoteCoupon(sdb, { code: "CHUVA", items: [item], now: sabado1430 })).discountCents).toBe(900);
    await expect(quoteCoupon(sdb, { code: "CHUVA", items: [item], now: segunda1030 })).rejects.toMatchObject({ code: "COUPON_OUTSIDE_HOURS" });
    expect((await quoteCoupon(sdb, { code: "FIMDESEMANA", items: [item], now: sabado1430 })).discountCents).toBe(900);
    await expect(quoteCoupon(sdb, { code: "FIMDESEMANA", items: [item], now: segunda1030 })).rejects.toMatchObject({ code: "COUPON_WRONG_WEEKDAY" });
  });
});

describe("redeemCouponInTx", () => {
  it("guard atômico: max_uses 1 disputado 2x → um resgata, o outro falha e used_count fica em 1", async () => {
    const created = await makeCoupon({ code: "UNICO", maxUses: 1 });
    const a = await redeemInput(created.id);
    const b = await redeemInput(created.id);

    // Duas transações disputando o último uso: o guard fica no WHERE do
    // próprio UPDATE, então a segunda afeta 0 linhas independente da ordem.
    const results = await Promise.allSettled([
      db.transaction(async (tx) => redeemCouponInTx(tx as unknown as DbOrTx, a)),
      db.transaction(async (tx) => redeemCouponInTx(tx as unknown as DbOrTx, b)),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(ServiceError);
    expect((rejected[0].reason as ServiceError).code).toBe("COUPON_EXHAUSTED");

    // NUNCA passa do limite, mesmo com concorrência; um resgate só.
    expect((await getRow(created.id)).usedCount).toBe(1);
    const redemptions = await db.select().from(schema.couponRedemptions);
    expect(redemptions).toHaveLength(1);
    expect(redemptions[0]).toMatchObject({ couponId: created.id, discountCents: 100, appliedValue: 10, releasedAt: null });
  });

  it("sem max_uses: resgata sem limite, um resgate por pedido", async () => {
    const created = await makeCoupon({ code: "LIVRE" });
    await redeemCouponInTx(sdb, await redeemInput(created.id));
    await redeemCouponInTx(sdb, await redeemInput(created.id));
    expect((await getRow(created.id)).usedCount).toBe(2);
  });

  it("limite por cliente: o segundo pedido da MESMA cliente falha e a transação desfaz", async () => {
    const created = await makeCoupon({ code: "UMAVEZ", perCustomerLimit: 1 });
    const cliente = await createTestCustomer(db);
    // Os pedidos nascem ANTES de abrir a transação (PGlite é uma conexão só).
    const primeiro = await redeemInput(created.id, { customerId: cliente });
    const segundo = await redeemInput(created.id, { customerId: cliente });
    const outra = await redeemInput(created.id);
    await db.transaction(async (tx) => redeemCouponInTx(tx as unknown as DbOrTx, primeiro));

    await expect(
      db.transaction(async (tx) => redeemCouponInTx(tx as unknown as DbOrTx, segundo)),
    ).rejects.toMatchObject({ code: "COUPON_CUSTOMER_LIMIT" });
    expect((await getRow(created.id)).usedCount).toBe(1);
    expect(await db.select().from(schema.couponRedemptions)).toHaveLength(1);

    // Outra cliente passa.
    await db.transaction(async (tx) => redeemCouponInTx(tx as unknown as DbOrTx, outra));
    expect((await getRow(created.id)).usedCount).toBe(2);
  });
});

describe("createCoupon", () => {
  it("cria com code UPPERCASE, grava audit e valida percent 1..100", async () => {
    const created = await makeCoupon({ code: "bemvindo", type: "percent", value: 15 });
    expect(created.code).toBe("BEMVINDO");
    expect(created.usedCount).toBe(0);
    expect(created.isActive).toBe(true);
    expect(created.origin).toBe("manual");

    const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "coupon.create"));
    expect(audits).toHaveLength(1);
    expect(audits[0].actorId).toBe(FIXED_USER_ID);
    expect(audits[0].entityId).toBe(created.id);
    expect(audits[0].after).toMatchObject({ code: "BEMVINDO", value: 15 });

    await expect(makeCoupon({ code: "DEMAIS", type: "percent", value: 101 })).rejects.toThrowError(/entre 1 e 100/);
  });

  it("código duplicado (mesmo com caixa diferente) → erro amigável", async () => {
    await makeCoupon({ code: "DEZ10" });

    const error = await makeCoupon({ code: "dez10" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceError);
    expect((error as ServiceError).code).toBe("COUPON_CODE_TAKEN");
    expect((error as Error).message).toContain("DEZ10");
  });

  it("frete grátis nasce com value 0; peça desconhecida é erro amigável; horário só de um lado é recusado", async () => {
    const frete = await makeCoupon({ code: "FRETE", type: "free_shipping", value: 0, freeShippingScope: "correios" });
    expect(frete.value).toBe(0);
    expect(frete.freeShippingScope).toBe("correios");

    await expect(makeCoupon({ code: "X1", productRefs: ["nao-existe"] })).rejects.toMatchObject({ code: "COUPON_PRODUCT_UNKNOWN" });
    await expect(makeCoupon({ code: "X2", validFromMinute: 840 })).rejects.toThrowError(/início e o de fim/);
  });

  it("telefone da cliente como a dona digita vira E.164; inválido é erro amigável", async () => {
    const pessoal = await makeCoupon({ code: "PESSOAL", customerPhone: "(91) 99999-0000" });
    expect(pessoal.phoneE164).toBe("+5591999990000");
    await expect(makeCoupon({ code: "X3", customerPhone: "123" })).rejects.toMatchObject({ code: "COUPON_PHONE_INVALID" });
  });

  it("editar: telefone igual não re-resolve; vazio só solta o vínculo por telefone; preso ao cadastro fica preso", async () => {
    const dona = await createTestCustomer(db, "Maria Dona");
    const [row] = await db.select({ phone: schema.customers.phoneE164 }).from(schema.customers).where(eq(schema.customers.id, dona));
    const porTelefone = await makeCoupon({ code: "PORTEL", customerPhone: row.phone });
    expect(porTelefone.customerId).toBe(dona);

    // Mesmo telefone (formatado diferente) + só a nota: vínculo intacto.
    const same = await updateCoupon(sdb, { couponId: porTelefone.id, customerPhone: row.phone, note: "x", userId: FIXED_USER_ID });
    expect(same).toMatchObject({ customerId: dona, phoneE164: row.phone });
    // Vazio: solta.
    const solto = await updateCoupon(sdb, { couponId: porTelefone.id, customerPhone: null, userId: FIXED_USER_ID });
    expect(solto).toMatchObject({ customerId: null, phoneE164: null });

    // Preso só ao cadastro (como os emitidos pela casa): o form vazio não abre o cupom.
    const [semTelefone] = await db.insert(schema.customers).values({ fullName: "Sem Telefone" }).returning({ id: schema.customers.id });
    const [preso] = await db
      .insert(schema.coupons)
      .values({ code: "PRESO", type: "percent", value: 10, customerId: semTelefone.id })
      .returning({ id: schema.coupons.id });
    const ainda = await updateCoupon(sdb, { couponId: preso.id, customerPhone: null, note: "y", userId: FIXED_USER_ID });
    expect(ainda.customerId).toBe(semTelefone.id);
  });
});

describe("updateCoupon", () => {
  it("ajusta isActive/expiresAt/maxUses/nota com audit", async () => {
    const created = await makeCoupon({ code: "AJUSTE", maxUses: 5 });
    const newExpiry = new Date(Date.now() + 24 * 60 * 60_000);

    const updated = await updateCoupon(sdb, {
      couponId: created.id,
      isActive: false,
      expiresAt: newExpiry,
      maxUses: 10,
      note: "campanha do story",
      userId: FIXED_USER_ID,
    });
    expect(updated.isActive).toBe(false);
    expect(updated.expiresAt?.getTime()).toBe(newExpiry.getTime());
    expect(updated.maxUses).toBe(10);
    expect(updated.note).toBe("campanha do story");
    expect(updated.type).toBe("percent");
    expect(updated.value).toBe(10);

    const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "coupon.update"));
    expect(audits).toHaveLength(1);
    expect(audits[0].before).toMatchObject({ isActive: true, maxUses: 5 });
    expect(audits[0].after).toMatchObject({ isActive: false, maxUses: 10 });
  });

  it("tipo/valor/regras mudam enquanto ninguém usou; depois do primeiro uso, COUPON_IN_USE", async () => {
    const created = await makeCoupon({ code: "REGRAS" });
    const updated = await updateCoupon(sdb, { couponId: created.id, type: "fixed", value: 2500, perCustomerLimit: 1, userId: FIXED_USER_ID });
    expect(updated.type).toBe("fixed");
    expect(updated.value).toBe(2500);
    expect(updated.perCustomerLimit).toBe(1);

    await redeemCouponInTx(sdb, await redeemInput(created.id));
    await expect(updateCoupon(sdb, { couponId: created.id, value: 3000, userId: FIXED_USER_ID })).rejects.toMatchObject({ code: "COUPON_IN_USE" });
    // O que não é regra continua editável.
    expect((await updateCoupon(sdb, { couponId: created.id, isActive: false, userId: FIXED_USER_ID })).isActive).toBe(false);
  });

  it("cupom inexistente → COUPON_NOT_FOUND", async () => {
    await expect(
      updateCoupon(sdb, { couponId: "00000000-0000-4000-8000-00000000dead", isActive: false, userId: FIXED_USER_ID }),
    ).rejects.toMatchObject({ code: "COUPON_NOT_FOUND" });
  });
});

describe("listCoupons", () => {
  it("lista todos com contagem de usos e de resgates, mais recentes primeiro", async () => {
    const a = await makeCoupon({ code: "PRIMEIRO" });
    const b = await makeCoupon({ code: "SEGUNDO", type: "fixed", value: 500 });
    await redeemCouponInTx(sdb, await redeemInput(a.id));

    // createdAt pode empatar no mesmo ms; ordena por (createdAt, id) desc.
    const list = await listCoupons(sdb);
    expect(list).toHaveLength(2);
    expect(list.map((c) => c.code).sort()).toEqual(["PRIMEIRO", "SEGUNDO"]);
    expect(list.find((c) => c.id === a.id)).toMatchObject({ usedCount: 1, redemptionsCount: 1, everRedeemed: true });
    expect(list.find((c) => c.id === b.id)).toMatchObject({ usedCount: 0, redemptionsCount: 0, everRedeemed: false });

    // Resgate devolvido: some de "quem usou", mas o cupom continua "já usado" (regras travadas).
    const [redemption] = await db.select({ orderId: schema.couponRedemptions.orderId }).from(schema.couponRedemptions);
    await db.update(schema.couponRedemptions).set({ releasedAt: new Date() }).where(eq(schema.couponRedemptions.orderId, redemption.orderId));
    const after = await listCoupons(sdb);
    expect(after.find((c) => c.id === a.id)).toMatchObject({ redemptionsCount: 0, everRedeemed: true });
  });
});
