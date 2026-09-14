import type { Metadata } from "next";
import Link from "next/link";
import { count, eq, gte, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { orders, outboxEvents, priceVersions } from "@/db/schema";
import { isOwner, requireUser } from "@/services/auth";
import { listOrders } from "@/services/orders";
import { countRouteOfDay } from "@/services/delivery-routes";
import { countOrdersMustShipToday } from "@/services/needed-by";
import { countAtelierIntakesFailed } from "@/services/atelier";
import { countOrdersAwaitingPacking } from "@/services/packing";
import { countOrdersAwaitingDelivery } from "@/services/delivery";
import { getReadinessSummary } from "@/services/catalog-readiness";
import { monthOverview } from "@/services/financial";
import { getStockOverview } from "@/services/stock";
import {
  marginSummary,
  recoveryStats,
  salesSeries,
  topProducts,
} from "@/services/reports";
import { Card, StatCard } from "@/components/ui/card";
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

/** 'YYYY-MM-DD' → 'dd/mm'. */
function shortDay(date: string): string {
  const [, month, day] = date.split("-");
  return `${day}/${month}`;
}

/** Percentual pt-BR com 1 casa ('32,5%'); '—' quando a base é zero. */
function formatPercent(partCents: number, wholeCents: number): string {
  if (wholeCents <= 0) return "—";
  return `${((partCents / wholeCents) * 100).toFixed(1).replace(".", ",")}%`;
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

/** O que a equipe também vê: operação do dia, sem valor de faturamento. */
async function loadSharedDashboard() {
  const [ordersTodayCount, lowStockCount, recentOrders, toPackCount, readiness, route, mustShipToday, toDeliverCount] =
    await Promise.all([
      safe(async () => {
        const db = getDb();
        const [row] = await db
          .select({ total: count() })
          .from(orders)
          .where(gte(orders.createdAt, startOfTodaySaoPaulo()));
        return row.total;
      }),
      safe(async () => {
        const overview = await getStockOverview(getDb());
        return overview.filter((row) => row.low).length;
      }),
      safe((): Promise<RecentOrder[]> => listOrders(getDb(), { limit: 5 })),
      safe(() => countOrdersAwaitingPacking(getDb())),
      safe(() => getReadinessSummary(getDb())),
      safe(() => countRouteOfDay(getDb())),
      safe(() => countOrdersMustShipToday(getDb())),
      safe(() => countOrdersAwaitingDelivery(getDb())),
    ]);

  return { ordersTodayCount, lowStockCount, recentOrders, toPackCount, readiness, route, mustShipToday, toDeliverCount };
}

/**
 * O termômetro da estreia: quantas peças estão prontas para vender de verdade
 * (ativa, com foto, preço, estoque, descrição, sala com capa). Área
 * compartilhada — a equipe também ajuda a completar as fichas.
 */
function ReadinessCard({
  summary,
  owner,
}: {
  summary: { ready: number; total: number; allReady: boolean } | null;
  owner: boolean;
}) {
  if (summary === null) return null;
  const percent = summary.total === 0 ? 0 : Math.round((summary.ready / summary.total) * 100);
  return (
    <Card title="Pronta para abrir">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">
            {summary.total === 0 ? (
              "Nenhuma peça cadastrada"
            ) : (
              <>
                {summary.ready} de {summary.total}{" "}
                <span className="text-base font-medium text-zinc-500 dark:text-zinc-400">
                  {summary.total === 1 ? "peça pronta" : "peças prontas"}
                </span>
              </>
            )}
          </p>
          {summary.total > 0 && !summary.allReady ? (
            <Link
              href="/admin/produtos?prontidao=faltando"
              className="text-sm font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-400"
            >
              Ver o que falta
            </Link>
          ) : null}
        </div>
        <div
          role="progressbar"
          aria-label="Peças prontas para a loja"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          className="h-2 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800"
        >
          <div
            className={
              summary.allReady
                ? "h-full rounded-full bg-emerald-500"
                : "h-full rounded-full bg-amber-500"
            }
            style={{ width: `${percent}%` }}
          />
        </div>
        {summary.allReady ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-emerald-700 dark:text-emerald-400">
              Tudo pronto — cada peça tem foto, preço, estoque, descrição e sala com capa.
            </p>
            {owner ? (
              <Link
                href="/admin/lancamentos"
                className="inline-flex items-center rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-indigo-500"
              >
                Agendar lançamento
              </Link>
            ) : null}
          </div>
        ) : (
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Uma peça está pronta quando está ativa, com ao menos 2 fotos, preço aprovado,
            estoque, descrição de 200 caracteres, peso e sala com capa. Toque no selo de
            cada peça para ir direto ao que falta.
          </p>
        )}
      </div>
    </Card>
  );
}

/**
 * Só o dono: faturamento, margem, gráfico de vendas, campeões de venda,
 * aprovações de preço e saúde da fila. Esta função nem é chamada para a
 * equipe — o corte é na carga, não na renderização.
 */
async function loadOwnerDashboard() {
  const [
    ordersTodaySumCents,
    month,
    pendingApprovals,
    deadCount,
    series,
    top,
    margin,
    recovery,
    atelierFailed,
  ] = await Promise.all([
    safe(async () => {
      const db = getDb();
      const [row] = await db
        .select({
          sumCents: sql<string>`coalesce(sum(${orders.totalCents}), 0)`,
        })
        .from(orders)
        .where(gte(orders.createdAt, startOfTodaySaoPaulo()));
      return Number(row.sumCents);
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
      const db = getDb();
      const [row] = await db
        .select({ total: count() })
        .from(outboxEvents)
        .where(eq(outboxEvents.status, "dead"));
      return row.total;
    }),
    safe(() => salesSeries(getDb(), { days: 14 })),
    safe(() => topProducts(getDb(), { days: 30, limit: 5 })),
    safe(() => marginSummary(getDb(), { days: 30 })),
    safe(() => recoveryStats(getDb())),
    safe(() => countAtelierIntakesFailed(getDb())),
  ]);

  return {
    atelierFailed,
    ordersTodaySumCents,
    month,
    pendingApprovals,
    deadCount,
    series,
    top,
    margin,
    recovery,
  };
}

export default async function AdminDashboardPage() {
  const user = await requireUser();
  const owner = await isOwner();
  const [data, ownerData] = await Promise.all([
    loadSharedDashboard(),
    owner ? loadOwnerDashboard() : null,
  ]);

  const maxRevenue = ownerData?.series
    ? Math.max(...ownerData.series.map((point) => point.revenueCents), 1)
    : 1;

  const ordersTodayHint =
    data.ordersTodayCount === null
      ? "Banco indisponível no momento."
      : ownerData && ownerData.ordersTodaySumCents !== null
        ? `Somando ${formatCentsBRL(ownerData.ordersTodaySumCents)}`
        : "Pedidos criados hoje, no fuso de São Paulo.";

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

      <div
        className={
          ownerData
            ? "grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-6"
            : "grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4"
        }
      >
        <Link href="/admin/pedidos" className="block">
          <StatCard
            label="Pedidos hoje"
            value={
              data.ordersTodayCount === null
                ? "—"
                : String(data.ordersTodayCount)
            }
            hint={ordersTodayHint}
          />
        </Link>
        {ownerData ? (
          <>
            <Link href="/admin/financeiro" className="block">
              <StatCard
                label="Recebido no mês"
                value={
                  ownerData.month ? (
                    <Money cents={ownerData.month.receivedCents} />
                  ) : (
                    "—"
                  )
                }
                hint={
                  ownerData.month
                    ? `A receber: ${formatCentsBRL(ownerData.month.receivableCents)}`
                    : "Banco indisponível no momento."
                }
              />
            </Link>
            <Link href="/admin/precos/pendencias" className="block">
              <StatCard
                label="Aprovações pendentes"
                value={
                  ownerData.pendingApprovals === null
                    ? "—"
                    : String(ownerData.pendingApprovals)
                }
                tone={ownerData.pendingApprovals ? "warning" : "neutral"}
                hint="Preços aguardando a sua aprovação."
              />
            </Link>
          </>
        ) : null}
        {ownerData?.atelierFailed ? (
          <Link href="/admin/produtos/chegadas" className="block">
            <StatCard
              label="Chegadas com problema"
              value={String(ownerData.atelierFailed)}
              tone="warning"
              hint="Fotos + recado pelo WhatsApp que não viraram rascunho. Abra e refaça."
            />
          </Link>
        ) : null}
        {data.mustShipToday ? (
          <Link href="/admin/pedidos/data-marcada" className="block">
            <StatCard
              label="Precisam sair hoje"
              value={String(data.mustShipToday)}
              tone="warning"
              hint="Pedidos com data marcada no limite. Abra a lista."
            />
          </Link>
        ) : null}
        {data.route && (data.route.today > 0 || data.route.late > 0) ? (
          <Link href="/admin/pedidos/rota" className="block">
            <StatCard
              label="Saem hoje (motoboy)"
              value={String(data.route.today)}
              tone={data.route.late ? "warning" : "neutral"}
              hint={data.route.late ? `${data.route.late} atrasado${data.route.late > 1 ? "s" : ""} — abra a rota.` : "Pedidos com janela de entrega hoje."}
            />
          </Link>
        ) : null}
        {data.toDeliverCount ? (
          <Link href="/admin/pedidos/entregar" className="block">
            <StatCard
              label="Para entregar"
              value={String(data.toDeliverCount)}
              tone="neutral"
              hint="A caminho da cliente — registre a entrega com a foto."
            />
          </Link>
        ) : null}
        <Link href="/admin/pedidos/embalar" className="block">
          <StatCard
            label="A embalar"
            value={data.toPackCount === null ? "—" : String(data.toPackCount)}
            tone={data.toPackCount ? "warning" : "neutral"}
            hint="Pedidos pagos esperando a foto do pacote."
          />
        </Link>
        <Link href="/admin/estoque" className="block">
          <StatCard
            label="Estoque baixo"
            value={
              data.lowStockCount === null ? "—" : String(data.lowStockCount)
            }
            tone={data.lowStockCount ? "warning" : "neutral"}
            hint="Variações no limiar de alerta ou abaixo."
          />
        </Link>
        {ownerData ? (
          <Link href="/admin/fila" className="block">
            <StatCard
              label="Fila com problemas"
              value={
                ownerData.deadCount === null ? "—" : String(ownerData.deadCount)
              }
              tone={ownerData.deadCount ? "danger" : "neutral"}
              hint={
                ownerData.deadCount
                  ? "Eventos que falharam e precisam da sua atenção."
                  : "Tudo certo com as integrações."
              }
            />
          </Link>
        ) : null}
      </div>

      <ReadinessCard summary={data.readiness} owner={owner} />

      {ownerData ? (
        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
              Vendas pagas — últimos 14 dias
            </h2>
            <Link
              href="/admin/relatorios"
              className="text-sm font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-400"
            >
              Ver relatórios
            </Link>
          </div>
          {ownerData.series === null ? (
            <EmptyState
              title="Não foi possível carregar o gráfico"
              hint="O banco de dados está indisponível no momento. Tente recarregar a página."
            />
          ) : (
            <Card>
              <div
                role="img"
                aria-label="Gráfico de barras da receita paga por dia nos últimos 14 dias"
                className="flex h-36 items-end gap-1.5 sm:gap-2"
              >
                {ownerData.series.map((point) => {
                  const label = `${shortDay(point.date)}: ${point.ordersCount} ${
                    point.ordersCount === 1 ? "pedido" : "pedidos"
                  }, ${formatCentsBRL(point.revenueCents)}`;
                  const heightPct =
                    point.revenueCents > 0
                      ? Math.max((point.revenueCents / maxRevenue) * 100, 4)
                      : 0;
                  return (
                    <div
                      key={point.date}
                      title={label}
                      className="flex h-full flex-1 flex-col justify-end"
                    >
                      <div
                        className={
                          point.revenueCents > 0
                            ? "w-full rounded-t bg-indigo-500 dark:bg-indigo-400"
                            : "h-0.5 w-full rounded bg-zinc-200 dark:bg-zinc-700"
                        }
                        style={
                          point.revenueCents > 0
                            ? { height: `${heightPct}%` }
                            : undefined
                        }
                      />
                      <span className="mt-1 hidden text-center text-[10px] text-zinc-500 sm:block dark:text-zinc-400">
                        {shortDay(point.date).slice(0, 2)}
                      </span>
                    </div>
                  );
                })}
              </div>
              <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
                Receita de pedidos pagos por dia (fuso de São Paulo). Passe o
                mouse sobre uma barra para ver o detalhe.
              </p>
            </Card>
          )}
        </section>
      ) : null}

      {ownerData ? (
        <div className="grid items-start gap-6 xl:grid-cols-2">
          <section className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
                Top 5 produtos — 30 dias
              </h2>
              <Link
                href="/admin/produtos"
                className="text-sm font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-400"
              >
                Ver produtos
              </Link>
            </div>
            {ownerData.top === null ? (
              <EmptyState
                title="Não foi possível carregar os produtos"
                hint="O banco de dados está indisponível no momento."
              />
            ) : ownerData.top.length === 0 ? (
              <EmptyState
                title="Nenhuma venda paga nos últimos 30 dias"
                hint="Quando as vendas entrarem, os campeões aparecem aqui."
              />
            ) : (
              <Table headers={["Produto", "SKU", "Qtde", "Receita"]}>
                {ownerData.top.map((product) => (
                  <Tr key={product.variantId}>
                    <Td className="font-medium text-zinc-900 dark:text-zinc-100">
                      {product.name}
                    </Td>
                    <Td className="whitespace-nowrap">{product.sku}</Td>
                    <Td>{product.quantity}</Td>
                    <Td className="whitespace-nowrap">
                      <Money cents={product.revenueCents} />
                    </Td>
                  </Tr>
                ))}
              </Table>
            )}
          </section>

          <div className="flex flex-col gap-6">
            <Card title="Margem — últimos 30 dias">
              {ownerData.margin === null ? (
                <p className="text-sm text-zinc-500 dark:text-zinc-400">
                  Banco indisponível no momento.
                </p>
              ) : (
                <dl className="flex flex-col gap-2 text-sm">
                  <div className="flex items-center justify-between">
                    <dt className="text-zinc-500 dark:text-zinc-400">Receita</dt>
                    <dd className="font-medium text-zinc-900 dark:text-zinc-100">
                      <Money cents={ownerData.margin.revenueCents} />
                    </dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt className="text-zinc-500 dark:text-zinc-400">
                      Custo dos produtos
                    </dt>
                    <dd className="font-medium text-zinc-900 dark:text-zinc-100">
                      − <Money cents={ownerData.margin.costCents} />
                    </dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt className="text-zinc-500 dark:text-zinc-400">
                      Taxas reais (Mercado Pago)
                    </dt>
                    <dd className="font-medium text-zinc-900 dark:text-zinc-100">
                      − <Money cents={ownerData.margin.realFeeCents} />
                    </dd>
                  </div>
                  <div className="flex items-center justify-between border-t border-zinc-200 pt-2 dark:border-zinc-800">
                    <dt className="font-medium text-zinc-900 dark:text-zinc-100">
                      Margem real
                    </dt>
                    <dd
                      className={
                        "font-semibold " +
                        (ownerData.margin.realMarginCents >= 0
                          ? "text-emerald-600 dark:text-emerald-400"
                          : "text-red-600 dark:text-red-400")
                      }
                    >
                      <Money cents={ownerData.margin.realMarginCents} /> (
                      {formatPercent(
                        ownerData.margin.realMarginCents,
                        ownerData.margin.revenueCents,
                      )}
                      )
                    </dd>
                  </div>
                  <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                    Margem real = receita − custo dos produtos − taxas cobradas
                    pelo Mercado Pago nos pedidos pagos dos últimos 30 dias.
                  </p>
                </dl>
              )}
            </Card>

            {ownerData.recovery !== null &&
            ownerData.recovery.remindersSent > 0 ? (
              <Card title="Recuperação por WhatsApp">
                <div className="flex items-center gap-8">
                  <div>
                    <p className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">
                      {ownerData.recovery.remindersSent}
                    </p>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">
                      lembretes enviados
                    </p>
                  </div>
                  <div>
                    <p className="text-2xl font-semibold text-emerald-600 dark:text-emerald-400">
                      {ownerData.recovery.recoveredOrders}
                    </p>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">
                      pedidos recuperados
                    </p>
                  </div>
                </div>
                <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
                  Pedidos que receberam lembrete de pagamento e acabaram pagos.{" "}
                  <Link
                    href="/admin/whatsapp"
                    className="font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-400"
                  >
                    Ver WhatsApp
                  </Link>
                </p>
              </Card>
            ) : null}
          </div>
        </div>
      ) : null}

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
    </div>
  );
}
