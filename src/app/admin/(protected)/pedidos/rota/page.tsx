import type { Metadata } from "next";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Money } from "@/components/ui/money";
import { PageHeader } from "@/components/ui/page-header";
import { hourLabel, minutesOf } from "@/core/shipping/delivery-windows";
import { routeDayLabel, type RouteWindowGroup } from "@/core/shipping/route";
import { getDb } from "@/db/client";
import { waMeUrl } from "@/lib/phone";
import { spDayLabel, spMinutesOfDay, spNextDayKey, spWeekdayName } from "@/lib/sp-day";
import { requireUser } from "@/services/auth";
import { listMotoboyWindows, listRouteOfDay, paymentLabelOf, type RouteOrder } from "@/services/delivery-routes";
import { formatDateTimeSP } from "../format";
import { DispatchForm, RescheduleForm, type RescheduleChoice } from "./forms";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Rota do dia",
};

/**
 * Hoje (só as janelas que ainda não terminaram) e os próximos 3 dias × cada
 * janela ativa: as opções do "Reagendar". Faixas com a mesma janela viram
 * uma opção só.
 */
function rescheduleChoices(todayKey: string, nowMinutes: number, rates: { rateName: string; windows: { start: string; end: string; cutoff: string }[] }[]): RescheduleChoice[] {
  const choices = new Map<string, RescheduleChoice>();
  let dayKey = todayKey;
  for (let i = 0; i < 4; i += 1) {
    const dayLabel = routeDayLabel(dayKey, todayKey, spWeekdayName);
    for (const rate of rates) {
      for (const w of rate.windows) {
        if (dayKey === todayKey && minutesOf(w.end) <= nowMinutes) continue;
        const value = `${dayKey}|${w.start}|${w.end}|${w.cutoff}`;
        if (!choices.has(value)) choices.set(value, { value, label: `${dayLabel}, ${hourLabel(w.start)}–${hourLabel(w.end)}` });
      }
    }
    dayKey = spNextDayKey(dayKey);
  }
  return [...choices.values()];
}

function statusBadge(order: RouteOrder) {
  if (order.status === "preparing") return <Badge tone="info">Em separação</Badge>;
  if (order.status === "pending_payment") return <Badge tone="warning">Paga ao receber</Badge>;
  return <Badge tone="warning">Pago</Badge>;
}

function OrderCard({ order, todayKey, choices, late }: { order: RouteOrder; todayKey: string; choices: RescheduleChoice[]; late: boolean }) {
  const wa = waMeUrl(order.phoneE164);
  const out = order.dispatchedAt !== null;
  const needsLook = !out && (late || order.paidAfterCutoff);
  return (
    <li className="flex flex-col gap-3 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Link href={`/admin/pedidos/${order.id}`} className="text-base font-semibold text-indigo-600 hover:underline dark:text-indigo-400">
            #{order.orderNumber}
          </Link>
          <p className="truncate text-sm text-zinc-900 dark:text-zinc-100">{order.customerName}</p>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            {order.itemsCount} {order.itemsCount === 1 ? "peça" : "peças"} · <Money cents={order.totalCents} /> · {paymentLabelOf(order.paymentMethod)}
            {order.paidAt ? <span className="block">pago {formatDateTimeSP(order.paidAt)}</span> : null}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {statusBadge(order)}
          {out || order.window.dayKey !== todayKey ? <Badge tone={late ? "danger" : "neutral"}>{order.windowLabel}</Badge> : null}
          {!out && order.paidAfterCutoff ? <Badge tone="danger">pagou depois das {hourLabel(order.window.cutoff)}</Badge> : null}
          {order.collectCashCents !== null ? (
            <Badge tone="warning">
              receber{" "}
              <Money cents={order.collectCashCents} />
              {" "}em dinheiro
            </Badge>
          ) : null}
          {order.isGift ? <Badge tone="warning">🎁 Presente · sem preço</Badge> : null}
          {!order.packagePhotoPath ? <Badge tone="neutral">sem foto do pacote</Badge> : null}
        </div>
      </div>

      <div className="text-sm text-zinc-800 dark:text-zinc-200">
        {order.addressLine ? <p>{order.addressLine}</p> : <p className="text-zinc-500">Endereço não gravado no pedido.</p>}
        {order.postalCode ? <p className="text-xs text-zinc-500 dark:text-zinc-400">CEP {order.postalCode.replace(/^(\d{5})(\d{3})$/, "$1-$2")}</p> : null}
      </div>

      <ul className="text-xs text-zinc-600 dark:text-zinc-400">
        {order.itemsSummary.map((line, index) => (
          <li key={index}>{line}</li>
        ))}
      </ul>

      <div className="flex flex-wrap items-center gap-3">
        {out ? (
          <Link href={`/admin/pedidos/${order.id}`} className="text-sm font-medium text-indigo-600 hover:underline dark:text-indigo-400">
            Saiu {order.dispatchedAt ? formatDateTimeSP(order.dispatchedAt) : ""} — registrar pagamento e entrega
          </Link>
        ) : late ? (
          <p className="text-xs text-red-700 dark:text-red-300">A janela passou: reagende abaixo antes de marcar que saiu.</p>
        ) : (
          <DispatchForm orderId={order.id} customerName={order.customerName} compact />
        )}
        {wa ? (
          <a href={wa} target="_blank" rel="noopener noreferrer" className="text-sm font-medium text-indigo-600 hover:underline dark:text-indigo-400">
            WhatsApp da cliente
          </a>
        ) : null}
      </div>
      {needsLook ? <RescheduleForm orderId={order.id} choices={choices} /> : null}
    </li>
  );
}

function WindowSection({ group, todayKey, choices }: { group: RouteWindowGroup<RouteOrder>; todayKey: string; choices: RescheduleChoice[] }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold tracking-wide text-zinc-700 uppercase dark:text-zinc-300">
        {group.label} <span className="font-normal text-zinc-500">· {group.orders.length}</span>
      </h2>
      <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {group.orders.map((order) => (
          <OrderCard key={order.id} order={order} todayKey={todayKey} choices={choices} late={false} />
        ))}
      </ul>
    </section>
  );
}

// Rota do dia: o que sai com o motoboy hoje, por janela, com endereço,
// telefone, o que receber e o botão "Saiu". Atrasados primeiro (janela de
// ontem ou antes); depois o que vem. Sem regra aqui: listRouteOfDay.
export default async function RotaPage() {
  await requireUser();
  const db = getDb();
  const now = new Date();
  const [route, rates] = await Promise.all([listRouteOfDay(db, { now }), listMotoboyWindows(db)]);
  const choices = rescheduleChoices(route.todayKey, spMinutesOfDay(now), rates);
  const empty = route.out.length === 0 && route.late.length === 0 && route.today.length === 0 && route.upcoming.length === 0;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Rota do dia"
        subtitle={`${spDayLabel(route.todayKey)} · ${route.todayCount} ${route.todayCount === 1 ? "pedido sai" : "pedidos saem"} hoje${route.late.length ? ` · ${route.late.length} atrasado${route.late.length > 1 ? "s" : ""}` : ""}`}
        actions={
          <Link href="/admin/pedidos" className="text-sm text-zinc-600 hover:underline dark:text-zinc-400">
            ← Todos os pedidos
          </Link>
        }
      />

      {empty ? (
        <EmptyState
          title="Nenhuma entrega por motoboy na fila."
          hint="Pedidos pagos com janela de entrega aparecem aqui, agrupados por horário. A faixa Motoboy se cadastra em Frete."
        />
      ) : null}

      {route.out.length > 0 ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold tracking-wide text-zinc-700 uppercase dark:text-zinc-300">
            Na rua <span className="font-normal text-zinc-500">· {route.out.length} — dinheiro na entrega; ao receber, registre o pagamento no pedido</span>
          </h2>
          <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {route.out.map((order) => (
              <OrderCard key={order.id} order={order} todayKey={route.todayKey} choices={choices} late={false} />
            ))}
          </ul>
        </section>
      ) : null}

      {route.late.length > 0 ? (
        <section className="flex flex-col gap-3 rounded-lg border border-red-200 bg-red-50/40 p-4 dark:border-red-900 dark:bg-red-950/20">
          <h2 className="text-sm font-semibold tracking-wide text-red-800 uppercase dark:text-red-300">
            Atrasados <span className="font-normal text-red-700/70 dark:text-red-300/70">· {route.late.length} — a janela passou e a peça não saiu; reagende e avise a cliente</span>
          </h2>
          <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {route.late.map((order) => (
              <OrderCard key={order.id} order={order} todayKey={route.todayKey} choices={choices} late />
            ))}
          </ul>
        </section>
      ) : null}

      {route.today.map((group) => (
        <WindowSection key={group.label} group={group} todayKey={route.todayKey} choices={choices} />
      ))}

      {route.upcoming.map((day) => (
        <section key={day.dayKey} className="flex flex-col gap-4 border-t border-zinc-200 pt-6 dark:border-zinc-800">
          <h2 className="text-sm font-semibold tracking-wide text-zinc-500 uppercase dark:text-zinc-400">
            {routeDayLabel(day.dayKey, route.todayKey, spWeekdayName)}
          </h2>
          {day.windows.map((group) => (
            <WindowSection key={`${day.dayKey}-${group.label}`} group={group} todayKey={route.todayKey} choices={choices} />
          ))}
        </section>
      ))}
    </div>
  );
}
