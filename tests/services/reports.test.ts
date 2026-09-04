import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import {
  marginSummary,
  monthlyAccountantReport,
  recoveryStats,
  reportToCsv,
  salesSeries,
  topProducts,
  type AccountantReportRow,
} from "@/services/reports";
import {
  createTestCustomer,
  createTestDb,
  createTestVariant,
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

const spDayFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Sao_Paulo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** 'YYYY-MM-DD' do dia SP do instante dado. */
function spDay(instant: Date): string {
  return spDayFormatter.format(instant);
}

interface TestItem {
  variantId: string;
  sku: string;
  name?: string;
  quantity: number;
  unitPriceCents: number;
  unitCostCents: number;
}

/** Insere pedido + itens respeitando os CHECKs de consistência de totais. */
async function createOrderWithItems(
  opts: {
    customerId: string;
    status?: string;
    paidAt?: Date | null;
    discountCents?: number;
    shippingCents?: number;
    mpFeeCents?: number | null;
    paymentMethod?: string | null;
    items: TestItem[];
  },
): Promise<string> {
  const subtotalCents = opts.items.reduce(
    (sum, item) => sum + item.unitPriceCents * item.quantity,
    0,
  );
  const discountCents = opts.discountCents ?? 0;
  const shippingCents = opts.shippingCents ?? 0;
  const [order] = await db
    .insert(schema.orders)
    .values({
      customerId: opts.customerId,
      status: opts.status ?? "paid",
      paidAt: opts.paidAt ?? null,
      subtotalCents,
      discountCents,
      shippingCents,
      totalCents: subtotalCents - discountCents + shippingCents,
      mpFeeCents: opts.mpFeeCents ?? null,
      paymentMethod: opts.paymentMethod ?? null,
    })
    .returning({ id: schema.orders.id });
  await db.insert(schema.orderItems).values(
    opts.items.map((item) => ({
      orderId: order.id,
      productVariantId: item.variantId,
      skuSnapshot: item.sku,
      nameSnapshot: item.name ?? `Produto ${item.sku}`,
      quantity: item.quantity,
      unitPriceCents: item.unitPriceCents,
      unitCostCents: item.unitCostCents,
      totalCents: item.unitPriceCents * item.quantity,
    })),
  );
  return order.id;
}

describe("reportToCsv", () => {
  const baseRow: AccountantReportRow = {
    orderNumber: 1001,
    paidAt: "15/07/2026 14:30",
    customerName: "Maria Silva",
    customerDocument: "12345678901",
    itemsSummary: "2x SKU-A; 1x SKU-B",
    subtotalCents: 123456,
    discountCents: 1000,
    shippingCents: 2500,
    totalCents: 124956,
    paymentMethod: "pix",
    mpFeeCents: 617,
    netCents: 124339,
  };

  it("gera header pt-BR, separador ';' e valores '1234,56'", () => {
    const csv = reportToCsv([baseRow]);
    const lines = csv.trimEnd().split("\r\n");
    expect(lines[0]).toBe(
      "Pedido;Data do pagamento;Cliente;CPF/CNPJ;Itens;Subtotal (R$);Desconto (R$);Frete (R$);Total (R$);Forma de pagamento;Taxa Mercado Pago (R$);Líquido (R$)",
    );
    expect(lines[1]).toBe(
      '#1001;15/07/2026 14:30;Maria Silva;12345678901;"2x SKU-A; 1x SKU-B";1234,56;10,00;25,00;1249,56;Pix;6,17;1243,39',
    );
  });

  it("escapa ';' e aspas em campos de texto (aspas dobradas)", () => {
    const csv = reportToCsv([
      {
        ...baseRow,
        customerName: 'Loja "Boa; Bonita" Ltda',
        itemsSummary: "1x SKU-X",
        customerDocument: null,
        paymentMethod: null,
        mpFeeCents: null,
        netCents: baseRow.totalCents,
      },
    ]);
    const dataLine = csv.trimEnd().split("\r\n")[1];
    expect(dataLine).toContain('"Loja ""Boa; Bonita"" Ltda"');
    // Sem taxa MP: campo vazio, líquido = total.
    expect(dataLine).toContain(";;1249,56");
    // Campo sem caractere especial fica sem aspas.
    expect(dataLine).toContain(";1x SKU-X;");
  });
});

describe("salesSeries", () => {
  it("agrupa por dia de São Paulo e zera dias sem venda", async () => {
    const customerId = await createTestCustomer(db);
    const { variantId } = await createTestVariant(db, { sku: "SKU-SERIE" });
    const item: TestItem = {
      variantId,
      sku: "SKU-SERIE",
      quantity: 1,
      unitPriceCents: 10000,
      unitCostCents: 4000,
    };

    const todaySp = spDay(new Date());
    // 23h30 SP de hoje = 02h30 UTC de AMANHÃ: agrupamento por dia UTC jogaria
    // esta venda para fora da série; por dia SP ela conta HOJE.
    const lateNightSp = new Date(`${todaySp}T23:30:00-03:00`);
    await createOrderWithItems({ customerId, paidAt: lateNightSp, items: [item] });
    await createOrderWithItems({ customerId, paidAt: lateNightSp, items: [item] });

    // 5 dias atrás.
    const fiveDaysAgo = new Date(Date.now() - 5 * 86_400_000);
    await createOrderWithItems({ customerId, paidAt: fiveDaysAgo, items: [item] });

    // Não contam: sem paid_at e reembolsado (mesmo com paid_at).
    await createOrderWithItems({ customerId, status: "pending_payment", paidAt: null, items: [item] });
    await createOrderWithItems({ customerId, status: "refunded", paidAt: new Date(), items: [item] });

    const series = await salesSeries(sdb, { days: 14 });
    expect(series).toHaveLength(14);
    expect(series[13].date).toBe(todaySp);
    expect(series[13]).toEqual({ date: todaySp, ordersCount: 2, revenueCents: 20000 });

    const dayOfOld = spDay(fiveDaysAgo);
    const oldPoint = series.find((point) => point.date === dayOfOld);
    expect(oldPoint).toEqual({ date: dayOfOld, ordersCount: 1, revenueCents: 10000 });

    // Todos os demais dias presentes e zerados.
    const zeroDays = series.filter(
      (point) => point.date !== todaySp && point.date !== dayOfOld,
    );
    expect(zeroDays).toHaveLength(12);
    expect(zeroDays.every((point) => point.ordersCount === 0 && point.revenueCents === 0)).toBe(true);
  });
});

describe("topProducts", () => {
  it("soma quantidade e receita por SKU de pedidos pagos, ordenado por receita", async () => {
    const customerId = await createTestCustomer(db);
    const { variantId: a } = await createTestVariant(db, { sku: "SKU-A" });
    const { variantId: b } = await createTestVariant(db, { sku: "SKU-B" });

    await createOrderWithItems({
      customerId,
      paidAt: new Date(),
      items: [
        { variantId: a, sku: "SKU-A", name: "Vestido", quantity: 2, unitPriceCents: 5000, unitCostCents: 2000 },
        { variantId: b, sku: "SKU-B", name: "Bolsa", quantity: 1, unitPriceCents: 30000, unitCostCents: 10000 },
      ],
    });
    await createOrderWithItems({
      customerId,
      paidAt: new Date(),
      items: [
        { variantId: a, sku: "SKU-A", name: "Vestido", quantity: 3, unitPriceCents: 5000, unitCostCents: 2000 },
      ],
    });
    // Pedido não pago não entra.
    await createOrderWithItems({
      customerId,
      status: "draft",
      paidAt: null,
      items: [
        { variantId: a, sku: "SKU-A", name: "Vestido", quantity: 10, unitPriceCents: 5000, unitCostCents: 2000 },
      ],
    });

    const top = await topProducts(sdb, { days: 30, limit: 5 });
    // Nome e código são os ATUAIS da variação (não o snapshot da venda).
    expect(top).toEqual([
      { variantId: b, name: "Produto SKU-B", sku: "SKU-B", quantity: 1, revenueCents: 30000 },
      { variantId: a, name: "Produto SKU-A", sku: "SKU-A", quantity: 5, revenueCents: 25000 },
    ]);
  });

  it("a mesma variação continua uma linha só depois de trocar o código e o nome", async () => {
    const customerId = await createTestCustomer(db);
    const { productId, variantId } = await createTestVariant(db, {
      sku: "LONGO-ELEN-PRET-M",
      name: "Longo Elen",
    });
    await createOrderWithItems({
      customerId,
      paidAt: new Date(),
      items: [
        { variantId, sku: "LONGO-ELEN-PRET-M", name: "Longo Elen", quantity: 1, unitPriceCents: 7999, unitCostCents: 3000 },
      ],
    });
    await db
      .update(schema.products)
      .set({ name: "LONGO DUNAS" })
      .where(eq(schema.products.id, productId));
    await db
      .update(schema.productVariants)
      .set({ sku: "LONGO-DUNAS-PRET-M" })
      .where(eq(schema.productVariants.id, variantId));
    await createOrderWithItems({
      customerId,
      paidAt: new Date(),
      items: [
        { variantId, sku: "LONGO-DUNAS-PRET-M", name: "LONGO DUNAS", quantity: 2, unitPriceCents: 7999, unitCostCents: 3000 },
      ],
    });

    const top = await topProducts(sdb, { days: 30, limit: 5 });
    expect(top).toEqual([
      { variantId, name: "LONGO DUNAS", sku: "LONGO-DUNAS-PRET-M", quantity: 3, revenueCents: 23997 },
    ]);
  });
});

describe("marginSummary", () => {
  it("soma receita, custo, taxa real e margens da janela", async () => {
    const customerId = await createTestCustomer(db);
    const { variantId } = await createTestVariant(db, { sku: "SKU-M" });

    // Pedido 1: 2 × R$ 100 (custo R$ 40 cada), taxa MP R$ 9,90.
    await createOrderWithItems({
      customerId,
      paidAt: new Date(),
      mpFeeCents: 990,
      items: [{ variantId, sku: "SKU-M", quantity: 2, unitPriceCents: 10000, unitCostCents: 4000 }],
    });
    // Pedido 2: 1 × R$ 50 (custo R$ 20), sem taxa informada.
    await createOrderWithItems({
      customerId,
      paidAt: new Date(),
      items: [{ variantId, sku: "SKU-M", quantity: 1, unitPriceCents: 5000, unitCostCents: 2000 }],
    });
    // Fora da janela de 30 dias.
    await createOrderWithItems({
      customerId,
      paidAt: new Date(Date.now() - 40 * 86_400_000),
      items: [{ variantId, sku: "SKU-M", quantity: 1, unitPriceCents: 99900, unitCostCents: 50000 }],
    });

    const summary = await marginSummary(sdb, { days: 30 });
    expect(summary).toEqual({
      revenueCents: 25000,
      costCents: 10000,
      estimatedMarginCents: 15000,
      realFeeCents: 990,
      realMarginCents: 14010,
    });
  });
});

describe("recoveryStats", () => {
  it("conta lembretes enviados e quantos desses pedidos viraram pagos", async () => {
    const customerId = await createTestCustomer(db);
    const { variantId } = await createTestVariant(db, { sku: "SKU-R" });
    const item: TestItem = {
      variantId,
      sku: "SKU-R",
      quantity: 1,
      unitPriceCents: 8000,
      unitCostCents: 3000,
    };

    const recoveredId = await createOrderWithItems({ customerId, paidAt: new Date(), items: [item] });
    const stillPendingId = await createOrderWithItems({
      customerId,
      status: "pending_payment",
      paidAt: null,
      items: [item],
    });
    await db.insert(schema.auditLog).values([
      { actorType: "system", action: "wa.recovery", entityType: "order", entityId: recoveredId },
      { actorType: "system", action: "wa.recovery", entityType: "order", entityId: stillPendingId },
    ]);

    const stats = await recoveryStats(sdb);
    expect(stats).toEqual({ remindersSent: 2, recoveredOrders: 1 });
  });
});

describe("monthlyAccountantReport", () => {
  it("só pega pedidos pagos do mês (corte SP) com colunas completas", async () => {
    const maria = await createTestCustomer(db, "Maria Silva");
    await db
      .update(schema.customers)
      .set({ documentNumber: "12345678901" })
      .where(eq(schema.customers.id, maria));
    const { variantId: a } = await createTestVariant(db, { sku: "SKU-A" });
    const { variantId: b } = await createTestVariant(db, { sku: "SKU-B" });

    // Pago em julho/2026 (15/07 meio-dia SP), com desconto, frete e taxa.
    await createOrderWithItems({
      customerId: maria,
      paidAt: new Date("2026-07-15T15:00:00Z"),
      discountCents: 500,
      shippingCents: 2000,
      mpFeeCents: 300,
      paymentMethod: "pix",
      items: [
        { variantId: b, sku: "SKU-B", quantity: 1, unitPriceCents: 4000, unitCostCents: 1500 },
        { variantId: a, sku: "SKU-A", quantity: 2, unitPriceCents: 3000, unitCostCents: 1000 },
      ],
    });
    // 31/07 23h00 SP = 01/08 02h00 UTC: corte UTC jogaria para agosto; é julho.
    await createOrderWithItems({
      customerId: maria,
      paidAt: new Date("2026-08-01T02:00:00Z"),
      paymentMethod: "credit_card",
      items: [{ variantId: a, sku: "SKU-A", quantity: 1, unitPriceCents: 10000, unitCostCents: 4000 }],
    });
    // Fora: pago em junho, não pago em julho, cancelado com paid_at em julho.
    await createOrderWithItems({
      customerId: maria,
      paidAt: new Date("2026-06-30T12:00:00Z"),
      items: [{ variantId: a, sku: "SKU-A", quantity: 1, unitPriceCents: 7000, unitCostCents: 2000 }],
    });
    await createOrderWithItems({
      customerId: maria,
      status: "pending_payment",
      paidAt: null,
      items: [{ variantId: a, sku: "SKU-A", quantity: 1, unitPriceCents: 7000, unitCostCents: 2000 }],
    });
    await createOrderWithItems({
      customerId: maria,
      status: "canceled",
      paidAt: new Date("2026-07-10T12:00:00Z"),
      items: [{ variantId: a, sku: "SKU-A", quantity: 1, unitPriceCents: 7000, unitCostCents: 2000 }],
    });

    const rows = await monthlyAccountantReport(sdb, { year: 2026, month: 7 });
    expect(rows).toHaveLength(2);

    const [first, second] = rows;
    expect(first.paidAt).toBe("15/07/2026 12:00");
    expect(first.customerName).toBe("Maria Silva");
    expect(first.customerDocument).toBe("12345678901");
    expect(first.itemsSummary).toBe("2x SKU-A; 1x SKU-B");
    expect(first.subtotalCents).toBe(10000);
    expect(first.discountCents).toBe(500);
    expect(first.shippingCents).toBe(2000);
    expect(first.totalCents).toBe(11500);
    expect(first.paymentMethod).toBe("pix");
    expect(first.mpFeeCents).toBe(300);
    expect(first.netCents).toBe(11200);

    expect(second.paidAt).toBe("31/07/2026 23:00");
    expect(second.mpFeeCents).toBeNull();
    expect(second.netCents).toBe(second.totalCents);
    // Ordenado por paid_at crescente.
    expect(first.orderNumber).toBeLessThan(second.orderNumber);
  });

  it("mês sem vendas retorna vazio e CSV só com header", async () => {
    const rows = await monthlyAccountantReport(sdb, { year: 2026, month: 1 });
    expect(rows).toEqual([]);
    const csv = reportToCsv(rows);
    expect(csv).toBe(
      "Pedido;Data do pagamento;Cliente;CPF/CNPJ;Itens;Subtotal (R$);Desconto (R$);Frete (R$);Total (R$);Forma de pagamento;Taxa Mercado Pago (R$);Líquido (R$)\r\n",
    );
  });
});
