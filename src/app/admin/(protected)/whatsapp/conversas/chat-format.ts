// Formatação de datas do chat: o banco guarda timestamptz UTC e a fronteira
// de exibição converte para America/Sao_Paulo (regra do projeto). Formatters
// são módulo-level porque criar Intl.DateTimeFormat é caro.
const TIME_ZONE = "America/Sao_Paulo";
const DAY_MS = 86_400_000;

const timeFormatter = new Intl.DateTimeFormat("pt-BR", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: TIME_ZONE,
});

// en-CA gera "aaaa-mm-dd": chave estável de dia para separadores e grupos.
const dayKeyFormatter = new Intl.DateTimeFormat("en-CA", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  timeZone: TIME_ZONE,
});

const weekdayFormatter = new Intl.DateTimeFormat("pt-BR", {
  weekday: "long",
  timeZone: TIME_ZONE,
});

const shortDateFormatter = new Intl.DateTimeFormat("pt-BR", {
  day: "2-digit",
  month: "2-digit",
  timeZone: TIME_ZONE,
});

const longDateFormatter = new Intl.DateTimeFormat("pt-BR", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: TIME_ZONE,
});

/** "14:32" no fuso de São Paulo. */
export function formatTimeSP(iso: string): string {
  return timeFormatter.format(new Date(iso));
}

/** Chave "aaaa-mm-dd" do dia em São Paulo — para separadores e agrupamento. */
export function dayKeySP(iso: string): string {
  return dayKeyFormatter.format(new Date(iso));
}

/** Separador do dia na thread: "Hoje", "Ontem" ou "26 de agosto de 2026". */
export function daySeparatorLabel(iso: string, now: Date = new Date()): string {
  const key = dayKeySP(iso);
  if (key === dayKeyFormatter.format(now)) return "Hoje";
  if (key === dayKeyFormatter.format(new Date(now.getTime() - DAY_MS))) {
    return "Ontem";
  }
  return longDateFormatter.format(new Date(iso));
}

/**
 * Hora da lista no estilo WhatsApp: hoje → "14:32"; ontem → "ontem"; até uma
 * semana atrás → dia da semana ("terça-feira"); mais antigo → "26/08".
 */
export function listTimestamp(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  const key = dayKeyFormatter.format(date);
  if (key === dayKeyFormatter.format(now)) return timeFormatter.format(date);
  if (key === dayKeyFormatter.format(new Date(now.getTime() - DAY_MS))) {
    return "ontem";
  }
  if (now.getTime() - date.getTime() < 7 * DAY_MS) {
    return weekdayFormatter.format(date);
  }
  return shortDateFormatter.format(date);
}

/** Iniciais para o avatar: "Maria Silva" → "MS"; sem nome → fim do telefone. */
export function initialsFor(name: string | null, phoneE164: string): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return phoneE164.replace(/\D/g, "").slice(-2) || "?";
  }
  const first = parts[0]?.charAt(0) ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.charAt(0) ?? "") : "";
  return (first + last).toUpperCase();
}
