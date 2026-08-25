// Rótulos e formatadores compartilhados das telas de preços (pt-BR).
// Módulo puro: importável tanto por server actions quanto por client components.

export const REASON_LABELS: Record<string, string> = {
  price_drop: "redução de preço",
  below_min_margin: "margem abaixo do mínimo",
  change_above_threshold: "variação acima do limite",
  below_cost: "preço abaixo do custo",
  bulk_change: "alteração em lote",
  first_price: "primeira precificação",
};

export function translateReason(reason: string): string {
  return REASON_LABELS[reason] ?? reason;
}

export function translateReasons(reasons: readonly string[]): string {
  return reasons.map(translateReason).join(", ");
}

export const ORIGIN_LABELS: Record<string, string> = {
  manual: "Manual",
  auto_cost_change: "Custo alterado",
  auto_fee_change: "Taxa alterada",
  bulk_update: "Recálculo em lote",
  initial: "Inicial",
};

export function translateOrigin(origin: string): string {
  return ORIGIN_LABELS[origin] ?? origin;
}

export const PRICE_STATUS_LABELS: Record<string, string> = {
  draft: "Rascunho",
  pending_approval: "Aguardando aprovação",
  approved: "Aprovado",
  active: "Ativo",
  rejected: "Rejeitado",
  superseded: "Substituído",
};

export function translatePriceStatus(status: string): string {
  return PRICE_STATUS_LABELS[status] ?? status;
}

export const ROUNDING_MODE_OPTIONS = [
  { value: "to_90", label: "Termina em ,90" },
  { value: "to_99", label: "Termina em ,99" },
  { value: "to_50", label: "Termina em ,50" },
  { value: "integer", label: "Real inteiro (sem centavos)" },
  { value: "none", label: "Sem arredondamento" },
] as const;

const percentFormatter = new Intl.NumberFormat("pt-BR", {
  style: "percent",
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

export function formatPercent(rate: number): string {
  return percentFormatter.format(rate);
}

export function formatSignedPercent(rate: number): string {
  return `${rate > 0 ? "+" : ""}${percentFormatter.format(rate)}`;
}

const dateTimeFormatter = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

/** dd/mm/aaaa hh:mm em America/Sao_Paulo. */
export function formatDateTime(date: Date): string {
  return dateTimeFormatter.format(date);
}

/** 12345 -> '123,45' (para defaultValue de inputs de dinheiro). */
export function centsToInputBRL(cents: number): string {
  return (cents / 100).toFixed(2).replace(".", ",");
}

/** 0.3 -> '30'; 0.325 -> '32,5' (para defaultValue de inputs de %). */
export function rateToInputPercent(rate: number): string {
  return String(Math.round(rate * 10000) / 100).replace(".", ",");
}
