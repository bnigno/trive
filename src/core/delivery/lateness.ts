// A entrega atrasou? — PURO. A promessa é a janela do pedido ("sábado 20/09,
// entre 19h e 21h", no relógio de São Paulo); o real é a hora em que o
// motoboy tocou "Entregue". Passou do fim da janela mais a carência da dona,
// atrasou — e a casa pede desculpas com um cupom.
import { hourLabel, minutesOf } from "@/core/shipping/delivery-windows";
import { isSpDayKey, spDateTime, spDayLabel } from "@/lib/sp-day";

export interface LatenessInput {
  /** A janela prometida (orders.delivery_window); null = pedido sem janela (Correios). */
  window: { dayKey: string; start: string; end: string } | null;
  deliveredAt: Date;
  /** Minutos de tolerância depois do fim da janela. */
  graceMinutes: number;
}

export interface Lateness {
  late: boolean;
  /** Minutos depois do FIM da janela (0 quando dentro dela ou antes). */
  minutesLate: number;
  promisedEndAt: Date | null;
}

export function assessLateness(input: LatenessInput): Lateness {
  if (!input.window || !isSpDayKey(input.window.dayKey)) return { late: false, minutesLate: 0, promisedEndAt: null };
  let promisedEndAt: Date;
  try {
    promisedEndAt = spDateTime(input.window.dayKey, minutesOf(input.window.end));
  } catch {
    return { late: false, minutesLate: 0, promisedEndAt: null };
  }
  const minutesLate = Math.max(0, Math.floor((input.deliveredAt.getTime() - promisedEndAt.getTime()) / 60_000));
  return { late: minutesLate > input.graceMinutes, minutesLate, promisedEndAt };
}

/** "42 min" / "2 h 10 min" / "3 h". */
export function minutesLateLabel(minutesLate: number): string {
  const hours = Math.floor(minutesLate / 60);
  const minutes = minutesLate % 60;
  if (hours === 0) return `${minutes} min`;
  return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
}

/** "Entrega 42 min depois da janela (sábado, 20 de setembro, 19h–21h)". */
export function lateDeliveryNote(input: { minutesLate: number; window: { dayKey: string; start: string; end: string } }): string {
  const day = isSpDayKey(input.window.dayKey) ? spDayLabel(input.window.dayKey) : input.window.dayKey;
  return `Entrega ${minutesLateLabel(input.minutesLate)} depois da janela (${day}, ${hourLabel(input.window.start)}–${hourLabel(input.window.end)})`;
}

/** O cupom de desculpas vale N dias a partir da entrega. */
export function lateDeliveryCouponExpiry(deliveredAt: Date, days: number): Date {
  return new Date(deliveredAt.getTime() + days * 86_400_000);
}
