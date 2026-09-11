// Transferência para a equipe e volta à vendedora — regras PURAS.
//
// Depois de transferir, a vendedora fica em silêncio por N horas
// (handoff_silence_hours). Uma conversa "com você" sem NENHUMA mensagem, sua
// ou da cliente, por M horas volta sozinha para a vendedora
// (handoff_auto_return_hours; 0 = nunca) — a cliente não fica sem resposta
// para sempre porque a equipe não viu a conversa.

export const DEFAULT_HANDOFF_SILENCE_HOURS = 24;
export const DEFAULT_HANDOFF_AUTO_RETURN_HOURS = 12;
/** Uma semana: acima disso a cliente ficaria sem resposta tempo demais. */
export const HANDOFF_HOURS_MAX = 168;

const HOUR_MS = 60 * 60_000;

/** Valor de setting em horas, saneado: inteiro entre `min` e o teto; senão o padrão. */
export function hoursSetting(value: unknown, fallback: number, opts: { min: number }): number {
  if (typeof value !== "number" || !Number.isInteger(value)) return fallback;
  if (value < opts.min || value > HANDOFF_HOURS_MAX) return fallback;
  return value;
}

export function silenceUntil(now: Date, hours: number): Date {
  return new Date(now.getTime() + hours * HOUR_MS);
}

/** Último sinal de vida da conversa: mensagem dela, mensagem sua ou a própria transferência. */
export function lastActivityAt(conversation: {
  lastInboundAt: Date | null;
  lastOutboundAt: Date | null;
  updatedAt: Date;
}): Date {
  const times = [conversation.lastInboundAt, conversation.lastOutboundAt, conversation.updatedAt]
    .filter((value): value is Date => value instanceof Date)
    .map((value) => value.getTime());
  return new Date(Math.max(...times));
}

/** `hours` ≤ 0 = nunca volta sozinha. */
export function isIdleForHours(lastActivity: Date, now: Date, hours: number): boolean {
  if (hours <= 0) return false;
  return now.getTime() - lastActivity.getTime() >= hours * HOUR_MS;
}
