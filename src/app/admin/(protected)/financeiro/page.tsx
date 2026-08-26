import type { Metadata } from "next";
import Link from "next/link";
import { inArray } from "drizzle-orm";

import { getDb } from "@/db/client";
import { orders } from "@/db/schema";
import { requireOwner } from "@/services/auth";
import { listEntries, monthOverview } from "@/services/financial";
import { listSuppliers } from "@/services/suppliers";
import { Badge } from "@/components/ui/badge";
import { Card, StatCard } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Select } from "@/components/ui/form";
import { Money } from "@/components/ui/money";
import { PageHeader } from "@/components/ui/page-header";
import { StatusPill } from "@/components/ui/status-pill";
import { Table, Td, Tr } from "@/components/ui/table";
import { EntryActions } from "./entry-actions";
import { NewEntryForm } from "./new-entry-form";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Financeiro",
};

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const STATUSES = ["pending", "settled", "canceled"] as const;
const DIRECTIONS = ["receivable", "payable"] as const;

type EntryStatus = (typeof STATUSES)[number];
type EntryDirection = (typeof DIRECTIONS)[number];

const CATEGORY_LABELS: Record<string, string> = {
  sale: "Venda",
  mp_fee: "Taxa MP",
  shipping_cost: "Frete",
  supplier: "Fornecedor",
  refund: "Reembolso",
  other: "Outros",
};

const STATUS_LABELS: Record<EntryStatus, string> = {
  pending: "Pendente",
  settled: "Liquidado",
  canceled: "Cancelado",
};

const STATUS_TONES: Record<EntryStatus, "warning" | "success" | "neutral"> = {
  pending: "warning",
  settled: "success",
  canceled: "neutral",
};

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

/** 'YYYY-MM-DD' → 'dd/mm/aaaa'. */
function formatDueDate(dueDate: string | null): string {
  if (!dueDate) return "—";
  const [year, month, day] = dueDate.split("-");
  return `${day}/${month}/${year}`;
}

function monthHref(
  month: string,
  status: string | undefined,
  dir: string | undefined,
): string {
  const params = new URLSearchParams({ m: month });
  if (status) params.set("status", status);
  if (dir) params.set("dir", dir);
  return `/admin/financeiro?${params.toString()}`;
}

export default async function FinancialPage({
  searchParams,
}: {
  searchParams: Promise<{ m?: string; status?: string; dir?: string }>;
}) {
  await requireOwner("financeiro");
  const sp = await searchParams;

  const month = sp.m && MONTH_PATTERN.test(sp.m) ? sp.m : currentMonthSP();
  const [year, monthNumber] = month.split("-").map(Number);
  const status = (STATUSES as readonly string[]).includes(sp.status ?? "")
    ? (sp.status as EntryStatus)
    : undefined;
  const direction = (DIRECTIONS as readonly string[]).includes(sp.dir ?? "")
    ? (sp.dir as EntryDirection)
    : undefined;

  const db = getDb();
  const [overview, entries, supplierRows] = await Promise.all([
    monthOverview(db, { year, month: monthNumber }),
    listEntries(db, { month, status, direction, limit: 200 }),
    listSuppliers(db),
  ]);
  const supplierOptions = supplierRows.map((supplier) => ({
    id: supplier.id,
    name: supplier.name,
  }));

  // Leitura direta (não é mutação): número dos pedidos vinculados.
  const orderIds = [
    ...new Set(
      entries.flatMap((entry) => (entry.orderId ? [entry.orderId] : [])),
    ),
  ];
  const orderRows =
    orderIds.length > 0
      ? await db
          .select({ id: orders.id, orderNumber: orders.orderNumber })
          .from(orders)
          .where(inArray(orders.id, orderIds))
      : [];
  const orderNumberById = new Map(
    orderRows.map((row) => [row.id, row.orderNumber]),
  );

  const balanceTone = overview.balanceCents >= 0 ? "success" : "danger";

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Financeiro"
        subtitle="O que entrou, o que saiu e o que ainda está em aberto."
        actions={
          <div className="flex items-center gap-2 text-sm">
            <Link
              href={monthHref(shiftMonth(month, -1), status, direction)}
              aria-label="Mês anterior"
              className="rounded-md border border-zinc-300 px-2.5 py-1.5 font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              ‹
            </Link>
            <span className="min-w-40 text-center font-medium text-zinc-900 dark:text-zinc-100">
              {monthLabel(month)}
            </span>
            <Link
              href={monthHref(shiftMonth(month, 1), status, direction)}
              aria-label="Próximo mês"
              className="rounded-md border border-zinc-300 px-2.5 py-1.5 font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              ›
            </Link>
          </div>
        }
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <StatCard
          label="Recebido"
          tone="success"
          value={<Money cents={overview.receivedCents} />}
          hint="Entradas liquidadas no mês"
        />
        <StatCard
          label="A receber"
          tone="info"
          value={<Money cents={overview.receivableCents} />}
          hint="Entradas pendentes (total em aberto)"
        />
        <StatCard
          label="Pago"
          tone="danger"
          value={<Money cents={overview.paidCents} />}
          hint="Saídas liquidadas no mês"
        />
        <StatCard
          label="A pagar"
          tone="warning"
          value={<Money cents={overview.payableCents} />}
          hint="Saídas pendentes (total em aberto)"
        />
        <StatCard
          label="Saldo do mês"
          tone={balanceTone}
          value={<Money cents={overview.balanceCents} />}
          hint="Recebido − pago no mês"
        />
      </div>

      <div className="grid items-start gap-6 xl:grid-cols-[2fr_1fr]">
        <div className="flex flex-col gap-4">
          <form
            action="/admin/financeiro"
            method="get"
            className="flex flex-wrap items-end gap-3"
          >
            <input type="hidden" name="m" value={month} />
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium text-zinc-700 dark:text-zinc-300">
                Status
              </span>
              <Select name="status" defaultValue={status ?? ""} className="w-44">
                <option value="">Todos</option>
                <option value="pending">Pendente</option>
                <option value="settled">Liquidado</option>
                <option value="canceled">Cancelado</option>
              </Select>
            </label>
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium text-zinc-700 dark:text-zinc-300">
                Tipo
              </span>
              <Select name="dir" defaultValue={direction ?? ""} className="w-44">
                <option value="">Todos</option>
                <option value="receivable">Entrada</option>
                <option value="payable">Saída</option>
              </Select>
            </label>
            <button
              type="submit"
              className="rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              Filtrar
            </button>
          </form>

          {entries.length === 0 ? (
            <EmptyState
              title="Nenhum lançamento neste mês"
              hint="Receitas de vendas entram sozinhas quando o pedido é pago. Despesas manuais você cria no formulário ao lado."
            />
          ) : (
            <Table
              headers={[
                "Tipo",
                "Categoria",
                "Descrição",
                "Fornecedor",
                "Valor",
                "Status",
                "Vencimento",
                "Pedido",
                "Ações",
              ]}
            >
              {entries.map((entry) => {
                const isIncome = entry.direction === "receivable";
                const entryStatus = entry.status as EntryStatus;
                const orderNumber = entry.orderId
                  ? orderNumberById.get(entry.orderId)
                  : undefined;
                return (
                  <Tr key={entry.id}>
                    <Td>
                      <Badge tone={isIncome ? "success" : "danger"}>
                        {isIncome ? "Entrada" : "Saída"}
                      </Badge>
                    </Td>
                    <Td className="whitespace-nowrap">
                      {CATEGORY_LABELS[entry.category] ?? entry.category}
                    </Td>
                    <Td className="max-w-64">
                      <span className="line-clamp-2">{entry.description}</span>
                    </Td>
                    <Td className="whitespace-nowrap">
                      {entry.supplierId && entry.supplierName ? (
                        <Link
                          href={`/admin/fornecedores/${entry.supplierId}`}
                          className="font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                        >
                          {entry.supplierName}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </Td>
                    <Td
                      className={
                        "whitespace-nowrap font-medium " +
                        (isIncome
                          ? "text-emerald-600 dark:text-emerald-400"
                          : "text-red-600 dark:text-red-400")
                      }
                    >
                      {isIncome ? "+" : "−"}
                      <Money cents={entry.amountCents} />
                    </Td>
                    <Td>
                      <StatusPill
                        label={STATUS_LABELS[entryStatus] ?? entry.status}
                        tone={STATUS_TONES[entryStatus] ?? "neutral"}
                      />
                    </Td>
                    <Td className="whitespace-nowrap">
                      {formatDueDate(entry.dueDate)}
                    </Td>
                    <Td>
                      {entry.orderId ? (
                        <Link
                          href={`/admin/pedidos/${entry.orderId}`}
                          className="font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                        >
                          #{orderNumber ?? entry.orderId.slice(0, 8)}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </Td>
                    <Td>
                      {entryStatus === "pending" ? (
                        <EntryActions entryId={entry.id} />
                      ) : (
                        "—"
                      )}
                    </Td>
                  </Tr>
                );
              })}
            </Table>
          )}
        </div>

        <Card title="Novo lançamento">
          <NewEntryForm supplierOptions={supplierOptions} />
        </Card>
      </div>
    </div>
  );
}
