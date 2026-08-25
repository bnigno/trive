import type { Metadata } from "next";
import Link from "next/link";
import { count } from "drizzle-orm";

import {
  ORDER_STATUSES,
  ORDER_STATUS_LABELS,
  type OrderStatus,
} from "@/core/orders/state-machine";
import { getDb } from "@/db/client";
import { orders } from "@/db/schema";
import { listOrders } from "@/services/orders";
import { requireUser } from "@/services/auth";
import { EmptyState } from "@/components/ui/empty-state";
import { Money } from "@/components/ui/money";
import { PageHeader } from "@/components/ui/page-header";
import { StatusPill, orderStatusTone } from "@/components/ui/status-pill";
import { Table, Td, Tr } from "@/components/ui/table";
import { cx } from "@/components/ui/cx";
import { channelLabel, formatDateTimeSP } from "./format";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Pedidos",
};

function isOrderStatus(value: string): value is OrderStatus {
  return (ORDER_STATUSES as readonly string[]).includes(value);
}

export default async function PedidosPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; q?: string }>;
}) {
  await requireUser();
  const params = await searchParams;
  const status =
    params.status && isOrderStatus(params.status) ? params.status : undefined;
  const search = params.q?.trim() || undefined;

  const db = getDb();
  const [rows, countRows] = await Promise.all([
    listOrders(db, { status, search }),
    // Leitura simples para as contagens dos filtros (sem mutação).
    db
      .select({ status: orders.status, total: count() })
      .from(orders)
      .groupBy(orders.status),
  ]);

  const countByStatus = new Map(countRows.map((r) => [r.status, r.total]));
  const totalCount = countRows.reduce((sum, r) => sum + r.total, 0);

  const queryFor = (s?: OrderStatus) => {
    const query = new URLSearchParams();
    if (s) query.set("status", s);
    if (search) query.set("q", search);
    const qs = query.toString();
    return qs ? `/admin/pedidos?${qs}` : "/admin/pedidos";
  };

  const pillBase =
    "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1 text-xs font-medium transition-colors";
  const pillActive =
    "border-indigo-600 bg-indigo-600 text-white dark:border-indigo-500 dark:bg-indigo-500";
  const pillInactive =
    "border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800";

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Pedidos"
        subtitle="Acompanhe e gerencie os pedidos da loja."
        actions={
          <Link
            href="/admin/pedidos/novo"
            className="inline-flex items-center justify-center rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500"
          >
            Novo pedido
          </Link>
        }
      />

      <div className="flex flex-wrap gap-2">
        <Link
          href={queryFor(undefined)}
          className={cx(pillBase, status === undefined ? pillActive : pillInactive)}
        >
          Todos
          <span className="opacity-75">{totalCount}</span>
        </Link>
        {ORDER_STATUSES.map((s) => (
          <Link
            key={s}
            href={queryFor(s)}
            className={cx(pillBase, status === s ? pillActive : pillInactive)}
          >
            {ORDER_STATUS_LABELS[s]}
            <span className="opacity-75">{countByStatus.get(s) ?? 0}</span>
          </Link>
        ))}
      </div>

      <form action="/admin/pedidos" method="get" className="flex max-w-md gap-2">
        {status ? <input type="hidden" name="status" value={status} /> : null}
        <input
          type="search"
          name="q"
          defaultValue={search ?? ""}
          placeholder="Buscar por nome do cliente ou nº do pedido (ex.: #1042)"
          className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder:text-zinc-500"
        />
        <button
          type="submit"
          className="rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          Buscar
        </button>
      </form>

      {rows.length === 0 ? (
        <EmptyState
          title={
            search || status
              ? "Nenhum pedido encontrado com esses filtros."
              : "Você ainda não tem pedidos."
          }
          hint={
            search || status
              ? "Tente limpar a busca ou escolher outro status."
              : "Crie o primeiro pedido manualmente — leva menos de um minuto."
          }
          action={
            <Link
              href="/admin/pedidos/novo"
              className="inline-flex items-center justify-center rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500"
            >
              Novo pedido
            </Link>
          }
        />
      ) : (
        <Table headers={["Nº", "Cliente", "Status", "Canal", "Total", "Data"]}>
          {rows.map((order) => (
            <Tr key={order.id}>
              <Td>
                <Link
                  href={`/admin/pedidos/${order.id}`}
                  className="font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                >
                  #{order.orderNumber}
                </Link>
              </Td>
              <Td>
                <Link
                  href={`/admin/clientes/${order.customerId}`}
                  className="hover:underline"
                >
                  {order.customerName}
                </Link>
              </Td>
              <Td>
                <StatusPill
                  label={
                    ORDER_STATUS_LABELS[order.status as OrderStatus] ??
                    order.status
                  }
                  tone={orderStatusTone(order.status)}
                />
              </Td>
              <Td>{channelLabel(order.channel)}</Td>
              <Td>
                <Money cents={order.totalCents} className="font-medium" />
              </Td>
              <Td className="whitespace-nowrap">
                {formatDateTimeSP(order.createdAt)}
              </Td>
            </Tr>
          ))}
        </Table>
      )}
    </div>
  );
}
