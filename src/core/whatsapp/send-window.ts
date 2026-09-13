// Janela de envio de mensagens em lote (avisos de "voltou", convites VIP):
// nada sai fora do horário comercial da maison, e os envios em massa são
// escalonados para não parecer rajada. Tudo no "dia de São Paulo" (UTC-3
// fixo: o Brasil não tem horário de verão desde 2019). Puro.

export interface SendWindow {
  /** Hora inicial (inclusiva), 0–23, no horário de São Paulo. */
  startHour: number;
  /** Hora final (exclusiva), 1–24. */
  endHour: number;
}

export const DEFAULT_SEND_WINDOW: SendWindow = { startHour: 9, endHour: 21 };
export const DEFAULT_BULK_INTERVAL_SECONDS = 20;

const SP_OFFSET_HOURS = -3;

/** Hora cheia (0–23) em São Paulo do instante dado. */
export function spHour(now: Date): number {
  return (((now.getUTCHours() + SP_OFFSET_HOURS) % 24) + 24) % 24;
}

export function isWithinSendWindow(now: Date, window: SendWindow = DEFAULT_SEND_WINDOW): boolean {
  const hour = spHour(now);
  return hour >= window.startHour && hour < window.endHour;
}

/**
 * Próximo instante em que a janela abre: hoje às startHour (SP) se ainda não
 * passou, senão amanhã. Dentro da janela devolve o próprio `now`.
 */
export function nextSendWindowStart(now: Date, window: SendWindow = DEFAULT_SEND_WINDOW): Date {
  if (isWithinSendWindow(now, window)) return now;
  // Meia-noite UTC do dia SP corrente = 03:00 UTC; startHour SP = startHour+3 UTC.
  const spMidnightUtcMs =
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - SP_OFFSET_HOURS * 3_600_000;
  // Se em SP ainda estamos no dia anterior (00:00–02:59 UTC), volta um dia.
  const spDayStartMs = now.getTime() < spMidnightUtcMs ? spMidnightUtcMs - 86_400_000 : spMidnightUtcMs;
  const todayStart = spDayStartMs + window.startHour * 3_600_000;
  return new Date(now.getTime() < todayStart ? todayStart : todayStart + 86_400_000);
}

/** `count` instantes a partir de `from`, um a cada `intervalSeconds`. */
export function staggerSchedule(count: number, opts: { from: Date; intervalSeconds: number }): Date[] {
  const interval = Math.max(1, Math.floor(opts.intervalSeconds)) * 1000;
  return Array.from({ length: Math.max(0, count) }, (_, index) => new Date(opts.from.getTime() + index * interval));
}

/**
 * Como staggerSchedule, mas a fila NUNCA atravessa o fim da janela: o que não
 * cabe hoje continua amanhã a partir da abertura, no mesmo passo — sem
 * rajada às 9h. `from` fora da janela começa na próxima abertura.
 */
export function staggerWithinWindow(
  count: number,
  opts: { from: Date; intervalSeconds: number; window?: SendWindow },
): Date[] {
  const window = opts.window ?? DEFAULT_SEND_WINDOW;
  const interval = Math.max(1, Math.floor(opts.intervalSeconds)) * 1000;
  const slots: Date[] = [];
  let cursor = nextSendWindowStart(opts.from, window);
  for (let index = 0; index < Math.max(0, count); index += 1) {
    if (!isWithinSendWindow(cursor, window)) cursor = nextSendWindowStart(cursor, window);
    slots.push(cursor);
    cursor = new Date(cursor.getTime() + interval);
  }
  return slots;
}
