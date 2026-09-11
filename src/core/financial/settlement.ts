// Previsão de repasse do Mercado Pago — PURO. A taxa cobrada vira um
// lançamento a pagar com vencimento no dia previsto do repasse (dia do
// pagamento + settlement_days da regra de taxa), e o financeiro agrupa por
// dia o líquido (total − taxa) que ainda vai cair na conta.
import { spDayKey, spDayLabel, spDayStart } from "@/lib/sp-day";

const DAY_MS = 86_400_000;

/** 'YYYY-MM-DD' (dia de São Paulo) do repasse previsto. */
export function expectedSettlementDayKey(paidAt: Date, settlementDays: number): string {
  const days = Math.max(0, Math.floor(settlementDays));
  const base = spDayStart(spDayKey(paidAt));
  return spDayKey(new Date(base.getTime() + days * DAY_MS + DAY_MS / 2));
}

export type SettlementRow = {
  entryId: string;
  dueDate: string;
  orderId: string;
  orderNumber: number;
  grossCents: number;
  feeCents: number;
  paymentMethod: string | null;
  installments: number | null;
};

export type SettlementDay = {
  dayKey: string;
  label: string;
  grossCents: number;
  feeCents: number;
  netCents: number;
  orders: SettlementRow[];
};

export type SettlementForecast = {
  days: SettlementDay[];
  totalGrossCents: number;
  totalFeeCents: number;
  totalNetCents: number;
};

/** Agrupa por dia (crescente), somando em centavos; líquido = bruto − taxa. */
export function groupSettlementForecast(rows: readonly SettlementRow[]): SettlementForecast {
  const byDay = new Map<string, SettlementRow[]>();
  for (const row of rows) {
    const list = byDay.get(row.dueDate) ?? [];
    list.push(row);
    byDay.set(row.dueDate, list);
  }
  const days = [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dayKey, orders]) => {
      const grossCents = orders.reduce((sum, row) => sum + row.grossCents, 0);
      const feeCents = orders.reduce((sum, row) => sum + row.feeCents, 0);
      return {
        dayKey,
        label: spDayLabel(dayKey),
        grossCents,
        feeCents,
        netCents: grossCents - feeCents,
        orders: [...orders].sort((a, b) => a.orderNumber - b.orderNumber),
      };
    });
  const totalGrossCents = days.reduce((sum, day) => sum + day.grossCents, 0);
  const totalFeeCents = days.reduce((sum, day) => sum + day.feeCents, 0);
  return { days, totalGrossCents, totalFeeCents, totalNetCents: totalGrossCents - totalFeeCents };
}
