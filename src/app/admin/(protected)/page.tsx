import type { Metadata } from "next";
import Link from "next/link";
import { count, eq, gte, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { orders, outboxEvents, priceVersions } from "@/db/schema";
import { requireUser } from "@/services/auth";
import { listOrders } from "@/services/orders";
import { monthOverview } from "@/services/financial";
import { getStockOverview } from "@/services/stock";
import { StatCard } from "@/components/ui/card";
import { Money } from "@/components/ui/money";
import { formatCentsBRL } from "@/lib/money";
import { StatusPill, orderStatusTone } from "@/components/ui/status-pill";
import { Table, Td, Tr } from "@/components/ui/table";
import { EmptyState } from "@/components/ui/empty-state";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Dashboard",
};

const ORDER_STATUS_LABELS: Record<string, string> = {
  draft: "Rascunho",
  pending_payment: "Aguardando pagamento",
  paid: "Pago",
  preparing: "Em preparação",
  shipped: "Enviado",
  delivered: "Entregue",
  canceled: "Cancelado",
  refunded: "Reembolsado",
};

const whenFormatter = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

/** Meia-noite de hoje em America/Sao_Paulo (UTC-3, sem horário de verão). */
function startOfTodaySaoPaulo(): Date {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
  }).format(new Date());
  return new Date(`${today}T00:00:00-03:00`);
}

function saoPauloYearMonth(): { year: number; month: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
  })
    .format(new Date())
    .split("-");
  return { year: Number(parts[0]), month: Number(parts[1]) };
}

/** Cada bloco falha isolado: sem banco o dashboard mostra "—", nunca quebra. */
async function safe<T>(load: () => Promise<T>): Promise<T | null> {
  try {
    return await load();
  } catch {
    return null;
  }
}

type RecentOrder = Awaited<ReturnType<typeof listOrders>>[number];

async function loadDashboard() {
  const [ordersToday, month, pendingApprovals, lowStockCount, recentOrders, deadCount] =
    await Promise.all([
      safe(async () => {
        const db = getDb();
        const [row] = await db
          .select({
            total: count(),
            sumCents: sql<string>`coalesce(sum(${orders.totalCents}), 0)`,
          })
          .from(orders)
          .where(gte(orders.createdAt, startOfTodaySaoPaulo()));
        return { total: row.total, sumCents: Number(row.sumCents) };
      }),
      safe(() => monthOverview(getDb(), saoPauloYearMonth())),
      safe(async () => {
        const db = getDb();
        const [row] = await db
          .select({ total: count() })
          .from(priceVersions)
          .where(eq(priceVersions.status, "pending_approval"));
        return row.total;
      }),
      safe(async () => {
        const overview = await getStockOverview(getDb());
        return overview.filter((row) => row.low).length;
      }),
      safe((): Promise<RecentOrder[]> => listOrders(getDb(), { limit: 5 })),
      safe(async () => {
        const db = getDb();
        const [row] = await db
          .select({ total: count() })
          .from(outboxEvents)
          .where(eq(outboxEvents.status, "dead"));
        return row.total;
      }),
    ]);

  return { ordersToday, month, pendingApprovals, lowStockCount, recentOrders, deadCount };
}

export default async function AdminDashboardPage() {
  const user = await requireUser();
  const data = await loadDashboard();

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">
          Olá, {user.fullName ?? user.email}
        </h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Visão geral da operação.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Link href="/admin/pedidos" className="block">
          <StatCard
            label="Pedidos hoje"
            value={data.ordersToday ? String(data.ordersToday.total) : "—"}
            hint={
              data.ordersToday
                ? `Somando ${formatCentsBRL(data.ordersToday.sumCents)}`
                : "Banco indisponível no momento."
            }
          />
        </Link>
        <Link href="/admin/financeiro" className="block">
          <StatCard
            label="Recebido no mês"
            value={data.month ? <Money cents={data.month.receivedCents} /> : "—"}
            hint={
              data.month
                ? `A receber: ${formatCentsBRL(data.month.receivableCents)}`
                : "Banco indisponível no momento."
            }
          />
        </Link>
        <Link href="/admin/precos/pendencias" className="block">
          <StatCard
            label="Aprovações de preço pendentes"
            value={data.pendingApprovals === null ? "—" : String(data.pendingApprovals)}
            tone={data.pendingApprovals ? "warning" : "neutral"}
            hint="Preços aguardando a sua aprovação."
          />
        </Link>
        <Link href="/admin/estoque" className="block">
          <StatCard
            label="Estoque baixo"
            value={data.lowStockCount === null ? "—" : String(data.lowStockCount)}
            tone={data.lowStockCount ? "warning" : "neutral"}
            hint="Variações no limiar de alerta ou abaixo."
          />
        </Link>
      </div>

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
            Últimos pedidos
          </h2>
          <Link
            href="/admin/pedidos"
            className="text-sm font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-400"
          >
            Ver todos
          </Link>
        </div>

        {data.recentOrders === null ? (
          <EmptyState
            title="Não foi possível carregar os pedidos"
            hint="O banco de dados está indisponível no momento. Tente recarregar a página."
          />
        ) : data.recentOrders.length === 0 ? (
          <EmptyState
            title="Nenhum pedido ainda"
            hint="Quando você registrar o primeiro pedido, ele aparece aqui."
            action={
              <Link
                href="/admin/pedidos/novo"
                className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500"
              >
                Criar pedido
              </Link>
            }
          />
        ) : (
          <Table headers={["Pedido", "Cliente", "Situação", "Total", "Quando"]}>
            {data.recentOrders.map((order) => (
              <Tr key={order.id}>
                <Td>
                  <Link
                    href={`/admin/pedidos/${order.id}`}
                    className="font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-400"
                  >
                    #{order.orderNumber}
                  </Link>
                </Td>
                <Td>{order.customerName}</Td>
                <Td>
                  <StatusPill
                    label={ORDER_STATUS_LABELS[order.status] ?? order.status}
                    tone={orderStatusTone(order.status)}
                  />
                </Td>
                <Td>
                  <Money cents={order.totalCents} />
                </Td>
                <Td>{whenFormatter.format(order.createdAt)}</Td>
              </Tr>
            ))}
          </Table>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
          Fila de integrações
        </h2>
        <div className="grid grid-cols-1 gap-4 sm:max-w-sm">
          <Link href="/admin/fila" className="block">
            <StatCard
              label="Eventos com problema"
              value={data.deadCount === null ? "—" : String(data.deadCount)}
              tone={data.deadCount ? "danger" : "neutral"}
              hint={
                data.deadCount === null
                  ? "Banco indisponível no momento."
                  : data.deadCount > 0
                    ? "Eventos que falharam e precisam da sua atenção. Ver na Fila."
                    : "Tudo certo com as integrações."
              }
            />
          </Link>
        </div>
      </section>
    </div>
  );
}
