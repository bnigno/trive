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
import { formatPurchaseDate, NO_PURCHASES_TEXT } from "@/core/bot/purchases";
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
    onHand: 20,
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
    const other = await createStoreOrder(
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
    expect(result.text).not.toContain(`#${other.orderNumber} `);
    expect(result.text.match(/^• #/gm)).toHaveLength(2);
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
    const [paidRow] = await db.select({ createdAt: schema.orders.createdAt }).from(schema.orders).where(eq(schema.orders.id, pending.orderId));
    expect(await purchaseMemoryLineFor(sdb, ctx)).toBe(
      `Compras anteriores: 1 compra — última #${pending.orderNumber} (${formatPurchaseDate(paidRow.createdAt)}): 1× Longo Dunas (Areia · M)`,
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

describe("historico_de_compras — limites e LGPD", () => {
  it("lista no máximo 5 pedidos (os mais novos) e ignora rascunho", async () => {
    const { variantId, rateId } = await setupStore();
    const numbers: number[] = [];
    for (let i = 0; i < 6; i += 1) numbers.push((await createStoreOrder(sdb, orderInput(variantId, rateId))).orderNumber);
    const result = await executor()("historico_de_compras", {});
    expect(result.text).toContain("os 5 mais recentes");
    expect(result.text.match(/^• #/gm)).toHaveLength(5);
    expect(result.text).not.toContain(`#${numbers[0]} `);
    expect(result.text).toContain(`#${numbers[5]} `);
  });

  it("cliente anonimizada (LGPD) ou apagada não volta: nem pelo vínculo da conversa, nem pelo telefone", async () => {
    const { variantId, rateId } = await setupStore();
    const paid = await createStoreOrder(sdb, orderInput(variantId, rateId));
    await transitionOrder(sdb, { orderId: paid.orderId, to: "paid", userId: FIXED_USER_ID });
    const [customer] = await db.select({ id: schema.customers.id }).from(schema.customers).where(eq(schema.customers.phoneE164, PHONE));
    const linked = buildToolExecutor(sdb, { conversationId: CONVERSATION_ID, phoneE164: PHONE, customerId: customer.id, lastInboundId: INBOUND_ID });
    expect((await linked("historico_de_compras", {})).text).toContain(`#${paid.orderNumber} `);

    await db.update(schema.customers).set({ anonymizedAt: new Date() }).where(eq(schema.customers.id, customer.id));
    expect((await linked("historico_de_compras", {})).text).toBe(NO_PURCHASES_TEXT);
    expect((await executor()("historico_de_compras", {})).text).toBe(NO_PURCHASES_TEXT);
    expect(await purchaseMemoryLineFor(sdb, { customerId: customer.id, phoneE164: PHONE })).toBeNull();
    expect((await linked("status_do_pedido", {})).ok).toBe(false);
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

  it("cupom que muda com o tempo: a Lia recebe a dica e o caderninho guarda", async () => {
    await setupStore();
    await createCoupon(sdb, { code: "AMADURECE", type: "percent", value: 5, valueSchedule: [{ afterDays: 7, value: 10 }], userId: FIXED_USER_ID });
    const execute = executor();
    await execute("adicionar_a_sacola", { sku: "DUNAS-AREIA-M", quantidade: 1 });
    const result = await execute("validar_cupom", { cupom: "AMADURECE" });
    expect(result.ok).toBe(true);
    expect(result.text).toContain("[Este cupom muda com o tempo — Hoje vale 5%. Em 7 dias (");
    expect(result.text).toContain("sem pressionar");
    expect(((await botState()).coupon as { hint?: string }).hint).toMatch(/^Hoje vale 5%/);
  });

  it("cupom da turma: a Lia recebe a dica e o texto pronto para a amiga", async () => {
    await setupStore();
    await createCoupon(sdb, { code: "TURMA", type: "percent", value: 5, growthPerRedeemer: 2, growthCap: 15, userId: FIXED_USER_ID });
    const execute = executor();
    await execute("adicionar_a_sacola", { sku: "DUNAS-AREIA-M", quantidade: 1 });
    const result = await execute("validar_cupom", { cupom: "TURMA" });
    expect(result.ok).toBe(true);
    expect(result.text).toContain("[Cupom da turma — Cupom da turma: 5% hoje — você pode ser a primeira.");
    expect(result.text).toContain("/c/TURMA");
    expect(result.text).toContain("o desconto sobe para as duas");
  });

  it("cupom pessoal: o do telefone da conversa vale (mesmo sem cadastro); o de outra cliente é recusado; frete grátis fala de frete", async () => {
    await setupStore();
    await createCoupon(sdb, { code: "MEU", type: "percent", value: 10, userId: FIXED_USER_ID, customerPhone: PHONE });
    await createCoupon(sdb, { code: "DELA", type: "percent", value: 10, userId: FIXED_USER_ID, customerPhone: OTHER_PHONE });
    await createCoupon(sdb, { code: "FRETE", type: "free_shipping", value: 0, userId: FIXED_USER_ID });
    const execute = executor();
    await execute("adicionar_a_sacola", { sku: "DUNAS-AREIA-M", quantidade: 1 });

    expect((await execute("validar_cupom", { cupom: "MEU" })).ok).toBe(true);

    const dela = await execute("validar_cupom", { cupom: "DELA" });
    expect(dela.ok).toBe(false);
    expect(dela.text).toContain("Este cupom é pessoal e foi feito para outra cliente.");
    // Um cupom recusado não derruba o que já estava validado.
    expect((await botState()).coupon).toMatchObject({ code: "MEU" });

    const frete = await execute("validar_cupom", { cupom: "FRETE" });
    expect(frete.ok).toBe(true);
    expect(frete.text).toContain("Cupom FRETE válido: frete grátis");
    expect((await botState()).coupon).toMatchObject({ code: "FRETE", discountCents: 0, freeShipping: true });

    // Fechando com o cupom de frete: o pedido cobra frete 0.
    await execute("cotar_frete", { cep: "01310100" });
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
    // O resumo fala do frete grátis, não de um "desconto" nas peças.
    expect(created.text).toContain("grátis pelo cupom FRETE");
    expect(created.text).not.toContain("Desconto:");
    expect(created.text).toContain(`TOTAL: ${formatCentsBRL(8990)}`);
    const [order] = await db.select().from(schema.orders);
    expect(order.couponCode).toBe("FRETE");
    expect(order.shippingCents).toBe(0);
    expect(order.discountCents).toBe(0);
    expect(order.totalCents).toBe(8990);
  });

  it("no ensaio (dryRun) as ferramentas do turno se enxergam (sacola → cupom → sacola) e nada é gravado", async () => {
    await setupStore();
    await createCoupon(sdb, { code: "DEZ10", type: "percent", value: 10, userId: FIXED_USER_ID });
    const execute = executor(true);
    await execute("adicionar_a_sacola", { sku: "DUNAS-AREIA-M", quantidade: 1 });
    const result = await execute("validar_cupom", { cupom: "DEZ10" });
    expect(result.ok).toBe(true);
    expect(result.text).toContain(`Cupom DEZ10 válido: desconto de ${formatCentsBRL(899)}`);
    expect((await execute("ver_sacola", {})).text).toContain("1× Longo Dunas");
    const state = await botState();
    expect(state.coupon).toBeUndefined();
    expect(state.cart).toBeUndefined();
    // Um executor novo (outro turno do ensaio) começa do banco: sacola vazia.
    expect((await executor(true)("validar_cupom", { cupom: "DEZ10" })).text).toContain("A sacola está vazia");
  });

  it("a sacola muda: o cupom validado é refeito sobre o subtotal novo, ou esquecido com o motivo", async () => {
    await setupStore();
    await createCoupon(sdb, { code: "DEZ10", type: "percent", value: 10, minOrderCents: 10_000, userId: FIXED_USER_ID });
    const execute = executor();
    await execute("adicionar_a_sacola", { sku: "DUNAS-AREIA-M", quantidade: 2 });
    expect((await execute("validar_cupom", { cupom: "DEZ10" })).ok).toBe(true);
    expect((await botState()).coupon).toMatchObject({ discountCents: 1798 });

    // Quantidade é o TOTAL da linha: 3 fixa 3 (não 2 + 3).
    const more = await execute("adicionar_a_sacola", { sku: "DUNAS-AREIA-M", quantidade: 3 });
    expect(more.text).toContain("Ajustei Longo Dunas (Areia · M) de 2× para 3× (quantidade = total na sacola).");
    expect(more.text).toContain(`[Cupom DEZ10 continua válido: desconto de ${formatCentsBRL(2697)} sobre o subtotal de ${formatCentsBRL(26970)} das peças`);
    expect((await botState()).coupon).toMatchObject({ code: "DEZ10", discountCents: 2697 });
    // Repetir sem quantidade: nada muda, e o cupom fica como está.
    const again = await execute("adicionar_a_sacola", { sku: "DUNAS-AREIA-M" });
    expect(again.text).toContain("nada mudou");
    expect((await botState()).coupon).toMatchObject({ code: "DEZ10", discountCents: 2697 });

    // Sacola cai abaixo do mínimo: o cupom deixa de valer e é esquecido.
    const less = await execute("remover_da_sacola", { sku: "DUNAS-AREIA-M" });
    expect(less.ok).toBe(true);
    expect(less.text).toContain("Tirei 3× Longo Dunas (Areia · M) da sacola.");
    expect(less.text).toContain("[O cupom DEZ10 validado antes foi esquecido: a sacola ficou vazia.");
    expect((await botState()).coupon).toBeUndefined();

    await execute("adicionar_a_sacola", { sku: "DUNAS-AREIA-M", quantidade: 2 });
    expect((await execute("validar_cupom", { cupom: "DEZ10" })).ok).toBe(true);
    await db.update(schema.coupons).set({ minOrderCents: 50_000 }).where(eq(schema.coupons.code, "DEZ10"));
    const changed = await execute("adicionar_a_sacola", { sku: "DUNAS-AREIA-M", quantidade: 3 });
    expect(changed.text).toContain(`[O cupom DEZ10 deixou de valer para esta sacola: Este cupom vale para pedidos a partir de ${formatCentsBRL(50_000)}.`);
    expect((await botState()).coupon).toBeUndefined();
  });

  it("cupom do caderninho recusado no fechamento é esquecido e o modelo é avisado; o próximo criar_pedido fecha sem cupom", async () => {
    await setupStore();
    await createCoupon(sdb, { code: "DEZ10", type: "percent", value: 10, userId: FIXED_USER_ID });
    const execute = executor();
    await execute("adicionar_a_sacola", { sku: "DUNAS-AREIA-M", quantidade: 1 });
    expect((await execute("validar_cupom", { cupom: "DEZ10" })).ok).toBe(true);
    await db.update(schema.coupons).set({ isActive: false }).where(eq(schema.coupons.code, "DEZ10"));
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
    const refused = await execute("criar_pedido", dados);
    expect(refused.ok).toBe(false);
    expect(refused.text).toContain("Este cupom não está mais ativo.");
    expect(refused.text).toContain("[O cupom DEZ10, validado antes nesta conversa, foi aplicado sozinho e recusado agora; já o esqueci.");
    expect((await botState()).coupon).toBeUndefined();
    expect(await db.select().from(schema.orders)).toHaveLength(0);

    const created = await execute("criar_pedido", dados);
    expect(created.ok).toBe(true);
    const [order] = await db.select().from(schema.orders);
    expect(order.couponCode).toBeNull();
    expect(order.discountCents).toBe(0);
  });
});
