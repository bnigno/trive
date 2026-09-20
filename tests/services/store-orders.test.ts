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
import { transitionOrder } from "@/services/orders";
import { spDayKey, spPreviousDayKey } from "@/lib/sp-day";
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
    expect(result.paymentDueAt).not.toBeNull();
    const dueMs = result.paymentDueAt!.getTime() - before;
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
    expect(order.paymentDueAt?.getTime()).toBe(result.paymentDueAt!.getTime());
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

describe("createStoreOrder — dinheiro na entrega (cash)", () => {
  async function getSaleEntries(orderId: string) {
    return db
      .select()
      .from(schema.financialEntries)
      .where(eq(schema.financialEntries.orderId, orderId));
  }

  it("cash: pending_payment com due NULL, payment_method cash e receivable sale PENDENTE", async () => {
    const { variantId, rate } = await setupStore();

    const result = await createStoreOrder(
      sdb,
      baseInput(variantId, rate.id, { paymentMethod: "cash" }),
    );

    expect(result.paymentDueAt).toBeNull();

    const [order] = await db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, result.orderId));
    expect(order.status).toBe("pending_payment");
    expect(order.paymentMethod).toBe("cash");
    expect(order.paymentDueAt).toBeNull();

    // Reserva de estoque acontece normalmente.
    const level = await getLevel(variantId);
    expect(level.reserved).toBe(2);

    // Receivable sale PENDENTE criado na MESMA transação (ator sistema).
    const entries = await getSaleEntries(result.orderId);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      direction: "receivable",
      category: "sale",
      status: "pending",
      amountCents: result.totalCents,
      createdBy: null,
    });
    expect(entries[0].settledAt).toBeNull();

    // Sem prazo, o pedido cash é NATURALMENTE isento da expiração de reserva.
    expect(await expireOverdueReservations(sdb, {})).toEqual({ expired: 0 });

    // Página pública expõe o método (bloco "Como pagar" da loja).
    const pub = await getPublicOrder(sdb, result.publicToken);
    expect(pub?.paymentMethod).toBe("cash");
    expect(pub?.paymentDueAt).toBeNull();
    expect(pub?.status).toBe("pending_payment");
  });

  it("paid liquida a MESMA entry pendente (sem duplicar receita)", async () => {
    const { variantId, rate } = await setupStore();
    const created = await createStoreOrder(
      sdb,
      baseInput(variantId, rate.id, { paymentMethod: "cash" }),
    );

    await transitionOrder(sdb, {
      orderId: created.orderId,
      to: "paid",
      userId: null,
      reason: "Dinheiro recebido na entrega",
    });

    const entries = await getSaleEntries(created.orderId);
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe("settled");
    expect(entries[0].settledAt).not.toBeNull();
    expect(entries[0].amountCents).toBe(created.totalCents);
  });

  it("dono liquidou a entry ANTES no financeiro: paid não duplica nem falha", async () => {
    const { variantId, rate } = await setupStore();
    const created = await createStoreOrder(
      sdb,
      baseInput(variantId, rate.id, { paymentMethod: "cash" }),
    );

    // Dono marca como recebida direto no financeiro antes de mudar o status.
    const settledAt = new Date();
    await db
      .update(schema.financialEntries)
      .set({ status: "settled", settledAt })
      .where(eq(schema.financialEntries.orderId, created.orderId));

    await transitionOrder(sdb, {
      orderId: created.orderId,
      to: "paid",
      userId: null,
    });

    const entries = await getSaleEntries(created.orderId);
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe("settled");
    // settledAt original preservado (no-op de verdade, não re-liquidação).
    expect(entries[0].settledAt?.getTime()).toBe(settledAt.getTime());
  });

  it("cancelamento de pedido cash cancela a entry pendente (carteira não infla)", async () => {
    const { variantId, rate } = await setupStore();
    const created = await createStoreOrder(
      sdb,
      baseInput(variantId, rate.id, { paymentMethod: "cash" }),
    );

    await transitionOrder(sdb, {
      orderId: created.orderId,
      to: "canceled",
      userId: null,
      reason: "Cliente desistiu",
    });

    const entries = await getSaleEntries(created.orderId);
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe("canceled");

    // Reserva devolvida normalmente.
    const level = await getLevel(variantId);
    expect(level.reserved).toBe(0);
    expect(level.onHand).toBe(10);
  });
});

describe("createStoreOrder — motoboy com janela", () => {
  const WINDOWS = [
    { start: "16:00", end: "19:00", cutoff: "13:00" },
    { start: "19:00", end: "21:00", cutoff: "13:00" },
  ];
  const MORNING = new Date("2026-09-18T13:30:00Z"); // 10:30 SP, sexta 18/09
  const CHOICE = { dayKey: "2026-09-18", start: "19:00", end: "21:00", cutoff: "13:00" };

  async function setupMotoboy() {
    const { variantId } = await createTestVariant(db, { sku: "CANECA-AZUL", costCents: 1200, onHand: 10, name: "Caneca Azul" });
    await activatePrice(variantId, 4990);
    const rate = await createRate({ name: "Motoboy Belém", priceCents: 1500, kind: "motoboy", deliveryWindows: WINDOWS, deliveryDaysMin: 0, deliveryDaysMax: 0 });
    return { variantId, rate };
  }

  it("onde o motoboy chega, o servidor recusa fechar pelos Correios (aba antiga do checkout ou POST montado à mão)", async () => {
    const { variantId } = await setupMotoboy();
    const pac = await createRate({ name: "PAC Norte", priceCents: 1990, cepStart: "00000000", cepEnd: "99999999" });
    await expect(
      createStoreOrder(sdb, baseInput(variantId, pac.id, { expectedShippingCents: 1990 }), { now: MORNING }),
    ).rejects.toMatchObject({ code: "SHIPPING_MOTOBOY_ONLY" });
    // Fora da faixa do motoboy, o PAC segue valendo.
    await db.update(schema.shippingRates).set({ cepStart: "66000000", cepEnd: "66999999" }).where(eq(schema.shippingRates.name, "Motoboy Belém"));
    const result = await createStoreOrder(sdb, baseInput(variantId, pac.id, { expectedShippingCents: 1990 }), { now: MORNING });
    expect(result.orderId).toBeDefined();
  });

  it("guarda o retrato da janela no pedido e mostra o rótulo datado na página pública", async () => {
    const { variantId, rate } = await setupMotoboy();
    const result = await createStoreOrder(
      sdb,
      baseInput(variantId, rate.id, { expectedShippingCents: 1500, deliveryWindow: CHOICE }),
      { now: MORNING },
    );

    const [order] = await db.select().from(schema.orders).where(eq(schema.orders.id, result.orderId));
    expect(order.deliveryWindow).toEqual({ ...CHOICE, rateName: "Motoboy Belém", label: "sexta 18/09, 19h–21h" });
    expect(order.shippingCents).toBe(1500);

    const pub = await getPublicOrder(sdb, result.publicToken);
    expect(pub?.deliveryWindowLabel).toBe("Motoboy Belém — sexta 18/09, 19h–21h");
  });

  it("sem janela, ou janela que não existe na faixa: DELIVERY_WINDOW_REQUIRED (nada é gravado)", async () => {
    const { variantId, rate } = await setupMotoboy();
    const before = await countRows();

    await expect(
      createStoreOrder(sdb, baseInput(variantId, rate.id, { expectedShippingCents: 1500 }), { now: MORNING }),
    ).rejects.toMatchObject({ code: "DELIVERY_WINDOW_REQUIRED" });
    await expect(
      createStoreOrder(
        sdb,
        baseInput(variantId, rate.id, { expectedShippingCents: 1500, deliveryWindow: { ...CHOICE, start: "20:00" } }),
        { now: MORNING },
      ),
    ).rejects.toMatchObject({ code: "DELIVERY_WINDOW_REQUIRED" });

    expect(await countRows()).toEqual(before);
    expect((await getLevel(variantId)).reserved).toBe(0);
  });

  it("janela de hoje depois da hora-limite (ou de ontem): DELIVERY_WINDOW_EXPIRED; amanhã vale a qualquer hora", async () => {
    const { variantId, rate } = await setupMotoboy();
    const afternoon = new Date("2026-09-18T16:00:00Z"); // 13:00 SP em ponto: o limite já passou

    await expect(
      createStoreOrder(sdb, baseInput(variantId, rate.id, { expectedShippingCents: 1500, deliveryWindow: CHOICE }), { now: afternoon }),
    ).rejects.toMatchObject({ code: "DELIVERY_WINDOW_EXPIRED" });
    await expect(
      createStoreOrder(
        sdb,
        baseInput(variantId, rate.id, { expectedShippingCents: 1500, deliveryWindow: { ...CHOICE, dayKey: "2026-09-17" } }),
        { now: afternoon },
      ),
    ).rejects.toMatchObject({ code: "DELIVERY_WINDOW_EXPIRED" });

    // Depois de amanhã (ou um ano à frente) a sacola nunca oferece: recusa.
    await expect(
      createStoreOrder(
        sdb,
        baseInput(variantId, rate.id, { expectedShippingCents: 1500, deliveryWindow: { ...CHOICE, dayKey: "2026-09-20" } }),
        { now: afternoon },
      ),
    ).rejects.toMatchObject({ code: "DELIVERY_WINDOW_EXPIRED" });
    // `now` no payload do navegador não é relógio: o Zod descarta e vale o do
    // servidor. Janela de ONTEM com um "now" forjado de ontem de manhã: se o
    // forjado valesse, o pedido passaria.
    const yesterday = spPreviousDayKey(spDayKey(new Date()));
    await expect(
      createStoreOrder(sdb, {
        ...baseInput(variantId, rate.id, { expectedShippingCents: 1500, deliveryWindow: { ...CHOICE, dayKey: yesterday } }),
        now: new Date(`${yesterday}T10:00:00-03:00`),
      } as CreateStoreOrderInput),
    ).rejects.toMatchObject({ code: "DELIVERY_WINDOW_EXPIRED" });

    // Meia-noite UTC (21h em SP): "amanhã" em SP continua sendo 19/09.
    const lateUtc = new Date("2026-09-19T00:00:00Z");
    const result = await createStoreOrder(
      sdb,
      baseInput(variantId, rate.id, { expectedShippingCents: 1500, deliveryWindow: { ...CHOICE, dayKey: "2026-09-19" } }),
      { now: lateUtc },
    );
    const [order] = await db.select().from(schema.orders).where(eq(schema.orders.id, result.orderId));
    expect(order.deliveryWindow?.label).toBe("sábado 19/09, 19h–21h");
  });

  it("faixa Correios ignora a janela mandada por engano", async () => {
    const { variantId, rate } = await setupStore();
    const result = await createStoreOrder(sdb, baseInput(variantId, rate.id, { deliveryWindow: CHOICE }), { now: MORNING });
    const [order] = await db.select().from(schema.orders).where(eq(schema.orders.id, result.orderId));
    expect(order.deliveryWindow).toBeNull();
    expect((await getPublicOrder(sdb, result.publicToken))?.deliveryWindowLabel).toBeNull();
  });
});

describe("createStoreOrder — cotação automática dos Correios (shipping_quotes)", () => {
  const NOW = new Date("2026-09-19T15:00:00Z"); // 12:00 SP, sábado 19/09
  const DAY = 24 * 3600_000;

  async function setupQuoted(opts: { weightGrams?: number | null } = {}) {
    // Uma cotação só fecha pedido com o Correios automático ligado (a linha nasceu dele).
    await db.insert(schema.settings).values({ key: "correios_auto_enabled", value: true });
    const { variantId } = await createTestVariant(db, { sku: "CANECA-AZUL", costCents: 1200, onHand: 10, name: "Caneca Azul" });
    await activatePrice(variantId, 4990);
    if (opts.weightGrams !== undefined) {
      await db.update(schema.productVariants).set({ weightGrams: opts.weightGrams }).where(eq(schema.productVariants.id, variantId));
    }
    return { variantId };
  }

  async function insertQuote(over: Partial<typeof schema.shippingQuotes.$inferInsert> = {}): Promise<string> {
    const [row] = await db
      .insert(schema.shippingQuotes)
      .values({
        requestKey: "superfrete|66045335|01310100|600|4x16x24|s300|PAC,SEDEX",
        batchId: "00000000-0000-4000-8000-0000000000aa",
        serviceCode: "1",
        name: "PAC",
        cepFrom: "66045335",
        cepTo: "01310100",
        weightGrams: 600,
        package: { heightCm: 4, widthCm: 16, lengthCm: 24 },
        providerPriceCents: 2290,
        surchargeCents: 300,
        priceCents: 2590,
        deliveryDaysMin: 6,
        deliveryDaysMax: 9,
        createdAt: NOW,
        expiresAt: new Date(NOW.getTime() + DAY),
        ...over,
      })
      .returning({ id: schema.shippingQuotes.id });
    return row.id;
  }

  it("fecha com a cotação: frete = price_cents (com embalagem), shipping_service e shipping_quote_id gravados, sem janela; ship_by pelo prazo máximo", async () => {
    const { variantId } = await setupQuoted(); // 2 × 300 g (padrão) = 600 g
    const quoteId = await insertQuote();
    const result = await createStoreOrder(sdb, baseInput(variantId, quoteId, { expectedShippingCents: 2590, neededBy: "2026-10-15" }), { now: NOW });

    const [order] = await db.select().from(schema.orders).where(eq(schema.orders.id, result.orderId));
    expect(order.shippingCents).toBe(2590);
    expect(order.totalCents).toBe(2 * 4990 + 2590);
    expect(order.shippingService).toBe("PAC");
    expect(order.shippingQuoteId).toBe(quoteId);
    expect(order.deliveryWindow).toBeNull();
    // 9 dias úteis antes de 15/10 (quinta), pulando o feriado de 12/10: 01/10.
    expect(order.shipBy).toBe("2026-10-01");

    const pub = await getPublicOrder(sdb, result.publicToken);
    expect(pub?.shippingServiceLabel).toBe("PAC");
    expect(pub?.deliveryWindowLabel).toBeNull();
  });

  it("id que não é faixa nem cotação: SHIPPING_RATE_UNAVAILABLE; vencida, de outro CEP ou de outro peso: SHIPPING_QUOTE_STALE — nada gravado", async () => {
    const { variantId } = await setupQuoted();
    const stale = { code: "SHIPPING_QUOTE_STALE" };
    await expect(
      createStoreOrder(sdb, baseInput(variantId, "00000000-0000-4000-8000-0000000000ff", { expectedShippingCents: 2590 }), { now: NOW }),
    ).rejects.toMatchObject({ code: "SHIPPING_RATE_UNAVAILABLE" });

    const expired = await insertQuote({ expiresAt: NOW });
    await expect(createStoreOrder(sdb, baseInput(variantId, expired, { expectedShippingCents: 2590 }), { now: NOW })).rejects.toMatchObject(stale);

    const otherCep = await insertQuote({ cepTo: "01310101" });
    await expect(createStoreOrder(sdb, baseInput(variantId, otherCep, { expectedShippingCents: 2590 }), { now: NOW })).rejects.toMatchObject(stale);

    // Cotada para 300 g, mas a sacola tem 2 × 300 g.
    const lighter = await insertQuote({ weightGrams: 300 });
    await expect(createStoreOrder(sdb, baseInput(variantId, lighter, { expectedShippingCents: 2590 }), { now: NOW })).rejects.toMatchObject(stale);

    expect(await db.$count(schema.orders)).toBe(0);
  });

  it("peso do fechamento segue a regra da vitrine: variante sem peso conta 300 g; 1 peça de 100 g cobra o mínimo de 300 g", async () => {
    const { variantId } = await setupQuoted({ weightGrams: 100 });
    const minimum = await insertQuote({ weightGrams: 300 });
    const result = await createStoreOrder(
      sdb,
      baseInput(variantId, minimum, { expectedShippingCents: 2590, items: [{ variantId, quantity: 1, expectedUnitPriceCents: 4990 }] }),
      { now: NOW },
    );
    expect(result.orderId).toBeDefined();

    // Sem peso cadastrado (null): 2 × 300 g = 600 g, a cotação de 600 g serve.
    await db.update(schema.productVariants).set({ weightGrams: null }).where(eq(schema.productVariants.id, variantId));
    const quote600 = await insertQuote();
    const second = await createStoreOrder(
      sdb,
      baseInput(variantId, quote600, { expectedShippingCents: 2590, customer: { fullName: "Ana", document: VALID_CPF_2, phone: "(11) 98888-7777", marketingOptIn: false } }),
      { now: NOW },
    );
    expect(second.orderId).toBeDefined();
  });

  it("onde um motoboy ativo cobre o CEP a cotação não fecha (SHIPPING_MOTOBOY_ONLY); frete diferente do visto → ShippingChangedError com o valor da cotação", async () => {
    const { variantId } = await setupQuoted();
    const quoteId = await insertQuote();
    await createRate({ name: "Motoboy SP", priceCents: 1500, kind: "motoboy", cepStart: "01000000", cepEnd: "01999999", deliveryWindows: [{ start: "19:00", end: "21:00", cutoff: "13:00" }] });
    await expect(createStoreOrder(sdb, baseInput(variantId, quoteId, { expectedShippingCents: 2590 }), { now: NOW })).rejects.toMatchObject({ code: "SHIPPING_MOTOBOY_ONLY" });

    await db.update(schema.shippingRates).set({ isActive: false });
    await expect(createStoreOrder(sdb, baseInput(variantId, quoteId, { expectedShippingCents: 2290 }), { now: NOW })).rejects.toMatchObject({
      code: "SHIPPING_CHANGED",
      newPriceCents: 2590,
    });
    expect(await db.$count(schema.orders)).toBe(0);
  });

  it("toggle do Correios automático desligado: nem um id já emitido fecha (SHIPPING_RATE_UNAVAILABLE — o checkout recota)", async () => {
    const { variantId } = await setupQuoted();
    const quoteId = await insertQuote();
    await db.update(schema.settings).set({ value: false }).where(eq(schema.settings.key, "correios_auto_enabled"));
    await expect(createStoreOrder(sdb, baseInput(variantId, quoteId, { expectedShippingCents: 2590 }), { now: NOW })).rejects.toMatchObject({ code: "SHIPPING_RATE_UNAVAILABLE" });
    await db.update(schema.settings).set({ value: true }).where(eq(schema.settings.key, "correios_auto_enabled"));
    expect((await createStoreOrder(sdb, baseInput(variantId, quoteId, { expectedShippingCents: 2590 }), { now: NOW })).orderId).toBeDefined();
  });

  it("faixa manual de Correios grava o nome da faixa em shipping_service; motoboy grava null; cotação apagada deixa o pedido (FK set null)", async () => {
    const { variantId } = await setupQuoted();
    const pac = await createRate({ name: "PAC Brasil", priceCents: 1990 });
    const manual = await createStoreOrder(sdb, baseInput(variantId, pac.id, { expectedShippingCents: 1990 }), { now: NOW });
    const [manualOrder] = await db.select().from(schema.orders).where(eq(schema.orders.id, manual.orderId));
    expect(manualOrder.shippingService).toBe("PAC Brasil");
    expect(manualOrder.shippingQuoteId).toBeNull();

    await db.update(schema.shippingRates).set({ isActive: false });
    const quoteId = await insertQuote();
    const quoted = await createStoreOrder(
      sdb,
      baseInput(variantId, quoteId, { expectedShippingCents: 2590, customer: { fullName: "Ana", document: VALID_CPF_2, phone: "(11) 98888-7777", marketingOptIn: false } }),
      { now: NOW },
    );
    await db.delete(schema.shippingQuotes).where(eq(schema.shippingQuotes.id, quoteId));
    const [quotedOrder] = await db.select().from(schema.orders).where(eq(schema.orders.id, quoted.orderId));
    expect(quotedOrder.shippingQuoteId).toBeNull();
    expect(quotedOrder.shippingService).toBe("PAC");
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
        "paymentMethod",
        "trackingCode",
        "subtotalCents",
        "discountCents",
        "shippingCents",
        "totalCents",
        "items",
        "canceledReason",
        "paidAt",
        "preparingAt",
        "packedAt",
        "shippedAt",
        "deliveredAt",
        "deliveredPhotoPath",
        "deliveredPhotoAt",
        "receivedBy",
        "packagePhotoPath",
        "isGift",
        "giftRecipientName",
        "giftNotePath",
        "deliveryWindowLabel",
        "shippingServiceLabel",
        "neededByLabel",
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

describe("presente com bilhete", () => {
  it("grava para quem é, o bilhete limpo e a data; enfileira order.gift_note uma vez", async () => {
    const { variantId, rate } = await setupStore();
    const created = await createStoreOrder(
      sdb,
      baseInput(variantId, rate.id, {
        gift: {
          recipientName: " Ana Clara ✨ ",
          message: "Para iluminar  o seu\n\n\nsetembro 🤎",
          deliverBy: "2026-10-05",
        },
      }),
    );
    const [order] = await db.select().from(schema.orders).where(eq(schema.orders.id, created.orderId));
    expect(order.isGift).toBe(true);
    expect(order.giftRecipientName).toBe("Ana Clara");
    expect(order.giftMessage).toBe("Para iluminar o seu\n\nsetembro");
    expect(order.giftDeliverBy).toBe("2026-10-05");
    expect(order.giftNotePath).toBeNull();

    const events = await db.select().from(schema.outboxEvents);
    expect(events.filter((event) => event.eventType === "order.gift_note")).toHaveLength(1);
    expect(events.find((event) => event.eventType === "order.gift_note")).toMatchObject({
      dedupeKey: `order.gift_note:${created.orderId}`,
      payload: { orderId: created.orderId },
    });

    const pub = await getPublicOrder(sdb, created.publicToken);
    expect(pub).toMatchObject({ isGift: true, giftRecipientName: "Ana Clara", giftNotePath: null });

    const [audit] = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "order.store_create"));
    expect(audit.after).toMatchObject({ gift: { recipientName: "Ana Clara", hasMessage: true, deliverBy: "2026-10-05" } });
  });

  it("bilhete só de emoji vira sem bilhete; sem presente nada muda", async () => {
    const { variantId, rate } = await setupStore();
    const withEmptyNote = await createStoreOrder(
      sdb,
      baseInput(variantId, rate.id, { gift: { recipientName: "Bia", message: "🤎🤎" } }),
    );
    const [order] = await db.select().from(schema.orders).where(eq(schema.orders.id, withEmptyNote.orderId));
    expect(order.giftMessage).toBeNull();

    await db.delete(schema.outboxEvents);
    const plain = await createStoreOrder(sdb, baseInput(variantId, rate.id));
    const [plainOrder] = await db.select().from(schema.orders).where(eq(schema.orders.id, plain.orderId));
    expect(plainOrder.isGift).toBe(false);
    expect(plainOrder.giftRecipientName).toBeNull();
    const events = await db.select().from(schema.outboxEvents);
    expect(events.map((event) => event.eventType)).not.toContain("order.gift_note");
  });

  it("bilhete acima de 280 caracteres é recusado", async () => {
    const { variantId, rate } = await setupStore();
    await expect(
      createStoreOrder(
        sdb,
        baseInput(variantId, rate.id, { gift: { recipientName: "Bia", message: "x".repeat(281) } }),
      ),
    ).rejects.toThrow(/280/);
  });
});
