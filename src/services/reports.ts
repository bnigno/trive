import { and, asc, desc, eq, gte, inArray, isNotNull, lt, notInArray, sql } from "drizzle-orm";
import { z } from "zod";

import { PAYMENT_METHOD_LABELS as CORE_PAYMENT_METHOD_LABELS } from "@/core/orders/payment-methods";
import { auditLog, customers, orderItems, orders } from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";

// ---------------------------------------------------------------------------
// Relatórios de operação (somente leitura).
//
// "Pedido pago" aqui = paid_at preenchido E status fora de canceled/refunded:
// um pedido reembolsado sai dos números de receita (o dinheiro voltou), mas o
// paid_at continua no banco para histórico.
//
// Corte de dia/mês SEMPRE em America/Sao_Paulo (UTC-3 fixo, sem horário de
// verão desde 2019): um Pix pago 23h30 em SP é 02h30 UTC do dia seguinte e
// precisa contar no dia em que o dono viveu a venda.
// ---------------------------------------------------------------------------

const EXCLUDED_STATUSES = ["canceled", "refunded"] as const;

/** Condição compartilhada de "pedido pago". */
function paidCondition() {
  return and(
    isNotNull(orders.paidAt),
    notInArray(orders.status, [...EXCLUDED_STATUSES]),
  );
}

const SP_TIME_ZONE = "America/Sao_Paulo";

/** Dia SP em SQL: 'YYYY-MM-DD' do paid_at convertido para America/Sao_Paulo. */
const paidDaySpSql = sql<string>`to_char(date_trunc('day', ${orders.paidAt} at time zone 'America/Sao_Paulo'), 'YYYY-MM-DD')`;

const spDayFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: SP_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** 'YYYY-MM-DD' (dia SP) do instante dado. */
function spDayKey(instant: Date): string {
  return spDayFormatter.format(instant);
}

/** Meia-noite SP do dia 'YYYY-MM-DD' como instante UTC. */
function spMidnight(dayKey: string): Date {
  return new Date(`${dayKey}T00:00:00-03:00`);
}

// ---------------------------------------------------------------------------
// 1. salesSeries — série diária de vendas pagas (para o mini-gráfico).
// ---------------------------------------------------------------------------

const salesSeriesSchema = z.object({
  days: z.number().int().positive().max(90).default(14),
});

export type SalesSeriesInput = z.input<typeof salesSeriesSchema>;

export interface SalesSeriesPoint {
  /** Dia SP no formato 'YYYY-MM-DD'. */
  date: string;
  ordersCount: number;
  revenueCents: number;
}

/**
 * Últimos N dias (incluindo hoje), com TODOS os dias presentes — dias sem
 * venda entram zerados para o gráfico não "pular" datas.
 */
export async function salesSeries(
  db: DbOrTx,
  input: SalesSeriesInput = {},
): Promise<SalesSeriesPoint[]> {
  const { days } = salesSeriesSchema.parse(input);

  const now = new Date();
  const dayKeys: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    dayKeys.push(spDayKey(new Date(now.getTime() - i * 86_400_000)));
  }
  const windowStart = spMidnight(dayKeys[0]);

  const rows = await db
    .select({
      date: paidDaySpSql,
      ordersCount: sql<string | number>`count(*)`,
      revenueCents: sql<string | number>`coalesce(sum(${orders.totalCents}), 0)`,
    })
    .from(orders)
    .where(and(paidCondition(), gte(orders.paidAt, windowStart)))
    .groupBy(paidDaySpSql);

  const byDay = new Map(
    rows.map((row) => [
      row.date,
      { ordersCount: Number(row.ordersCount), revenueCents: Number(row.revenueCents) },
    ]),
  );

  return dayKeys.map((date) => ({
    date,
    ordersCount: byDay.get(date)?.ordersCount ?? 0,
    revenueCents: byDay.get(date)?.revenueCents ?? 0,
  }));
}

// ---------------------------------------------------------------------------
// 2. topProducts — mais vendidos (por receita) em pedidos pagos.
// ---------------------------------------------------------------------------

const topProductsSchema = z.object({
  days: z.number().int().positive().max(365).default(30),
  limit: z.number().int().positive().max(50).default(5),
});

export type TopProductsInput = z.input<typeof topProductsSchema>;

export interface TopProductRow {
  name: string;
  sku: string;
  quantity: number;
  revenueCents: number;
}

export async function topProducts(
  db: DbOrTx,
  input: TopProductsInput = {},
): Promise<TopProductRow[]> {
  const { days, limit } = topProductsSchema.parse(input);
  const windowStart = new Date(Date.now() - days * 86_400_000);

  const revenueSql = sql<string | number>`coalesce(sum(${orderItems.totalCents}), 0)`;
  const rows = await db
    .select({
      name: orderItems.nameSnapshot,
      sku: orderItems.skuSnapshot,
      quantity: sql<string | number>`coalesce(sum(${orderItems.quantity}), 0)`,
      revenueCents: revenueSql,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(and(paidCondition(), gte(orders.paidAt, windowStart)))
    .groupBy(orderItems.skuSnapshot, orderItems.nameSnapshot)
    .orderBy(desc(revenueSql))
    .limit(limit);

  return rows.map((row) => ({
    name: row.name,
    sku: row.sku,
    quantity: Number(row.quantity),
    revenueCents: Number(row.revenueCents),
  }));
}

// ---------------------------------------------------------------------------
// 3. marginSummary — margem estimada × real dos pedidos pagos na janela.
// ---------------------------------------------------------------------------

const marginSummarySchema = z.object({
  days: z.number().int().positive().max(365).default(30),
});

export type MarginSummaryInput = z.input<typeof marginSummarySchema>;

export interface MarginSummary {
  /** Soma do total pago pelos clientes (produtos − desconto + frete). */
  revenueCents: number;
  /** Custo dos itens vendidos (snapshot unit_cost_cents × quantidade). */
  costCents: number;
  /** receita − custo (ignora taxas). */
  estimatedMarginCents: number;
  /** Soma das taxas reais do Mercado Pago, onde informadas. */
  realFeeCents: number;
  /** receita − custo − taxas reais (quando houver). */
  realMarginCents: number;
}

export async function marginSummary(
  db: DbOrTx,
  input: MarginSummaryInput = {},
): Promise<MarginSummary> {
  const { days } = marginSummarySchema.parse(input);
  const windowStart = new Date(Date.now() - days * 86_400_000);
  const inWindow = and(paidCondition(), gte(orders.paidAt, windowStart));

  const [orderTotals] = await db
    .select({
      revenueCents: sql<string | number>`coalesce(sum(${orders.totalCents}), 0)`,
      realFeeCents: sql<string | number>`coalesce(sum(${orders.mpFeeCents}), 0)`,
    })
    .from(orders)
    .where(inWindow);

  const [itemTotals] = await db
    .select({
      costCents: sql<
        string | number
      >`coalesce(sum(${orderItems.unitCostCents} * ${orderItems.quantity}), 0)`,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(inWindow);

  const revenueCents = Number(orderTotals.revenueCents);
  const costCents = Number(itemTotals.costCents);
  const realFeeCents = Number(orderTotals.realFeeCents);
  return {
    revenueCents,
    costCents,
    estimatedMarginCents: revenueCents - costCents,
    realFeeCents,
    realMarginCents: revenueCents - costCents - realFeeCents,
  };
}

// ---------------------------------------------------------------------------
// 4. recoveryStats — lembretes de pagamento (WhatsApp) × pedidos recuperados.
// ---------------------------------------------------------------------------

export interface RecoveryStats {
  /** Lembretes de recuperação enviados (audit 'wa.recovery'). */
  remindersSent: number;
  /** Desses pedidos, quantos acabaram pagos. */
  recoveredOrders: number;
}

export async function recoveryStats(db: DbOrTx): Promise<RecoveryStats> {
  const recoveryAudit = and(
    eq(auditLog.action, "wa.recovery"),
    eq(auditLog.entityType, "order"),
    isNotNull(auditLog.entityId),
  );

  const [sentRow] = await db
    .select({ remindersSent: sql<string | number>`count(*)` })
    .from(auditLog)
    .where(recoveryAudit);

  const [recoveredRow] = await db
    .select({ recoveredOrders: sql<string | number>`count(distinct ${orders.id})` })
    .from(orders)
    .where(
      and(
        isNotNull(orders.paidAt),
        inArray(
          orders.id,
          db
            .select({ id: sql<string>`${auditLog.entityId}::uuid` })
            .from(auditLog)
            .where(recoveryAudit),
        ),
      ),
    );

  return {
    remindersSent: Number(sentRow.remindersSent),
    recoveredOrders: Number(recoveredRow.recoveredOrders),
  };
}

// ---------------------------------------------------------------------------
// 5. monthlyAccountantReport — base mensal para o contador emitir as notas.
// ---------------------------------------------------------------------------

const monthlyReportSchema = z.object({
  year: z.number().int().min(2000).max(2100),
  month: z.number().int().min(1).max(12),
});

export type MonthlyAccountantReportInput = z.input<typeof monthlyReportSchema>;

export interface AccountantReportRow {
  orderNumber: number;
  /** Data/hora do pagamento já no fuso de São Paulo ('dd/mm/aaaa hh:mm'). */
  paidAt: string;
  customerName: string;
  /** CPF/CNPJ só dígitos, ou null quando o cliente não informou. */
  customerDocument: string | null;
  /** Ex.: '2x SKU-A; 1x SKU-B'. */
  itemsSummary: string;
  subtotalCents: number;
  discountCents: number;
  shippingCents: number;
  totalCents: number;
  paymentMethod: string | null;
  mpFeeCents: number | null;
  /** total − taxa MP (quando informada). */
  netCents: number;
}

const paidAtFormatter = new Intl.DateTimeFormat("pt-BR", {
  timeZone: SP_TIME_ZONE,
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export async function monthlyAccountantReport(
  db: DbOrTx,
  input: MonthlyAccountantReportInput,
): Promise<AccountantReportRow[]> {
  const { year, month } = monthlyReportSchema.parse(input);

  // Janela do mês em instantes UTC correspondentes à meia-noite SP.
  const mm = String(month).padStart(2, "0");
  const start = spMidnight(`${year}-${mm}-01`);
  const nextMonth = month === 12 ? { y: year + 1, m: 1 } : { y: year, m: month + 1 };
  const end = spMidnight(`${nextMonth.y}-${String(nextMonth.m).padStart(2, "0")}-01`);

  const rows = await db
    .select({
      orderNumber: orders.orderNumber,
      paidAt: orders.paidAt,
      customerName: customers.fullName,
      customerDocument: customers.documentNumber,
      itemsSummary: sql<string>`string_agg(${orderItems.quantity}::text || 'x ' || ${orderItems.skuSnapshot}, '; ' order by ${orderItems.skuSnapshot})`,
      subtotalCents: orders.subtotalCents,
      discountCents: orders.discountCents,
      shippingCents: orders.shippingCents,
      totalCents: orders.totalCents,
      paymentMethod: orders.paymentMethod,
      mpFeeCents: orders.mpFeeCents,
    })
    .from(orders)
    .innerJoin(customers, eq(customers.id, orders.customerId))
    .innerJoin(orderItems, eq(orderItems.orderId, orders.id))
    .where(
      and(paidCondition(), gte(orders.paidAt, start), lt(orders.paidAt, end)),
    )
    .groupBy(orders.id, customers.id)
    .orderBy(asc(orders.paidAt), asc(orders.orderNumber));

  return rows.map((row) => {
    const mpFeeCents = row.mpFeeCents === null ? null : Number(row.mpFeeCents);
    const totalCents = Number(row.totalCents);
    return {
      orderNumber: Number(row.orderNumber),
      // paidCondition garante paid_at não nulo; o '!' é seguro aqui.
      // Intl põe vírgula entre data e hora ('15/07/2026, 12:00'); tiramos.
      paidAt: paidAtFormatter.format(row.paidAt!).replace(",", ""),
      customerName: row.customerName,
      customerDocument: row.customerDocument,
      itemsSummary: row.itemsSummary,
      subtotalCents: Number(row.subtotalCents),
      discountCents: Number(row.discountCents),
      shippingCents: Number(row.shippingCents),
      totalCents,
      paymentMethod: row.paymentMethod,
      mpFeeCents,
      netCents: totalCents - (mpFeeCents ?? 0),
    };
  });
}

// ---------------------------------------------------------------------------
// 6. reportToCsv — CSV "modo Excel Brasil": separador ';', decimal ','.
// ---------------------------------------------------------------------------

const CSV_SEPARATOR = ";";

const CSV_HEADERS = [
  "Pedido",
  "Data do pagamento",
  "Cliente",
  "CPF/CNPJ",
  "Itens",
  "Subtotal (R$)",
  "Desconto (R$)",
  "Frete (R$)",
  "Total (R$)",
  "Forma de pagamento",
  "Taxa Mercado Pago (R$)",
  "Líquido (R$)",
] as const;

// Labels completos da fonte única do core (CSV do contador).
const PAYMENT_METHOD_LABELS: Record<string, string> = CORE_PAYMENT_METHOD_LABELS;

/** 123456 → '1234,56' (sem separador de milhar: o Excel BR lê como número). */
function centsToCsvNumber(cents: number): string {
  return (cents / 100).toFixed(2).replace(".", ",");
}

/** Campo com ';', aspas ou quebra de linha vai entre aspas (aspas dobradas). */
function csvField(value: string): string {
  return /[";\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Função pura: linhas do relatório → CSV (sem BOM; quem serve o arquivo põe). */
export function reportToCsv(rows: AccountantReportRow[]): string {
  const lines = [CSV_HEADERS.join(CSV_SEPARATOR)];
  for (const row of rows) {
    lines.push(
      [
        `#${row.orderNumber}`,
        row.paidAt,
        csvField(row.customerName),
        row.customerDocument ?? "",
        csvField(row.itemsSummary),
        centsToCsvNumber(row.subtotalCents),
        centsToCsvNumber(row.discountCents),
        centsToCsvNumber(row.shippingCents),
        centsToCsvNumber(row.totalCents),
        row.paymentMethod
          ? (PAYMENT_METHOD_LABELS[row.paymentMethod] ?? row.paymentMethod)
          : "",
        row.mpFeeCents === null ? "" : centsToCsvNumber(row.mpFeeCents),
        centsToCsvNumber(row.netCents),
      ].join(CSV_SEPARATOR),
    );
  }
  // CRLF: convenção de CSV que o Excel entende em qualquer plataforma.
  return lines.join("\r\n") + "\r\n";
}
