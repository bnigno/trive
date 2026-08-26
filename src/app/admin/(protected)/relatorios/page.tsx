import type { Metadata } from "next";
import Link from "next/link";

import { PAYMENT_METHOD_LABELS } from "@/core/orders/payment-methods";
import { getDb } from "@/db/client";
import { requireOwner } from "@/services/auth";
import { monthlyAccountantReport } from "@/services/reports";
import { Card, StatCard } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Money } from "@/components/ui/money";
import { PageHeader } from "@/components/ui/page-header";
import { Table, Td, Tr } from "@/components/ui/table";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Relatórios",
};

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const PREVIEW_LIMIT = 15;

/** Label pt-BR do método vindo do core; método desconhecido volta cru. */
function paymentMethodLabel(method: string): string {
  return (PAYMENT_METHOD_LABELS as Record<string, string>)[method] ?? method;
}

/** Mês corrente no fuso de São Paulo, formato YYYY-MM. */
function currentMonthSP(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(new Date())
    .slice(0, 7);
}

function shiftMonth(month: string, delta: number): string {
  const [year, mm] = month.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, mm - 1 + delta, 1));
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function monthLabel(month: string): string {
  const [year, mm] = month.split("-").map(Number);
  const label = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "UTC",
    month: "long",
    year: "numeric",
  }).format(new Date(Date.UTC(year, mm - 1, 1)));
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ m?: string }>;
}) {
  await requireOwner("relatorios");
  const sp = await searchParams;

  const month = sp.m && MONTH_PATTERN.test(sp.m) ? sp.m : currentMonthSP();
  const [year, monthNumber] = month.split("-").map(Number);

  const rows = await monthlyAccountantReport(getDb(), {
    year,
    month: monthNumber,
  });

  const totals = rows.reduce(
    (acc, row) => ({
      totalCents: acc.totalCents + row.totalCents,
      feeCents: acc.feeCents + (row.mpFeeCents ?? 0),
      netCents: acc.netCents + row.netCents,
    }),
    { totalCents: 0, feeCents: 0, netCents: 0 },
  );
  const preview = rows.slice(0, PREVIEW_LIMIT);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Relatórios"
        subtitle="Vendas pagas do mês, prontas para o contador."
        actions={
          <div className="flex items-center gap-2 text-sm">
            <Link
              href={`/admin/relatorios?m=${shiftMonth(month, -1)}`}
              aria-label="Mês anterior"
              className="rounded-md border border-zinc-300 px-2.5 py-1.5 font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              ‹
            </Link>
            <span className="min-w-40 text-center font-medium text-zinc-900 dark:text-zinc-100">
              {monthLabel(month)}
            </span>
            <Link
              href={`/admin/relatorios?m=${shiftMonth(month, 1)}`}
              aria-label="Próximo mês"
              className="rounded-md border border-zinc-300 px-2.5 py-1.5 font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              ›
            </Link>
          </div>
        }
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Pedidos pagos" value={String(rows.length)} />
        <StatCard
          label="Total vendido"
          value={<Money cents={totals.totalCents} />}
        />
        <StatCard
          label="Taxas Mercado Pago"
          value={<Money cents={totals.feeCents} />}
          hint="Somente as taxas já informadas pelo Mercado Pago."
        />
        <StatCard
          label="Líquido"
          tone="success"
          value={<Money cents={totals.netCents} />}
          hint="Total vendido − taxas."
        />
      </div>

      <Card title="Arquivo para o contador">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <p className="max-w-xl text-sm text-zinc-600 dark:text-zinc-400">
            Envie este arquivo ao seu contador todo início de mês — é a base
            para a emissão das notas. Ele abre direto no Excel, com uma linha
            por pedido pago.
          </p>
          <a
            href={`/admin/relatorios/csv?m=${month}`}
            download
            className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500"
          >
            Baixar CSV para o contador
          </a>
        </div>
      </Card>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
          Prévia do relatório
          {rows.length > PREVIEW_LIMIT
            ? ` (primeiras ${PREVIEW_LIMIT} de ${rows.length} linhas)`
            : ""}
        </h2>
        {rows.length === 0 ? (
          <EmptyState
            title="Nenhuma venda paga neste mês"
            hint="Quando os pedidos forem pagos, eles entram aqui e no CSV do contador."
          />
        ) : (
          <Table
            headers={[
              "Pedido",
              "Pago em",
              "Cliente",
              "CPF/CNPJ",
              "Itens",
              "Total",
              "Pagamento",
              "Taxa MP",
              "Líquido",
            ]}
          >
            {preview.map((row) => (
              <Tr key={row.orderNumber}>
                <Td className="whitespace-nowrap font-medium text-zinc-900 dark:text-zinc-100">
                  #{row.orderNumber}
                </Td>
                <Td className="whitespace-nowrap">{row.paidAt}</Td>
                <Td>{row.customerName}</Td>
                <Td className="whitespace-nowrap">
                  {row.customerDocument ?? "—"}
                </Td>
                <Td className="max-w-64">
                  <span className="line-clamp-2">{row.itemsSummary}</span>
                </Td>
                <Td className="whitespace-nowrap">
                  <Money cents={row.totalCents} />
                </Td>
                <Td className="whitespace-nowrap">
                  {row.paymentMethod
                    ? paymentMethodLabel(row.paymentMethod)
                    : "—"}
                </Td>
                <Td className="whitespace-nowrap">
                  {row.mpFeeCents === null ? "—" : <Money cents={row.mpFeeCents} />}
                </Td>
                <Td className="whitespace-nowrap">
                  <Money cents={row.netCents} />
                </Td>
              </Tr>
            ))}
          </Table>
        )}
      </section>
    </div>
  );
}
