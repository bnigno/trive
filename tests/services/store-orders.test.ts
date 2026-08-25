import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";

import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import {
  createStoreOrder,
  expireOverdueReservations,
  getPublicOrder,
  PriceChangedError,
  RESERVATION_EXPIRED_REASON,
  ServiceError,
  ShippingChangedError,
  type CreateStoreOrderInput,
} from "@/services/store-orders";
import { createTestDb, createTestVariant, type TestDb } from "../helpers/db";

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

const VALID_CPF = "529.982.247-25"; // dígitos: 52998224725
const VALID_CPF_2 = "168.995.350-09"; // dígitos: 16899535009

async function activatePrice(
  variantId: string,
  priceCents: number,
): Promise<string> {
  const [pv] = await db
    .insert(schema.priceVersions)
    .values({
      productVariantId: variantId,
      versionNumber: 1,
      status: "active",
      priceCents,
      origin: "initial",
      breakdown: {},
      costSnapshotCents: 1000,
      computedMarginRate: "0.3000",
      activatedAt: new Date(),
    })
    .returning({ id: schema.priceVersions.id });
  return pv.id;
}

async function createRate(
  opts: Partial<typeof schema.shippingRates.$inferInsert> = {},
): Promise<{ id: string; priceCents: number }> {
  const [rate] = await db
    .insert(schema.shippingRates)
    .values({ name: "PAC", priceCents: 1990, ...opts })
    .returning({
      id: schema.shippingRates.id,
      priceCents: schema.shippingRates.priceCents,
    });
  return rate;
}

/** Vitrine pronta: variante ativa com preço, estoque e uma opção de frete. */
async function setupStore(
  opts: { onHand?: number; priceCents?: number; name?: string } = {},
) {
  const { variantId } = await createTestVariant(db, {
    sku: "CANECA-AZUL",
    costCents: 1200,
    onHand: opts.onHand ?? 10,
    name: opts.name ?? "Caneca Azul",
  });
  await activatePrice(variantId, opts.priceCents ?? 4990);
  const rate = await createRate();
  return { variantId, rate };
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
      email: "maria@example.com",
      marketingOptIn: true,
    },
    address: {
      postalCode: "01310-100",
      street: "Avenida Paulista",
      number: "1000",
      complement: "Apto 42",
      district: "Bela Vista",
      city: "São Paulo",
      state: "sp",
    },
    items: [{ variantId, quantity: 2, expectedUnitPriceCents: 4990 }],
    shippingRateId,
    expectedShippingCents: 1990,
    ...over,
  };
}

async function getLevel(variantId: string) {
  const [level] = await db
    .select()
    .from(schema.stockLevels)
    .where(eq(schema.stockLevels.productVariantId, variantId));
  return level;
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

describe("createStoreOrder", () => {
  it("fluxo feliz: cria cliente novo e pedido pending_payment com reserva e prazo ~2h", async () => {
    const { variantId, rate } = await setupStore();
    const before = Date.now();

    const result = await createStoreOrder(
      sdb,
      baseInput(variantId, rate.id),
    );

    expect(result.orderNumber).toBeGreaterThanOrEqual(1000);
    expect(result.publicToken).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.totalCents).toBe(2 * 4990 + 1990);

    // paymentDueAt ~ agora + 120 min (setting stock_reservation_ttl_minutes).
    const dueMs = result.paymentDueAt.getTime() - before;
    expect(dueMs).toBeGreaterThan(119 * 60_000);
    expect(dueMs).toBeLessThan(121 * 60_000);

    const [order] = await db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, result.orderId));
    expect(order.status).toBe("pending_payment");
    expect(order.channel).toBe("store");
    expect(order.note).toBe("Pedido da loja");
    expect(order.subtotalCents).toBe(9980);
    expect(order.shippingCents).toBe(1990);
    expect(order.paymentDueAt?.getTime()).toBe(result.paymentDueAt.getTime());
    expect(order.shippingAddress).toMatchObject({
      postalCode: "01310100",
      street: "Avenida Paulista",
      state: "SP",
    });

    // Reserva de estoque feita (draft→pending_payment).
    const level = await getLevel(variantId);
    expect(level.onHand).toBe(10);
    expect(level.reserved).toBe(2);

    // Cliente novo com documento normalizado, telefone E.164 e opt-in.
    const allCustomers = await db.select().from(schema.customers);
    expect(allCustomers).toHaveLength(1);
    expect(allCustomers[0].fullName).toBe("Maria da Silva");
    expect(allCustomers[0].documentNumber).toBe("52998224725");
    expect(allCustomers[0].documentType).toBe("cpf");
    expect(allCustomers[0].phoneE164).toBe("+5511999998888");
    expect(allCustomers[0].marketingOptIn).toBe(true);

    const addresses = await db
      .select()
      .from(schema.customerAddresses)
      .where(eq(schema.customerAddresses.customerId, allCustomers[0].id));
    expect(addresses).toHaveLength(1);
    expect(addresses[0].isDefault).toBe(true);

    // Snapshots dos itens.
    const items = await db
      .select()
      .from(schema.orderItems)
      .where(eq(schema.orderItems.orderId, result.orderId));
    expect(items).toHaveLength(1);
    expect(items[0].skuSnapshot).toBe("CANECA-AZUL");
    expect(items[0].nameSnapshot).toBe("Caneca Azul");
    expect(items[0].unitPriceCents).toBe(4990);
    expect(items[0].priceVersionId).not.toBeNull();

    // Efeito externo só via outbox, na mesma transação.
    const events = await db
      .select()
      .from(schema.outboxEvents)
      .where(eq(schema.outboxEvents.eventType, "order.store_created"));
    expect(events).toHaveLength(1);
    expect(events[0].dedupeKey).toBe(`order.store_created:${result.orderId}`);
    expect(events[0].payload).toMatchObject({
      orderId: result.orderId,
      orderNumber: result.orderNumber,
      totalCents: result.totalCents,
    });
  });

  it("comprador recorrente (mesmo CPF) não duplica cliente e nunca rebaixa opt-in", async () => {
    const { variantId, rate } = await setupStore();

    await createStoreOrder(sdb, baseInput(variantId, rate.id));

    // Mesmo CPF com outra máscara, outro telefone, nome atualizado e SEM opt-in.
    await createStoreOrder(
      sdb,
      baseInput(variantId, rate.id, {
        customer: {
          fullName: "Maria da Silva Santos",
          document: "52998224725",
          phone: "11 98888-7777",
          marketingOptIn: false,
        },
      }),
    );

    const alive = await db
      .select()
      .from(schema.customers)
      .where(isNull(schema.customers.deletedAt));
    expect(alive).toHaveLength(1);
    expect(alive[0].fullName).toBe("Maria da Silva Santos");
    // LGPD: opt-in true anterior NÃO é rebaixado por um checkout sem opt-in.
    expect(alive[0].marketingOptIn).toBe(true);

    const allOrders = await db.select().from(schema.orders);
    expect(allOrders).toHaveLength(2);
    expect(allOrders.every((o) => o.customerId === alive[0].id)).toBe(true);
  });

  it("preço divergente lança PriceChangedError com TODOS os itens e nada persiste", async () => {
    const { variantId, rate } = await setupStore();
    const { variantId: variantB } = await createTestVariant(db, {
      sku: "CANECA-VERDE",
      onHand: 10,
      name: "Caneca Verde",
    });
    await activatePrice(variantB, 5990);

    const error = await createStoreOrder(
      sdb,
      baseInput(variantId, rate.id, {
        items: [
          { variantId, quantity: 1, expectedUnitPriceCents: 4000 },
          { variantId: variantB, quantity: 1, expectedUnitPriceCents: 5000 },
        ],
      }),
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PriceChangedError);
    const changed = error as PriceChangedError;
    expect(changed.code).toBe("PRICE_CHANGED");
    expect(changed.changes).toHaveLength(2);
    expect(changed.changes).toEqual(
      expect.arrayContaining([
        {
          variantId,
          name: "Caneca Azul",
          oldPriceCents: 4000,
          newPriceCents: 4990,
        },
        {
          variantId: variantB,
          name: "Caneca Verde",
          oldPriceCents: 5000,
          newPriceCents: 5990,
        },
      ]),
    );

    expect(await countRows()).toEqual({ orders: 0, customers: 0, movements: 0 });
  });

  it("frete divergente lança ShippingChangedError com o novo valor e nada persiste", async () => {
    const { variantId, rate } = await setupStore();

    const error = await createStoreOrder(
      sdb,
      baseInput(variantId, rate.id, { expectedShippingCents: 990 }),
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ShippingChangedError);
    expect((error as ShippingChangedError).code).toBe("SHIPPING_CHANGED");
    expect((error as ShippingChangedError).newPriceCents).toBe(1990);

    expect(await countRows()).toEqual({ orders: 0, customers: 0, movements: 0 });
  });

  it("estoque insuficiente falha com mensagem amigável citando o item e nada persiste", async () => {
    const { variantId, rate } = await setupStore({ onHand: 1 });

    const error = await createStoreOrder(
      sdb,
      baseInput(variantId, rate.id),
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ServiceError);
    expect((error as ServiceError).code).toBe("OUT_OF_STOCK");
    expect((error as Error).message).toContain("esgotou");
    expect((error as Error).message).toContain("Caneca Azul");

    expect(await countRows()).toEqual({ orders: 0, customers: 0, movements: 0 });
  });

  it("documento inválido é rejeitado com 'CPF ou CNPJ inválido'", async () => {
    const { variantId, rate } = await setupStore();

    await expect(
      createStoreOrder(
        sdb,
        baseInput(variantId, rate.id, {
          customer: {
            fullName: "Maria da Silva",
            document: "111.111.111-11",
            phone: "(11) 99999-8888",
            marketingOptIn: false,
          },
        }),
      ),
    ).rejects.toThrowError(/CPF ou CNPJ inválido/);
  });
});

describe("getPublicOrder", () => {
  it("retorna apenas dados não pessoais (sem nome/telefone/documento/endereço)", async () => {
    const { variantId, rate } = await setupStore();
    const created = await createStoreOrder(sdb, baseInput(variantId, rate.id));

    const pub = await getPublicOrder(sdb, created.publicToken);
    expect(pub).not.toBeNull();

    // Whitelist EXATA de chaves — nada de PII (o token vaza em encaminhamentos).
    expect(Object.keys(pub!).sort()).toEqual(
      [
        "orderNumber",
        "status",
        "createdAt",
        "paymentDueAt",
        "trackingCode",
        "subtotalCents",
        "discountCents",
        "shippingCents",
        "totalCents",
        "items",
        "canceledReason",
      ].sort(),
    );
    expect(Object.keys(pub!.items[0]).sort()).toEqual(
      ["name", "sku", "quantity", "unitPriceCents", "totalCents"].sort(),
    );

    // Ausência explícita das chaves de PII.
    for (const key of [
      "customerId",
      "customer",
      "fullName",
      "phoneE164",
      "documentNumber",
      "email",
      "shippingAddress",
      "id",
    ]) {
      expect(pub).not.toHaveProperty(key);
    }

    // Nenhum valor pessoal serializado na resposta.
    const serialized = JSON.stringify(pub);
    expect(serialized).not.toContain("Maria");
    expect(serialized).not.toContain("52998224725");
    expect(serialized).not.toContain("5511999998888");
    expect(serialized).not.toContain("Paulista");
    expect(serialized).not.toContain("maria@example.com");

    expect(pub!.orderNumber).toBe(created.orderNumber);
    expect(pub!.status).toBe("pending_payment");
    expect(pub!.totalCents).toBe(created.totalCents);
    expect(pub!.items[0]).toEqual({
      name: "Caneca Azul",
      sku: "CANECA-AZUL",
      quantity: 2,
      unitPriceCents: 4990,
      totalCents: 9980,
    });
  });

  it("retorna null para token desconhecido ou malformado", async () => {
    expect(
      await getPublicOrder(sdb, "00000000-0000-4000-8000-00000000dead"),
    ).toBeNull();
    expect(await getPublicOrder(sdb, "nao-e-um-uuid")).toBeNull();
  });

  it("lazy expire: reserva vencida é cancelada e o estoque devolvido antes de responder", async () => {
    const { variantId, rate } = await setupStore();
    const created = await createStoreOrder(sdb, baseInput(variantId, rate.id));

    // Vence o prazo manualmente.
    await db
      .update(schema.orders)
      .set({ paymentDueAt: new Date(Date.now() - 60_000) })
      .where(eq(schema.orders.id, created.orderId));

    const pub = await getPublicOrder(sdb, created.publicToken);
    expect(pub!.status).toBe("canceled");
    expect(pub!.canceledReason).toBe(RESERVATION_EXPIRED_REASON);

    const level = await getLevel(variantId);
    expect(level.reserved).toBe(0);
    expect(level.onHand).toBe(10);

    const [order] = await db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, created.orderId));
    expect(order.status).toBe("canceled");
    expect(order.cancelReason).toBe(RESERVATION_EXPIRED_REASON);
  });
});

describe("expireOverdueReservations", () => {
  it("expira apenas os pedidos vencidos, devolvendo a reserva, com ator system", async () => {
    const { variantId, rate } = await setupStore({ onHand: 20 });

    const overdue = await createStoreOrder(sdb, baseInput(variantId, rate.id));
    const fresh = await createStoreOrder(
      sdb,
      baseInput(variantId, rate.id, {
        customer: {
          fullName: "José Pereira",
          document: VALID_CPF_2,
          phone: "(21) 97777-6666",
          marketingOptIn: false,
        },
      }),
    );

    await db
      .update(schema.orders)
      .set({ paymentDueAt: new Date(Date.now() - 60_000) })
      .where(eq(schema.orders.id, overdue.orderId));

    const result = await expireOverdueReservations(sdb, {});
    expect(result).toEqual({ expired: 1 });

    const [expired] = await db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, overdue.orderId));
    expect(expired.status).toBe("canceled");
    expect(expired.cancelReason).toBe(RESERVATION_EXPIRED_REASON);

    const [stillPending] = await db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, fresh.orderId));
    expect(stillPending.status).toBe("pending_payment");

    // Só a reserva do vencido foi devolvida (2 + 2 reservados → 2).
    const level = await getLevel(variantId);
    expect(level.reserved).toBe(2);

    // history/audit do cancelamento como SISTEMA (sem usuário).
    const [history] = await db
      .select()
      .from(schema.orderStatusHistory)
      .where(
        and(
          eq(schema.orderStatusHistory.orderId, overdue.orderId),
          eq(schema.orderStatusHistory.toStatus, "canceled"),
        ),
      );
    expect(history.changedBy).toBeNull();
    expect(history.reason).toBe(RESERVATION_EXPIRED_REASON);

    const audits = await db
      .select()
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.action, "order.transition"),
          eq(schema.auditLog.entityId, overdue.orderId),
        ),
      );
    const cancelAudit = audits.find(
      (a) => (a.after as { status?: string }).status === "canceled",
    );
    expect(cancelAudit?.actorType).toBe("system");
    expect(cancelAudit?.actorId).toBeNull();

    // Segunda passada: nada mais vencido.
    expect(await expireOverdueReservations(sdb, {})).toEqual({ expired: 0 });
  });
});
