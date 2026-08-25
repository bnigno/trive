// Helpers de exibição compartilhados pelas telas de pedidos.

const dateTimeFormatter = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

/** Formata data/hora em America/Sao_Paulo como dd/mm/aaaa hh:mm. */
export function formatDateTimeSP(value: Date | string): string {
  const date = typeof value === "string" ? new Date(value) : value;
  return Number.isNaN(date.getTime())
    ? String(value)
    : dateTimeFormatter.format(date);
}

export const CHANNEL_LABELS: Record<string, string> = {
  store: "Loja",
  whatsapp: "WhatsApp",
  manual: "Manual",
};

export function channelLabel(channel: string): string {
  return CHANNEL_LABELS[channel] ?? channel;
}
