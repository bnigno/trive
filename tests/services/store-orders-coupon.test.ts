// Integração cupom × checkout da loja: o desconto entra no pedido, o snapshot
// do código é gravado e o uso é consumido NA MESMA transação — cupom inválido
// derruba o checkout sem persistir nada (nem cliente, nem pedido, nem reserva).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import * as schema from "@/db/schema";
import { formatCentsBRL } from "@/lib/money";
import type { DbOrTx } from "@/queue/enqueue";
import { createCoupon, type CreateCouponInput } from "@/services/coupons";
import {
  createStoreOrder,
  expireOverdueReservations,
  ServiceError,
  type CreateStoreOrderInput,
} from "@/services/store-orders";
import {
  createTestDb,
  createTestVariant,
  FIXED_USER_ID,
  type TestDb,
} from "../helpers/db";

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

const VALID_CPF = "529.982.247-25";
const VALID_CPF_2 = "168.995.350-09";

/** Vitrine pronta: variante ativa com preço, estoque e uma opção de frete. */
async function setupStore() {
  const { variantId } = await createTestVariant(db, {
    sku: "CANECA-AZUL",
    costCents: 1200,
    onHand: 10,
    name: "Caneca Azul",
  });
  await db.insert(schema.priceVersions).values({
    productVariantId: variantId,
    versionNumber: 1,
    status: "active",
    priceCents: 4990,
    origin: "initial",
    breakdown: {},
    costSnapshotCents: 1200,
    computedMarginRate: "0.3000",
    activatedAt: new Date(),
  });
  const [rate] = await db
    .insert(schema.shippingRates)
    .values({ name: "PAC", priceCents: 1990 })
    .returning({ id: schema.shippingRates.id });
  return { variantId, rateId: rate.id };
}

function makeCoupon(over: Partial<CreateCouponInput> = {}) {
  return createCoupon(sdb, {
    code: "DEZ10",
    type: "percent",
    value: 10,
    userId: FIXED_USER_ID,
    ...over,
  });
}

function baseInput(
  variantId: string,
  shippingRateId: string,
  over: Partial<CreateStoreOrderInput> = {},
): CreateStoreOrderInput {
  return {
    customer: {
      fullName: "Maria da Silva",
      document: VALID_CPF,
      phone: "(11) 99999-8888",
      marketingOptIn: false,
    },
    address: {
      postalCode: "01310-100",
      street: "Avenida Paulista",
      number: "1000",
      district: "Bela Vista",
      city: "São Paulo",
      state: "SP",
    },
    // Subtotal: 2 × R$ 49,90 = R$ 99,80 (9980 centavos).
    items: [{ variantId, quantity: 2, expectedUnitPriceCents: 4990 }],
    shippingRateId,
    expectedShippingCents: 1990,
    ...over,
  };
}

async function countRows() {
  const allOrders = await db.select().from(schema.orders);
  const allCustomers = await db.select().from(schema.customers);
  const allMovements = await db.select().from(schema.stockMovements);
  return {
    orders: allOrders.length,
    customers: allCustomers.length,
    movements: allMovements.length,
  };
}

async function getCouponRow(couponId: string) {
  const [row] = await db
    .select()
    .from(schema.coupons)
    .where(eq(schema.coupons.id, couponId));
  return row;
}

describe("createStoreOrder com cupom", () => {
  it("cupom percent válido: desconto (floor), snapshot do código e used_count na MESMA transação", async () => {
    const { variantId, rateId } = await setupStore();
    const coupon = await makeCoupon({ code: "DEZ10", type: "percent", value: 10 });

    // Cliente digita em minúsculas — serviço normaliza.
    const result = await createStoreOrder(
      sdb,
      baseInput(variantId, rateId, { couponCode: " dez10 " }),
    );

    // 10% de 9980 = 998; total = 9980 - 998 + 1990.
    expect(result.totalCents).toBe(9980 - 998 + 1990);

    const [order] = await db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, result.orderId));
    expect(order.status).toBe("pending_payment");
    expect(order.subtotalCents).toBe(9980);
    expect(order.discountCents).toBe(998);
    expect(order.couponId).toBe(coupon.id);
    expect(order.couponCode).toBe("DEZ10"); // snapshot UPPERCASE
    expect(order.totalCents).toBe(9980 - 998 + 1990);

    // Uso consumido junto com o pedido, com o resgate (quem, quanto, valor do cupom).
    expect((await getCouponRow(coupon.id)).usedCount).toBe(1);
    const redemptions = await db.select().from(schema.couponRedemptions);
    expect(redemptions).toHaveLength(1);
    expect(redemptions[0]).toMatchObject({
      couponId: coupon.id,
      orderId: result.orderId,
      customerId: order.customerId,
      phoneE164: "+5511999998888",
      code: "DEZ10",
      discountCents: 998,
      shippingDiscountCents: 0,
      appliedValue: 10,
      releasedAt: null,
    });

    // Audit do pedido registra o cupom aplicado.
    const audits = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "order.store_create"));
    expect(audits).toHaveLength(1);
    expect(audits[0].after).toMatchObject({
      couponCode: "DEZ10",
      discountCents: 998,
    });
  });

  it("cupom fixed maior que o subtotal: clamp — desconto = subtotal, total = só o frete", async () => {
    const { variantId, rateId } = await setupStore();
    await makeCoupon({ code: "VALEZAO", type: "fixed", value: 999999 });

    const result = await createStoreOrder(
      sdb,
      baseInput(variantId, rateId, { couponCode: "VALEZAO" }),
    );

    const [order] = await db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, result.orderId));
    expect(order.discountCents).toBe(9980);
    expect(order.totalCents).toBe(1990); // sobra apenas o frete
  });

  it("cupom inválido: erro claro e NADA persiste (nem cliente, nem pedido, nem reserva)", async () => {
    const { variantId, rateId } = await setupStore();

    const error = await createStoreOrder(
      sdb,
      baseInput(variantId, rateId, { couponCode: "NAOEXISTE" }),
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ServiceError);
    expect((error as ServiceError).code).toBe("COUPON_NOT_FOUND");
    expect((error as Error).message).toContain("NAOEXISTE");

    expect(await countRows()).toEqual({ orders: 0, customers: 0, movements: 0 });
    const [level] = await db
      .select()
      .from(schema.stockLevels)
      .where(eq(schema.stockLevels.productVariantId, variantId));
    expect(level.reserved).toBe(0);
  });

  it("mínimo não atingido: mensagem com o valor formatado e nada persiste", async () => {
    const { variantId, rateId } = await setupStore();
    await makeCoupon({ code: "MIN200", minOrderCents: 20000 });

    const error = await createStoreOrder(
      sdb,
      baseInput(variantId, rateId, { couponCode: "MIN200" }),
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ServiceError);
    expect((error as ServiceError).code).toBe("COUPON_MIN_ORDER");
    expect((error as Error).message).toContain(formatCentsBRL(20000));

    expect(await countRows()).toEqual({ orders: 0, customers: 0, movements: 0 });
  });

  it("esgotado no limite exato: 1º pedido consome o último uso, 2º falha e não persiste nada dele", async () => {
    const { variantId, rateId } = await setupStore();
    const coupon = await makeCoupon({ code: "UNICO", maxUses: 1 });

    await createStoreOrder(
      sdb,
      baseInput(variantId, rateId, { couponCode: "UNICO" }),
    );
    expect((await getCouponRow(coupon.id)).usedCount).toBe(1);

    const error = await createStoreOrder(
      sdb,
      baseInput(variantId, rateId, {
        customer: {
          fullName: "José Pereira",
          document: VALID_CPF_2,
          phone: "(21) 97777-6666",
          marketingOptIn: false,
        },
        couponCode: "UNICO",
      }),
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ServiceError);
    expect((error as ServiceError).code).toBe("COUPON_EXHAUSTED");
    expect((error as Error).message).toContain("esgotou");

    // Só o 1º pedido/cliente existe; o limite não foi ultrapassado.
    const rows = await countRows();
    expect(rows.orders).toBe(1);
    expect(rows.customers).toBe(1);
    expect((await getCouponRow(coupon.id)).usedCount).toBe(1);
  });

  it("cupom que ainda não começou a vigência é recusado no checkout", async () => {
    const { variantId, rateId } = await setupStore();
    await makeCoupon({
      code: "FUTURO",
      startsAt: new Date(Date.now() + 60 * 60_000),
    });

    const error = await createStoreOrder(
      sdb,
      baseInput(variantId, rateId, { couponCode: "FUTURO" }),
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ServiceError);
    expect((error as ServiceError).code).toBe("COUPON_NOT_STARTED");
    expect(await countRows()).toEqual({ orders: 0, customers: 0, movements: 0 });
  });

  it("regressão: pedido SEM cupom segue inalterado (desconto 0, snapshots nulos)", async () => {
    const { variantId, rateId } = await setupStore();

    const result = await createStoreOrder(sdb, baseInput(variantId, rateId));

    expect(result.totalCents).toBe(9980 + 1990);
    const [order] = await db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, result.orderId));
    expect(order.status).toBe("pending_payment");
    expect(order.discountCents).toBe(0);
    expect(order.couponId).toBeNull();
    expect(order.couponCode).toBeNull();
    expect(order.totalCents).toBe(9980 + 1990);

    // couponCode vazio ("") também significa "sem cupom" — não valida nada.
    const second = await createStoreOrder(
      sdb,
      baseInput(variantId, rateId, {
        customer: {
          fullName: "José Pereira",
          document: VALID_CPF_2,
          phone: "(21) 97777-6666",
          marketingOptIn: false,
        },
        couponCode: "",
      }),
    );
    const [secondOrder] = await db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, second.orderId));
    expect(secondOrder.couponCode).toBeNull();
    expect(secondOrder.discountCents).toBe(0);
  });

  it("uma vez por cliente: 2º pedido da mesma cliente é recusado; cancelar o 1º sem pagar devolve o uso", async () => {
    const { variantId, rateId } = await setupStore();
    const coupon = await makeCoupon({ code: "UMAVEZ", perCustomerLimit: 1 });

    const first = await createStoreOrder(sdb, baseInput(variantId, rateId, { couponCode: "UMAVEZ" }));
    expect((await getCouponRow(coupon.id)).usedCount).toBe(1);

    const error = await createStoreOrder(sdb, baseInput(variantId, rateId, { couponCode: "UMAVEZ" })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceError);
    expect((error as ServiceError).code).toBe("COUPON_CUSTOMER_LIMIT");
    expect((await countRows()).orders).toBe(1);

    // A reserva do 1º vence sem pagamento → cancelado → o uso volta e o resgate fica "devolvido".
    await db.update(schema.orders).set({ paymentDueAt: new Date(Date.now() - 60_000) }).where(eq(schema.orders.id, first.orderId));
    expect(await expireOverdueReservations(sdb)).toEqual({ expired: 1 });
    expect((await getCouponRow(coupon.id)).usedCount).toBe(0);
    const [released] = await db.select().from(schema.couponRedemptions).where(eq(schema.couponRedemptions.orderId, first.orderId));
    expect(released.releasedAt).not.toBeNull();

    // Agora ela usa de novo.
    const third = await createStoreOrder(sdb, baseInput(variantId, rateId, { couponCode: "UMAVEZ" }));
    expect(third.totalCents).toBe(9980 - 998 + 1990);
    expect((await getCouponRow(coupon.id)).usedCount).toBe(1);
  });

  it("frete grátis: o pedido cobra frete 0, o resgate guarda o frete perdoado e expectedShippingCents é o preço da faixa", async () => {
    const { variantId, rateId } = await setupStore();
    const coupon = await makeCoupon({ code: "FRETEGRATIS", type: "free_shipping", value: 0 });

    const result = await createStoreOrder(sdb, baseInput(variantId, rateId, { couponCode: "FRETEGRATIS" }));
    expect(result.totalCents).toBe(9980);

    const [order] = await db.select().from(schema.orders).where(eq(schema.orders.id, result.orderId));
    expect(order.shippingCents).toBe(0);
    expect(order.discountCents).toBe(0);
    expect(order.couponId).toBe(coupon.id);
    expect(order.totalCents).toBe(9980);
    const [redemption] = await db.select().from(schema.couponRedemptions);
    expect(redemption).toMatchObject({ shippingDiscountCents: 1990, discountCents: 0, appliedValue: null });
  });

  it("frete grátis só para motoboy é recusado num pedido pelos Correios, sem persistir nada", async () => {
    const { variantId, rateId } = await setupStore();
    await makeCoupon({ code: "SOMOTO", type: "free_shipping", value: 0, freeShippingScope: "motoboy" });

    const error = await createStoreOrder(sdb, baseInput(variantId, rateId, { couponCode: "SOMOTO" })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceError);
    expect((error as ServiceError).code).toBe("COUPON_SHIPPING_SCOPE");
    expect(await countRows()).toEqual({ orders: 0, customers: 0, movements: 0 });
  });

  it("cupom pessoal de outra cliente: recusado pelo CPF/telefone do checkout, nada persiste", async () => {
    const { variantId, rateId } = await setupStore();
    await makeCoupon({ code: "DAJOANA", customerPhone: "+5521977776666" });

    const error = await createStoreOrder(sdb, baseInput(variantId, rateId, { couponCode: "DAJOANA" })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceError);
    expect((error as ServiceError).code).toBe("COUPON_NOT_YOURS");
    expect(await countRows()).toEqual({ orders: 0, customers: 0, movements: 0 });

    // A dona do telefone fecha normalmente (mesmo sem cadastro prévio).
    const ok = await createStoreOrder(
      sdb,
      baseInput(variantId, rateId, {
        customer: { fullName: "Joana Dona", document: VALID_CPF_2, phone: "(21) 97777-6666", marketingOptIn: false },
        couponCode: "DAJOANA",
      }),
    );
    expect(ok.totalCents).toBe(9980 - 998 + 1990);
  });

  it("restrição por peça: só a peça do cupom desconta; a outra linha segue cheia", async () => {
    const { variantId, rateId } = await setupStore();
    const outra = await createTestVariant(db, { sku: "CANECA-VERDE", costCents: 1200, onHand: 10, name: "Caneca Verde" });
    await db.insert(schema.priceVersions).values({
      productVariantId: outra.variantId,
      versionNumber: 1,
      status: "active",
      priceCents: 3000,
      origin: "initial",
      breakdown: {},
      costSnapshotCents: 1200,
      computedMarginRate: "0.3000",
      activatedAt: new Date(),
    });
    await makeCoupon({ code: "SOAZUL", type: "percent", value: 50, productRefs: ["CANECA-AZUL"] });

    const result = await createStoreOrder(
      sdb,
      baseInput(variantId, rateId, {
        items: [
          { variantId, quantity: 2, expectedUnitPriceCents: 4990 },
          { variantId: outra.variantId, quantity: 1, expectedUnitPriceCents: 3000 },
        ],
        couponCode: "SOAZUL",
      }),
    );
    // 50% só sobre 2 × 4990 = 4990; a caneca verde inteira.
    expect(result.totalCents).toBe(9980 + 3000 - 4990 + 1990);
  });

  it("cupom da turma: o 1º pedido paga 5%, o 2º (outra cliente) 7%, e o resgate guarda o valor aplicado", async () => {
    const { variantId, rateId } = await setupStore();
    await makeCoupon({ code: "TURMA", value: 5, growthPerRedeemer: 2, growthCap: 15 });

    const first = await createStoreOrder(sdb, baseInput(variantId, rateId, { couponCode: "TURMA" }));
    expect(first.totalCents).toBe(9980 - 499 + 1990);
    const second = await createStoreOrder(
      sdb,
      baseInput(variantId, rateId, {
        customer: { fullName: "José Pereira", document: VALID_CPF_2, phone: "(21) 97777-6666", marketingOptIn: false },
        couponCode: "TURMA",
      }),
    );
    expect(second.totalCents).toBe(9980 - 698 + 1990);
    const redemptions = await db.select().from(schema.couponRedemptions).orderBy(schema.couponRedemptions.createdAt);
    expect(redemptions.map((r) => r.appliedValue)).toEqual([5, 7]);
  });
});
