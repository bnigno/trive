// Validade dos cupons emitidos pela casa — PURO. A mensagem diz "até dd/mm":
// o cupom vale até o FIM desse dia no relógio de São Paulo (não até a hora
// em que nasceu).
import { spDayEnd, spDayKey } from "@/lib/sp-day";

export function couponExpiryAfterDays(from: Date, days: number): Date {
  const lastDay = spDayKey(new Date(from.getTime() + days * 86_400_000));
  return new Date(spDayEnd(lastDay).getTime() - 1000);
}
