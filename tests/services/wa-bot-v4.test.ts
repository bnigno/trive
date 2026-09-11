// Vendedora v4 (Onda 5, Marco 1): historico_de_compras e validar_cupom pelo
// executor, a linha "Compras anteriores" do caderninho e o cupom validado
// aplicado por criar_pedido quando o campo vem ausente.
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as schema from "@/db/schema";
import { formatCentsBRL } from "@/lib/money";
import type { DbOrTx } from "@/queue/enqueue";
import { createCoupon } from "@/services/coupons";
import { transitionOrder } from "@/services/orders";
import { createStoreOrder, type CreateStoreOrderInput } from "@/services/store-orders";
import { loadPurchaseHistory, purchaseMemoryLineFor } from "@/services/bot/orders";
import { buildToolExecutor } from "@/services/wa-bot";
import { createTestDb, createTestVariant, FIXED_USER_ID, type TestDb } from "../helpers/db";

let db: TestDb;
let sdb: DbOrTx;
let close: () => Promise<void>;

const PHONE = "+5511999998888";
const OTHER_PHONE = "+5521977776666";
const VALID_CPF = "52998224725";
const CONVERSATION_ID = "00000000-0000-4000-8000-00000000c0de";
const INBOUND_ID = "00000000-0000-4000-8000-00000000feed";

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  sdb = db as unknown as DbOrTx;
  vi.stubEnv("ADAPTER_MODE", "fake");
  await db.insert(schema.waConversations).values({ id: CONVERSATION_ID, phoneE164: PHONE, status: "open" });
});

afterEach(async () => {
  await close();
  vi.unstubAllEnvs();
});

async function activatePrice(variantId: string, priceCents: number): Promise<void> {
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
}

/** Peça com grade (cor/tamanho), preço ativo, estoque e uma opção de frete. */
async function setupStore(): Promise<{ variantId: string; rateId: string }> {
  const { productId, variantId } = await createTestVariant(db, {
    sku: "DUNAS-AREIA-M",
    name: "Longo Dunas",
    onHand: 5,
  });
  await db
    .update(schema.productVariants)
    .set({ attributes: { cor: "Areia", tamanho: "M" } })
    .where(eq(schema.productVariants.id, variantId));
  await db
    .update(schema.products)
    .set({ attributesSchema: ["cor", "tamanho"] })
    .where(eq(schema.products.id, productId));
  await activatePrice(variantId, 8990);
  const [rate] = await db
    .insert(schema.shippingRates)
    .values({ name: "PAC", priceCents: 1990 })
    .returning({ id: schema.shippingRates.id });
  return { variantId, rateId: rate.id };
}

function orderInput(variantId: string, rateId: string, over: Partial<CreateStoreOrderInput> = {}): CreateStoreOrderInput {
  return {
    customer: { fullName: "Maria da Silva", document: VALID_CPF, phone: PHONE, marketingOptIn: true },
    address: {
      postalCode: "01310100",
      street: "Avenida Paulista",
      number: "1000",
      district: "Bela Vista",
      city: "São Paulo",
      state: "SP",
    },
    items: [{ variantId, quantity: 1, expectedUnitPriceCents: 8990 }],
    shippingRateId: rateId,
    expectedShippingCents: 1990,
    ...over,
  };
}

function executor(dryRun = false) {
  return buildToolExecutor(sdb, {
    conversationId: CONVERSATION_ID,
    phoneE164: PHONE,
    customerId: null,
    lastInboundId: INBOUND_ID,
    ...(dryRun ? { dryRun: true } : {}),
  });
}

async function botState() {
  const [row] = await db
    .select({ botState: schema.waConversations.botState })
    .from(schema.waConversations)
    .where(eq(schema.waConversations.id, CONVERSATION_ID));
  return (row.botState ?? {}) as Record<string, unknown>;
}

describe("historico_de_compras", () => {
  it("sem cliente neste telefone: primeira compra, ok:true, sem negar o cadastro", async () => {
    const result = await executor()("historico_de_compras", {});
    expect(result.ok).toBe(true);
    expect(result.text).toContain("primeira compra dela por aqui");
  });

  it("lista os pedidos do telefone da conversa (com cor e tamanho), nunca de outro telefone", async () => {
    const { variantId, rateId } = await setupStore();
    const paid = await createStoreOrder(sdb, orderInput(variantId, rateId));
    await transitionOrder(sdb, { orderId: paid.orderId, to: "paid", userId: FIXED_USER_ID });
    const pending = await createStoreOrder(sdb, orderInput(variantId, rateId));
    // Outra cliente, outro telefone: invisível nesta conversa.
    await createStoreOrder(
      sdb,
      orderInput(variantId, rateId, {
        customer: { fullName: "Outra Pessoa", document: "16899535009", phone: OTHER_PHONE, marketingOptIn: false },
      }),
    );

    const result = await executor()("historico_de_compras", {});
    expect(result.ok).toBe(true);
    expect(result.text).toContain("Pedidos desta cliente (os 2 mais recentes");
    expect(result.text).toContain(`#${pending.orderNumber} — `);
    expect(result.text).toContain(`— aguardando pagamento — ${formatCentsBRL(8990 + 1990)}: 1× Longo Dunas (Areia · M)`);
    expect(result.text).toContain(`#${paid.orderNumber} — `);
    expect(result.text).toContain("— pagamento aprovado —");
    expect(result.text).not.toContain("Outra Pessoa");
    // Do mais novo ao mais antigo.
    expect(result.text.indexOf(`#${pending.orderNumber}`)).toBeLessThan(result.text.indexOf(`#${paid.orderNumber}`));

    // Só lê: vale no ensaio também.
    expect((await executor(true)("historico_de_compras", {})).text).toContain("Pedidos desta cliente");
  });

  it("caderninho: 'Compras anteriores' só com compra paga; pendente ou cancelada não conta", async () => {
    const { variantId, rateId } = await setupStore();
    const ctx = { customerId: null, phoneE164: PHONE };
    expect(await purchaseMemoryLineFor(sdb, ctx)).toBeNull();

    const pending = await createStoreOrder(sdb, orderInput(variantId, rateId));
    expect(await purchaseMemoryLineFor(sdb, ctx)).toBeNull();

    await transitionOrder(sdb, { orderId: pending.orderId, to: "paid", userId: FIXED_USER_ID });
    expect(await purchaseMemoryLineFor(sdb, ctx)).toBe(
      `Compras anteriores: 1 compra — última #${pending.orderNumber} (${new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date())}): 1× Longo Dunas (Areia · M)`,
    );

    const canceled = await createStoreOrder(sdb, orderInput(variantId, rateId));
    await transitionOrder(sdb, { orderId: canceled.orderId, to: "canceled", userId: FIXED_USER_ID, reason: "teste" });
    const line = await purchaseMemoryLineFor(sdb, ctx);
    expect(line).toContain("1 compra");
    expect(line).toContain(`#${pending.orderNumber}`);

    // loadPurchaseHistory com onlyPurchased ignora o cancelado; sem filtro traz os dois.
    const [customer] = await db.select({ id: schema.customers.id }).from(schema.customers).where(eq(schema.customers.phoneE164, PHONE));
    expect((await loadPurchaseHistory(sdb, customer.id, { limit: 5, onlyPurchased: true })).map((o) => o.orderNumber)).toEqual([pending.orderNumber]);
    expect((await loadPurchaseHistory(sdb, customer.id, { limit: 5 })).map((o) => o.orderNumber)).toEqual([canceled.orderNumber, pending.orderNumber]);
  });
});

describe("validar_cupom", () => {
  it("sacola vazia: recusa e manda montar a sacola antes", async () => {
    await createCoupon(sdb, { code: "DEZ10", type: "percent", value: 10, userId: FIXED_USER_ID });
    const result = await executor()("validar_cupom", { cupom: "DEZ10" });
    expect(result.ok).toBe(false);
    expect(result.text).toContain("A sacola está vazia");
  });

  it("cupom válido: desconto real sobre a sacola, vai para o caderninho e criar_pedido aplica quando o campo vem ausente", async () => {
    await setupStore();
    await createCoupon(sdb, { code: "DEZ10", type: "percent", value: 10, userId: FIXED_USER_ID });
    const execute = executor();
    expect((await execute("adicionar_a_sacola", { sku: "DUNAS-AREIA-M", quantidade: 2 })).ok).toBe(true);

    const result = await execute("validar_cupom", { cupom: " dez10 " });
    expect(result.ok).toBe(true);
    expect(result.text).toContain(
      `Cupom DEZ10 válido: desconto de ${formatCentsBRL(1798)} sobre o subtotal de ${formatCentsBRL(17980)} das peças → ${formatCentsBRL(16182)}`,
    );
    expect(result.text).toContain('Passe cupom: "DEZ10" em criar_pedido');
    expect((await botState()).coupon).toMatchObject({ code: "DEZ10", discountCents: 1798 });
    // Cotação não consome o cupom.
    const [coupon] = await db.select().from(schema.coupons);
    expect(coupon.usedCount).toBe(0);

    // Fechamento sem o campo cupom: o validado entra; o pedido nasce com o desconto.
    expect((await execute("cotar_frete", { cep: "01310100" })).ok).toBe(true);
    const created = await execute("criar_pedido", {
      nome_completo: "Maria da Silva",
      cpf: VALID_CPF,
      cep: "01310100",
      rua: "Avenida Paulista",
      numero: "1000",
      bairro: "Bela Vista",
      cidade: "São Paulo",
      uf: "SP",
    });
    expect(created.ok).toBe(true);
    const [order] = await db.select().from(schema.orders);
    expect(order.couponCode).toBe("DEZ10");
    expect(order.discountCents).toBe(1798);
    expect(order.totalCents).toBe(17980 - 1798 + 1990);
    expect((await db.select().from(schema.coupons))[0].usedCount).toBe(1);
    // O caderninho esquece o cupom junto com a sacola.
    const state = await botState();
    expect(state.coupon).toBeUndefined();
    expect(state.cart).toEqual([]);
  });

  it("cupom vazio em criar_pedido é 'sem cupom' mesmo com um validado; cupom no campo vence o do caderninho", async () => {
    await setupStore();
    await createCoupon(sdb, { code: "DEZ10", type: "percent", value: 10, userId: FIXED_USER_ID });
    await createCoupon(sdb, { code: "CINCO", type: "fixed", value: 500, userId: FIXED_USER_ID });
    const execute = executor();
    await execute("adicionar_a_sacola", { sku: "DUNAS-AREIA-M", quantidade: 1 });
    expect((await execute("validar_cupom", { cupom: "DEZ10" })).ok).toBe(true);
    await execute("cotar_frete", { cep: "01310100" });
    const dados = {
      nome_completo: "Maria da Silva",
      cpf: VALID_CPF,
      cep: "01310100",
      rua: "Avenida Paulista",
      numero: "1000",
      bairro: "Bela Vista",
      cidade: "São Paulo",
      uf: "SP",
    };
    expect((await execute("criar_pedido", { ...dados, cupom: "CINCO" })).ok).toBe(true);
    const [first] = await db.select().from(schema.orders);
    expect(first.couponCode).toBe("CINCO");
    expect(first.discountCents).toBe(500);

    await execute("adicionar_a_sacola", { sku: "DUNAS-AREIA-M", quantidade: 1 });
    expect((await execute("validar_cupom", { cupom: "DEZ10" })).ok).toBe(true);
    await execute("cotar_frete", { cep: "01310100" });
    expect((await execute("criar_pedido", { ...dados, usar_cadastro_salvo: true, cupom: "" })).ok).toBe(true);
    const orders = await db.select().from(schema.orders).orderBy(schema.orders.orderNumber);
    expect(orders[1].couponCode).toBeNull();
    expect(orders[1].discountCents).toBe(0);
  });

  it("cupom inexistente, vencido ou abaixo do mínimo: ok:false com o motivo do serviço, nada no caderninho", async () => {
    await setupStore();
    await createCoupon(sdb, { code: "VELHO", type: "percent", value: 10, userId: FIXED_USER_ID, expiresAt: new Date(Date.now() - 60_000) });
    await createCoupon(sdb, { code: "GRANDE", type: "fixed", value: 1000, minOrderCents: 50_000, userId: FIXED_USER_ID });
    const execute = executor();
    await execute("adicionar_a_sacola", { sku: "DUNAS-AREIA-M", quantidade: 1 });

    const nada = await execute("validar_cupom", { cupom: "NADA" });
    expect(nada.ok).toBe(false);
    expect(nada.text).toContain('O cupom NADA não vale para esta sacola: Cupom "NADA" não existe.');
    expect(nada.text).toContain("nunca invente outro");

    const velho = await execute("validar_cupom", { cupom: "velho" });
    expect(velho.ok).toBe(false);
    expect(velho.text).toContain("Este cupom expirou.");

    const grande = await execute("validar_cupom", { cupom: "GRANDE" });
    expect(grande.ok).toBe(false);
    expect(grande.text).toContain(`a partir de ${formatCentsBRL(50_000)}`);

    expect((await botState()).coupon).toBeUndefined();
  });

  it("no ensaio (dryRun) valida mas não grava o caderninho", async () => {
    await setupStore();
    await createCoupon(sdb, { code: "DEZ10", type: "percent", value: 10, userId: FIXED_USER_ID });
    const execute = executor(true);
    await execute("adicionar_a_sacola", { sku: "DUNAS-AREIA-M", quantidade: 1 });
    // No ensaio a sacola também não é gravada: o executor lê o estado vazio.
    const result = await execute("validar_cupom", { cupom: "DEZ10" });
    expect(result.ok).toBe(false);
    expect(result.text).toContain("A sacola está vazia");
    expect((await botState()).coupon).toBeUndefined();
  });
});
