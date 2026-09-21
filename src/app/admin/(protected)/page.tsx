import {
  Bot,
  Boxes,
  ChartColumn,
  ChevronRight,
  CircleCheck,
  ListChecks,
  type LucideIcon,
  Mail,
  MessageCircle,
  Package,
  Plus,
  ShoppingBag,
  Sparkles,
  Tags,
  Truck,
  Camera,
  CalendarClock,
  Users,
  Wallet,
} from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { ORDER_STATUS_LABELS } from "@/core/orders/state-machine";
import { getDb } from "@/db/client";
import { formatCentsBRL } from "@/lib/money";
import { spDayLabel } from "@/lib/sp-day";
import { formatDateTimeSP, formatRelativeTimePtBR } from "@/lib/sp-format";
import type { AdminRole } from "@/core/auth/access";
import { requireUser } from "@/services/auth";
import { getAdminDashboard, type AdminDashboard } from "@/services/dashboard";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button-link";
import { BarChart, type BarChartPoint } from "@/components/ui/bar-chart";
import { Card, StatCard } from "@/components/ui/card";
import { cx } from "@/components/ui/cx";
import { EmptyState } from "@/components/ui/empty-state";
import { Meter } from "@/components/ui/meter";
import { Money } from "@/components/ui/money";
import { SectionHeading } from "@/components/ui/section-heading";
import { CardSkeleton } from "@/components/ui/skeleton";
import { StatusPill, orderStatusTone } from "@/components/ui/status-pill";
import { Table, Td, Tr } from "@/components/ui/table";
import { TrendBadge } from "@/components/ui/trend";
import { buildAttentionRows, type AttentionSeverity } from "./dashboard-attention";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Dashboard",
};

// ---------------------------------------------------------------------------
// Formatação (só borda de exibição)
// ---------------------------------------------------------------------------

/** 'YYYY-MM-DD' → 'dd/mm'. */
function shortDay(date: string): string {
  const [, month, day] = date.split("-");
  return `${day}/${month}`;
}

/** Eixo do gráfico: "R$ 1,2 mil" a partir de mil reais; abaixo, inteiro. */
function compactBRL(cents: number): string {
  if (cents >= 100_000) {
    const thousands = cents / 100_000;
    const text = thousands >= 10 ? Math.round(thousands).toString() : thousands.toFixed(1).replace(".", ",");
    return `R$ ${text} mil`;
  }
  return `R$ ${Math.round(cents / 100)}`;
}

/** Percentual pt-BR com 1 casa ('32,5%'); '—' quando a base é zero. */
function formatPercent(part: number, whole: number): string {
  if (whole <= 0) return "—";
  return `${((part / whole) * 100).toFixed(1).replace(".", ",")}%`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function count(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : String(value);
}

const icon = (Icon: LucideIcon) => (
  <Icon aria-hidden="true" className="size-4" strokeWidth={1.75} />
);

// ---------------------------------------------------------------------------
// Página
// ---------------------------------------------------------------------------

export default async function AdminDashboardPage() {
  const user = await requireUser();
  const todayLabel = capitalize(spDayLabel(new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date())));

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-400 dark:text-zinc-500">
            {todayLabel}
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
            Olá, {user.fullName ?? user.email}
          </h1>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            Visão geral da operação.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ButtonLink href="/admin/pedidos" variant="outline">
            Pedidos
          </ButtonLink>
          {user.role === "owner" ? (
            <ButtonLink href="/admin/relatorios" variant="outline">
              Relatórios
            </ButtonLink>
          ) : null}
          <ButtonLink href="/admin/pedidos/novo" icon={icon(Plus)}>
            Novo pedido
          </ButtonLink>
        </div>
      </div>

      <Suspense fallback={<DashboardSkeleton owner={user.role === "owner"} />}>
        <DashboardContent role={user.role} />
      </Suspense>
    </div>
  );
}

function DashboardSkeleton({ owner }: { owner: boolean }) {
  return (
    <div className="flex flex-col gap-8" aria-busy="true" aria-label="Carregando o painel">
      <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <CardSkeleton key={index} lines={1} />
        ))}
      </div>
      <div className="grid gap-6 xl:grid-cols-3">
        <CardSkeleton lines={5} />
        <CardSkeleton lines={5} className="xl:col-span-2" />
      </div>
      {owner ? (
        <div className="grid gap-6 xl:grid-cols-3">
          <CardSkeleton lines={4} />
          <CardSkeleton lines={4} />
          <CardSkeleton lines={4} />
        </div>
      ) : null}
      <CardSkeleton lines={4} />
    </div>
  );
}

/** A única leitura de dados da página: um service, um objeto. */
async function DashboardContent({ role }: { role: AdminRole }) {
  const dashboard = await getAdminDashboard(getDb(), { role });
  const { shared, owner } = dashboard;
  const now = new Date();

  return (
    <>
      <KpiRow dashboard={dashboard} />

      <div className="grid items-start gap-6 xl:grid-cols-3">
        <AttentionCard dashboard={dashboard} />
        <div className="flex flex-col gap-6 xl:col-span-2">
          {owner ? <SalesCard owner={owner} todayKey={shared.todayKey} /> : null}
          <ReadinessCard summary={shared.readiness} owner={owner !== null} />
        </div>
      </div>

      {owner ? (
        <div className="grid items-start gap-6 xl:grid-cols-3">
          <TopProductsCard owner={owner} />
          <MarginCard owner={owner} />
          <LiaCard owner={owner} shared={shared} />
        </div>
      ) : null}

      <RecentOrdersCard dashboard={dashboard} now={now} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Hoje — KPIs
// ---------------------------------------------------------------------------

function KpiRow({ dashboard }: { dashboard: AdminDashboard }) {
  const { shared, owner } = dashboard;
  const created = shared.ordersCreated;
  const attention = shared.attention;
  const conversationsHint = attention
    ? attention.pendingSuggestions > 0
      ? `${attention.pendingSuggestions} ${attention.pendingSuggestions === 1 ? "sugestão" : "sugestões"} da Lia para revisar.`
      : "Clientes esperando uma pessoa responder."
    : "Banco indisponível no momento.";

  const ordersCard = (
    <StatCard
      label="Pedidos hoje"
      value={count(created?.today)}
      icon={icon(ShoppingBag)}
      delta={created ? <TrendBadge today={created.today} yesterday={created.yesterday} /> : undefined}
      trend={owner?.series?.map((point) => point.ordersCount)}
      hint={created ? "Criados hoje, no fuso de São Paulo." : "Banco indisponível no momento."}
      href="/admin/pedidos"
    />
  );
  const conversationsCard = (
    <StatCard
      label="Conversas esperando"
      value={count(attention?.conversationsAwaiting)}
      tone={attention?.conversationsAwaiting ? "warning" : "neutral"}
      icon={icon(MessageCircle)}
      hint={conversationsHint}
      href="/admin/whatsapp/conversas"
    />
  );

  return (
    <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
      {ordersCard}
      {owner ? (
        <>
          <StatCard
            label="Vendas hoje"
            value={owner.paidSales ? <Money cents={owner.paidSales.today.revenueCents} /> : "—"}
            icon={icon(Wallet)}
            delta={
              owner.paidSales ? (
                <TrendBadge
                  today={owner.paidSales.today.revenueCents}
                  yesterday={owner.paidSales.yesterday.revenueCents}
                  format={formatCentsBRL}
                />
              ) : undefined
            }
            trend={owner.series?.map((point) => point.revenueCents)}
            hint={
              owner.paidSales?.today.averageTicketCents
                ? `${owner.paidSales.today.count} ${owner.paidSales.today.count === 1 ? "venda paga" : "vendas pagas"} · ticket médio ${formatCentsBRL(owner.paidSales.today.averageTicketCents)}`
                : "Nenhuma venda paga ainda hoje."
            }
            href="/admin/financeiro"
          />
          <StatCard
            label="Recebido no mês"
            value={owner.month ? <Money cents={owner.month.receivedCents} /> : "—"}
            icon={icon(ChartColumn)}
            hint={owner.month ? `A receber: ${formatCentsBRL(owner.month.receivableCents)}` : "Banco indisponível no momento."}
            href="/admin/financeiro"
          />
          {conversationsCard}
        </>
      ) : (
        <>
          {conversationsCard}
          <StatCard
            label="Clientes novos"
            value={count(shared.newCustomers?.current)}
            icon={icon(Users)}
            delta={
              shared.newCustomers ? (
                <span className="text-xs text-zinc-500 dark:text-zinc-400">
                  {shared.newCustomers.previous} na semana anterior
                </span>
              ) : undefined
            }
            hint="Cadastrados nos últimos 7 dias."
            href="/admin/clientes"
          />
          <StatCard
            label="E-mails aguardando"
            value={count(attention?.emailThreadsAwaiting)}
            tone={attention?.emailThreadsAwaiting ? "warning" : "neutral"}
            icon={icon(Mail)}
            hint="Conversas por e-mail que ninguém abriu ainda."
            href="/admin/emails"
          />
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Atenção agora
// ---------------------------------------------------------------------------

const ATTENTION_ICONS: Record<string, LucideIcon> = {
  "must-ship-today": CalendarClock,
  "dead-outbox": ListChecks,
  route: Truck,
  "to-deliver": Truck,
  "to-pack": Package,
  "pending-approvals": Tags,
  "atelier-failed": Camera,
  "pending-looks": Camera,
  "low-stock": Boxes,
  emails: Mail,
};

const SEVERITY_PILL: Record<AttentionSeverity, string> = {
  danger: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  warning: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  neutral: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
};

const SEVERITY_ICON: Record<AttentionSeverity, string> = {
  danger: "bg-red-50 text-red-600 dark:bg-red-950/60 dark:text-red-400",
  warning: "bg-amber-50 text-amber-600 dark:bg-amber-950/60 dark:text-amber-400",
  neutral: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
};

function AttentionCard({ dashboard }: { dashboard: AdminDashboard }) {
  const rows = buildAttentionRows(dashboard);
  return (
    <Card
      title="Atenção agora"
      description="O que está esperando alguém, do mais urgente para o mais tranquilo."
      padding="none"
    >
      {rows.length === 0 ? (
        <div className="p-5">
          <EmptyState
            icon={<CircleCheck aria-hidden="true" className="size-5" strokeWidth={1.75} />}
            title="Tudo em dia"
            hint="Nenhum pedido preso, nenhuma pendência esperando você."
          />
        </div>
      ) : (
        <ul className="flex flex-col">
          {rows.map((row) => {
            const Icon = ATTENTION_ICONS[row.key] ?? ListChecks;
            return (
              <li key={row.key} className="border-b border-zinc-100 last:border-b-0 dark:border-zinc-800">
                <Link
                  href={row.href}
                  className="group flex items-center gap-3 px-5 py-3 transition-colors hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500/40 dark:hover:bg-zinc-800/50"
                >
                  <span
                    aria-hidden="true"
                    className={cx("inline-grid size-9 shrink-0 place-items-center rounded-lg", SEVERITY_ICON[row.severity])}
                  >
                    <Icon className="size-4" strokeWidth={1.75} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
                        {row.label}
                      </span>
                      <span
                        className={cx(
                          "inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-semibold tabular-nums",
                          SEVERITY_PILL[row.severity],
                        )}
                      >
                        {row.count}
                      </span>
                    </span>
                    <span className="block truncate text-xs text-zinc-500 dark:text-zinc-400">
                      {row.hint}
                    </span>
                  </span>
                  <ChevronRight
                    aria-hidden="true"
                    className="size-4 shrink-0 text-zinc-300 transition-transform group-hover:translate-x-0.5 motion-reduce:transform-none dark:text-zinc-600"
                  />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Vendas pagas — 14 dias (dono)
// ---------------------------------------------------------------------------

function SalesCard({
  owner,
  todayKey,
}: {
  owner: NonNullable<AdminDashboard["owner"]>;
  todayKey: string;
}) {
  const series = owner.series;
  if (!series) {
    return (
      <Card title="Vendas pagas — últimos 14 dias">
        <p className="text-sm text-zinc-500 dark:text-zinc-400">Banco indisponível no momento.</p>
      </Card>
    );
  }
  const totalCents = series.reduce((sum, point) => sum + point.revenueCents, 0);
  const totalOrders = series.reduce((sum, point) => sum + point.ordersCount, 0);
  const best = series.reduce((top, point) => (point.revenueCents > top.revenueCents ? point : top), series[0]);
  const points: BarChartPoint[] = series.map((point) => ({
    label: shortDay(point.date),
    value: point.revenueCents,
    detail: `${shortDay(point.date)}${point.date === todayKey ? " (hoje)" : ""} · ${point.ordersCount} ${point.ordersCount === 1 ? "pedido" : "pedidos"} · ${formatCentsBRL(point.revenueCents)}`,
  }));

  return (
    <Card
      title="Vendas pagas — últimos 14 dias"
      description="Receita de pedidos pagos por dia, no fuso de São Paulo."
      action={
        <Link href="/admin/relatorios" className="text-sm font-medium text-indigo-600 hover:underline dark:text-indigo-400">
          Ver relatórios
        </Link>
      }
    >
      {totalOrders === 0 ? (
        <EmptyState
          icon={<ChartColumn aria-hidden="true" className="size-5" strokeWidth={1.75} />}
          title="Nenhuma venda paga nas últimas duas semanas"
          hint="Quando as vendas entrarem, o gráfico aparece aqui."
        />
      ) : (
        <div className="flex flex-col gap-5">
          <dl className="grid grid-cols-3 gap-3">
            <MiniStat label="Total no período" value={formatCentsBRL(totalCents)} />
            <MiniStat label="Média por dia" value={formatCentsBRL(Math.round(totalCents / series.length))} />
            <MiniStat label="Melhor dia" value={`${shortDay(best.date)} · ${formatCentsBRL(best.revenueCents)}`} />
          </dl>
          <BarChart
            points={points}
            formatTick={compactBRL}
            ariaLabel="Receita de pedidos pagos por dia nos últimos 14 dias"
          />
        </div>
      )}
    </Card>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-xs text-zinc-500 dark:text-zinc-400">{label}</dt>
      <dd className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">{value}</dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pronta para abrir
// ---------------------------------------------------------------------------

/**
 * O termômetro da estreia: quantas peças estão prontas para vender de verdade
 * (ativa, com foto, preço, estoque, descrição, sala com capa). Área
 * compartilhada — a equipe também ajuda a completar as fichas.
 */
function ReadinessCard({
  summary,
  owner,
}: {
  summary: AdminDashboard["shared"]["readiness"];
  owner: boolean;
}) {
  if (!summary) {
    return (
      <Card title="Pronta para abrir">
        <p className="text-sm text-zinc-500 dark:text-zinc-400">Banco indisponível no momento.</p>
      </Card>
    );
  }
  const missing = summary.total - summary.ready;
  const tone = summary.total === 0 ? "accent" : summary.allReady ? "success" : "warning";

  return (
    <Card
      title="Pronta para abrir"
      description="Peças ativas com foto, preço, estoque, descrição e sala com capa."
      action={
        <Link
          href="/admin/produtos?prontidao=faltando"
          className="text-sm font-medium text-indigo-600 hover:underline dark:text-indigo-400"
        >
          Ver o que falta
        </Link>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <p className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
            {summary.total === 0 ? (
              "Nenhuma peça cadastrada"
            ) : (
              <>
                {summary.ready} de {summary.total}{" "}
                <span className="text-base font-normal text-zinc-500 dark:text-zinc-400">
                  {summary.total === 1 ? "peça pronta" : "peças prontas"}
                </span>
              </>
            )}
          </p>
          {summary.allReady && summary.total > 0 ? (
            <Badge tone="success" dot>
              Tudo pronto
            </Badge>
          ) : missing > 0 ? (
            <Badge tone="warning" dot>
              {missing} {missing === 1 ? "falta" : "faltam"}
            </Badge>
          ) : null}
        </div>
        <Meter value={summary.ready} max={summary.total} tone={tone} label="Peças prontas para vender" />
        {owner && summary.total > 0 ? (
          <div>
            <ButtonLink href="/admin/lancamentos" size="sm" variant="outline" icon={icon(Sparkles)}>
              Agendar lançamento
            </ButtonLink>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Top 5, margem e Lia (dono)
// ---------------------------------------------------------------------------

function TopProductsCard({ owner }: { owner: NonNullable<AdminDashboard["owner"]> }) {
  const top = owner.topProducts;
  const maxRevenue = top ? Math.max(...top.map((row) => row.revenueCents), 0) : 0;
  return (
    <Card
      title="Top 5 produtos"
      description="Mais vendidas em receita nos últimos 30 dias."
      action={
        <Link href="/admin/produtos" className="text-sm font-medium text-indigo-600 hover:underline dark:text-indigo-400">
          Ver produtos
        </Link>
      }
    >
      {!top ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">Banco indisponível no momento.</p>
      ) : top.length === 0 ? (
        <EmptyState
          title="Nenhuma venda paga nos últimos 30 dias"
          hint="Quando as vendas entrarem, as campeãs aparecem aqui."
        />
      ) : (
        <ol className="flex flex-col gap-3">
          {top.map((row, index) => (
            <li key={row.variantId} className="flex items-center gap-3">
              <span className="w-5 shrink-0 text-xs font-semibold tabular-nums text-zinc-400 dark:text-zinc-500">
                {index + 1}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-3">
                  <Link
                    href={`/admin/estoque/${row.variantId}`}
                    className="truncate text-sm font-medium text-zinc-900 hover:underline dark:text-zinc-100"
                  >
                    {row.name}
                  </Link>
                  <span className="shrink-0 text-sm font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
                    {formatCentsBRL(row.revenueCents)}
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-2">
                  <Meter value={row.revenueCents} max={maxRevenue} size="sm" label={`Receita de ${row.name}`} />
                  <span className="shrink-0 text-[11px] tabular-nums text-zinc-500 dark:text-zinc-400">
                    {row.quantity} un.
                  </span>
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

function MarginCard({ owner }: { owner: NonNullable<AdminDashboard["owner"]> }) {
  const margin = owner.margin;
  const revenue = margin?.revenueCents ?? 0;
  const segments = margin
    ? [
        { key: "cost", label: "Custo das peças", cents: margin.costCents, className: "bg-zinc-300 dark:bg-zinc-600" },
        { key: "fees", label: "Taxas Mercado Pago", cents: margin.realFeeCents, className: "bg-zinc-400 dark:bg-zinc-500" },
        { key: "margin", label: "Margem real", cents: Math.max(margin.realMarginCents, 0), className: "bg-indigo-500 dark:bg-indigo-400" },
      ]
    : [];

  return (
    <Card title="Margem" description="Receita − custo das peças − taxas, nos pedidos pagos dos últimos 30 dias.">
      {!margin ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">Banco indisponível no momento.</p>
      ) : (
        <div className="flex flex-col gap-4">
          <div>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">Margem real</p>
            <p
              className={cx(
                "text-2xl font-semibold tracking-tight",
                margin.realMarginCents >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400",
              )}
            >
              {formatCentsBRL(margin.realMarginCents)}
              <span className="ml-2 text-sm font-medium text-zinc-500 dark:text-zinc-400">
                {formatPercent(margin.realMarginCents, revenue)}
              </span>
            </p>
          </div>
          {revenue > 0 ? (
            <div className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full" role="img" aria-label="Composição da receita">
              {segments.map((segment) => (
                <div
                  key={segment.key}
                  className={cx("h-full rounded-sm", segment.className)}
                  style={{ width: `${((Math.min(segment.cents, revenue) / revenue) * 100).toFixed(1)}%` }}
                />
              ))}
            </div>
          ) : null}
          <dl className="flex flex-col gap-2 text-sm">
            <div className="flex items-center justify-between gap-3">
              <dt className="text-zinc-600 dark:text-zinc-400">Receita</dt>
              <dd className="font-medium tabular-nums text-zinc-900 dark:text-zinc-100">{formatCentsBRL(revenue)}</dd>
            </div>
            {segments.map((segment) => (
              <div key={segment.key} className="flex items-center justify-between gap-3">
                <dt className="flex items-center gap-2 text-zinc-600 dark:text-zinc-400">
                  <span aria-hidden="true" className={cx("size-2.5 rounded-sm", segment.className)} />
                  {segment.label}
                </dt>
                <dd className="tabular-nums text-zinc-900 dark:text-zinc-100">
                  {segment.key === "margin" ? formatCentsBRL(margin.realMarginCents) : `− ${formatCentsBRL(segment.cents)}`}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </Card>
  );
}

function LiaCard({
  owner,
  shared,
}: {
  owner: NonNullable<AdminDashboard["owner"]>;
  shared: AdminDashboard["shared"];
}) {
  const bot = owner.bot;
  const bridge = owner.siteBridge30d;
  const recovery = owner.recovery;
  return (
    <Card
      title="Lia & WhatsApp"
      description="A vendedora nos últimos 7 dias."
      action={
        <Link href="/admin/whatsapp" className="text-sm font-medium text-indigo-600 hover:underline dark:text-indigo-400">
          Central
        </Link>
      }
    >
      {!bot ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">Banco indisponível no momento.</p>
      ) : (
        <div className="flex flex-col gap-4">
          <dl className="grid grid-cols-2 gap-3">
            <MiniStat label="Conversas hoje" value={String(bot.conversationsToday)} />
            <MiniStat label="Esperando você" value={String(shared.attention?.conversationsAwaiting ?? "—")} />
            <MiniStat label="Pedidos pela Lia" value={String(bot.ordersByBot)} />
            <MiniStat label="Vendido pela Lia" value={formatCentsBRL(bot.ordersByBotCents)} />
          </dl>
          <div className="flex flex-col gap-2 border-t border-zinc-100 pt-3 text-xs text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">
            <p className="flex items-center gap-2">
              <Bot aria-hidden="true" className="size-3.5 shrink-0 text-zinc-400" strokeWidth={1.75} />
              {bridge
                ? bridge.taps === 0
                  ? "Pontes do site (30 dias): sem toques ainda."
                  : `Pontes do site (30 dias): ${bridge.taps} ${bridge.taps === 1 ? "toque" : "toques"} → ${bridge.conversations} ${bridge.conversations === 1 ? "conversa" : "conversas"} → ${bridge.paidOrders} ${bridge.paidOrders === 1 ? "venda paga" : "vendas pagas"} (${formatPercent(bridge.paidOrders, bridge.taps)})`
                : "Pontes do site: indisponível."}
            </p>
            {recovery && recovery.remindersSent > 0 ? (
              <p className="flex items-center gap-2">
                <MessageCircle aria-hidden="true" className="size-3.5 shrink-0 text-zinc-400" strokeWidth={1.75} />
                Recuperação: {recovery.remindersSent} {recovery.remindersSent === 1 ? "lembrete" : "lembretes"} →{" "}
                {recovery.recoveredOrders} {recovery.recoveredOrders === 1 ? "pedido pago" : "pedidos pagos"}.
              </p>
            ) : null}
          </div>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Últimos pedidos
// ---------------------------------------------------------------------------

function RecentOrdersCard({ dashboard, now }: { dashboard: AdminDashboard; now: Date }) {
  const orders = dashboard.shared.recentOrders;
  return (
    <section className="flex flex-col gap-3">
      <SectionHeading
        title="Últimos pedidos"
        action={
          <Link href="/admin/pedidos" className="text-sm font-medium text-indigo-600 hover:underline dark:text-indigo-400">
            Ver todos
          </Link>
        }
      />
      {!orders ? (
        <EmptyState title="Banco indisponível no momento" hint="Os pedidos aparecem quando a conexão voltar." />
      ) : orders.length === 0 ? (
        <EmptyState
          icon={<ShoppingBag aria-hidden="true" className="size-5" strokeWidth={1.75} />}
          title="Nenhum pedido ainda"
          hint="Quando você registrar o primeiro pedido, ele aparece aqui."
          action={
            <ButtonLink href="/admin/pedidos/novo" size="sm" icon={icon(Plus)}>
              Criar pedido
            </ButtonLink>
          }
        />
      ) : (
        <Table
          headers={["Pedido", "Cliente", "Situação", { label: "Total", align: "right" }, "Quando"]}
        >
          {orders.map((order) => (
            <Tr key={order.id}>
              <Td>
                <Link
                  href={`/admin/pedidos/${order.id}`}
                  className="font-mono text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                >
                  #{order.orderNumber}
                </Link>
              </Td>
              <Td className="max-w-56 truncate">{order.customerName ?? "—"}</Td>
              <Td>
                <StatusPill
                  dot
                  label={ORDER_STATUS_LABELS[order.status as keyof typeof ORDER_STATUS_LABELS] ?? order.status}
                  tone={orderStatusTone(order.status)}
                />
              </Td>
              <Td align="right">
                <Money cents={order.totalCents} />
              </Td>
              <Td className="whitespace-nowrap text-zinc-500 dark:text-zinc-400">
                <time dateTime={order.createdAt.toISOString()} title={formatDateTimeSP(order.createdAt)}>
                  {formatRelativeTimePtBR(order.createdAt, now)}
                </time>
              </Td>
            </Tr>
          ))}
        </Table>
      )}
    </section>
  );
}
