// Reserva gentil ("posso segurar por 24 h?") e avisos de "voltou": regras
// puras — limite de peças, prazo, lembrete, descrição para o caderninho.

export const HOLD_MAX_QUANTITY = 2;
export const HOLD_DEFAULT_TTL_HOURS = 24;
/** Lembrete único, 2 h antes de a reserva vencer. */
export const HOLD_REMINDER_BEFORE_MS = 2 * 3_600_000;

export type HoldStatus = "active" | "expired" | "released" | "converted";

export function holdExpiresAt(now: Date, ttlHours: number = HOLD_DEFAULT_TTL_HOURS): Date {
  const hours = Math.min(Math.max(ttlHours, 1), 168);
  return new Date(now.getTime() + hours * 3_600_000);
}

export function isReminderDue(
  hold: { status: string; expiresAt: Date; reminderSentAt: Date | null },
  now: Date,
): boolean {
  if (hold.status !== "active" || hold.reminderSentAt !== null) return false;
  const due = hold.expiresAt.getTime() - HOLD_REMINDER_BEFORE_MS;
  return now.getTime() >= due && now.getTime() < hold.expiresAt.getTime();
}

const whenFmt = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

export function formatHoldDeadline(expiresAt: Date): string {
  return whenFmt.format(expiresAt).replace(",", " às");
}

/** "1× Vestido Dunas (Preto · M) — guardada até 11/09 às 14:00". */
export function describeHold(hold: {
  productName: string;
  variantLabel: string;
  quantity: number;
  expiresAt: Date;
}): string {
  const label = hold.variantLabel ? ` (${hold.variantLabel})` : "";
  return `${hold.quantity}× ${hold.productName}${label} — guardada até ${formatHoldDeadline(hold.expiresAt)}`;
}
