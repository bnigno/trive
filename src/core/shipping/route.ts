// Rota do dia do motoboy (PURO): os pedidos pagos com janela, agrupados
// como a dona precisa ver pela manhã — "Atrasados" (dia da janela já passou
// e a peça não saiu), as janelas de HOJE em ordem de horário e o que vem
// depois. Nada de banco aqui: recebe linhas já carregadas e o dia de hoje
// em São Paulo.
import { hourLabel, minutesOf, type DeliveryWindowChoice } from "@/core/shipping/delivery-windows";
import { spDayKey, spMinutesOfDay, spNextDayKey } from "@/lib/sp-day";

/** O mínimo que a rota precisa de cada pedido (o service completa com os dados). */
export interface RouteOrderLike {
  id: string;
  window: DeliveryWindowChoice;
  /** Já saiu com o motoboy (pedido em dinheiro: sai antes de virar "pago"). */
  dispatchedAt?: Date | null;
}

export interface RouteWindowGroup<T extends RouteOrderLike> {
  /** "19h–21h" */
  label: string;
  start: string;
  end: string;
  orders: T[];
}

export interface RouteDayGroup<T extends RouteOrderLike> {
  dayKey: string;
  windows: RouteWindowGroup<T>[];
}

export interface RouteOfDay<T extends RouteOrderLike> {
  /** Na rua: saíram com o motoboy e ainda não fecharam (dinheiro na entrega). */
  out: T[];
  /** Janela em dia anterior a hoje e a peça ainda não saiu. */
  late: T[];
  /** Hoje, por janela (ordem de horário). */
  today: RouteWindowGroup<T>[];
  /** Amanhã em diante, por dia e janela (a dona enxerga o que vem). */
  upcoming: RouteDayGroup<T>[];
  /** Pedidos com janela hoje (soma das janelas) — o card "Saem hoje". */
  todayCount: number;
}

function byWindowStart<T extends RouteOrderLike>(a: T, b: T): number {
  return minutesOf(a.window.start) - minutesOf(b.window.start) || a.window.dayKey.localeCompare(b.window.dayKey);
}

function groupByWindow<T extends RouteOrderLike>(orders: readonly T[]): RouteWindowGroup<T>[] {
  const groups = new Map<string, RouteWindowGroup<T>>();
  for (const order of [...orders].sort(byWindowStart)) {
    const key = `${order.window.start}-${order.window.end}`;
    let group = groups.get(key);
    if (!group) {
      group = { label: `${hourLabel(order.window.start)}–${hourLabel(order.window.end)}`, start: order.window.start, end: order.window.end, orders: [] };
      groups.set(key, group);
    }
    group.orders.push(order);
  }
  return [...groups.values()];
}

/**
 * Agrupa os pedidos (todos ainda por sair) em atrasados / hoje / próximos.
 * A ordem dentro de cada janela é a de chegada na lista (o service manda
 * por hora do pagamento).
 */
export function groupRouteOrders<T extends RouteOrderLike>(orders: readonly T[], todayKey: string): RouteOfDay<T> {
  const out: T[] = [];
  const late: T[] = [];
  const today: T[] = [];
  const upcomingByDay = new Map<string, T[]>();
  for (const order of orders) {
    if (order.dispatchedAt) out.push(order);
    else if (order.window.dayKey < todayKey) late.push(order);
    else if (order.window.dayKey === todayKey) today.push(order);
    else {
      const list = upcomingByDay.get(order.window.dayKey) ?? [];
      list.push(order);
      upcomingByDay.set(order.window.dayKey, list);
    }
  }
  late.sort((a, b) => a.window.dayKey.localeCompare(b.window.dayKey) || byWindowStart(a, b));
  const upcoming = [...upcomingByDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dayKey, list]) => ({ dayKey, windows: groupByWindow(list) }));
  out.sort((a, b) => (a.dispatchedAt?.getTime() ?? 0) - (b.dispatchedAt?.getTime() ?? 0));
  return { out, late, today: groupByWindow(today), upcoming, todayCount: today.length };
}

/** "hoje" / "amanhã" / "sábado 20/09" para os cabeçalhos da rota. */
export function routeDayLabel(dayKey: string, todayKey: string, weekdayName: (key: string) => string): string {
  if (dayKey === todayKey) return "hoje";
  if (dayKey === spNextDayKey(todayKey)) return "amanhã";
  const [, m, d] = dayKey.split("-");
  return `${weekdayName(dayKey)} ${d}/${m}`;
}

/**
 * O pagamento entrou depois da hora-limite da janela (Pix tem até 2 h para
 * cair)? A promessa "hoje" não vale mais por direito — a dona decide se
 * ainda dá ou reagenda. No relógio de São Paulo.
 */
export function isPaidAfterCutoff(paidAt: Date | null, window: DeliveryWindowChoice): boolean {
  if (!paidAt) return false;
  const paidDay = spDayKey(paidAt);
  if (paidDay > window.dayKey) return true;
  if (paidDay < window.dayKey) return false;
  return spMinutesOfDay(paidAt) >= minutesOf(window.cutoff);
}
