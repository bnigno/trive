// As frases que a cliente lê quando o cupom não vale (ou vale "com
// confirmação"). Ficam aqui, no core, para loja, checkout e Lia falarem a
// mesma língua.
import { formatCentsBRL } from "@/lib/money";

import type { CouponErrorCode, CouponRule, PendingCheck } from "./evaluate";

function minuteLabel(minute: number): string {
  const hh = Math.floor(minute / 60);
  const mm = minute % 60;
  return mm === 0 ? `${hh}h` : `${hh}h${String(mm).padStart(2, "0")}`;
}

const WEEKDAY_SHORT = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"] as const;

/** "14h–15h", "sáb·dom", "sex 18h–22h" — a janela do cupom em uma etiqueta. */
export function scheduleLabel(
  rule: Pick<CouponRule, "validWeekdays" | "validFromMinute" | "validToMinute">,
): string | null {
  const parts: string[] = [];
  if (rule.validWeekdays !== null && rule.validWeekdays.length > 0) {
    parts.push([...rule.validWeekdays].sort((a, b) => a - b).map((d) => WEEKDAY_SHORT[d] ?? String(d)).join("·"));
  }
  if (rule.validFromMinute !== null && rule.validToMinute !== null) {
    parts.push(`${minuteLabel(rule.validFromMinute)}–${minuteLabel(rule.validToMinute)}`);
  }
  return parts.length === 0 ? null : parts.join(" ");
}

export function couponErrorMessage(
  code: CouponErrorCode,
  rule: Pick<CouponRule, "code" | "minOrderCents" | "freeShippingScope" | "validWeekdays" | "validFromMinute" | "validToMinute"> & { code: string },
): string {
  switch (code) {
    case "COUPON_NOT_FOUND":
      return `Cupom "${rule.code}" não existe. Confira o código e tente de novo.`;
    case "COUPON_INACTIVE":
      return "Este cupom não está mais ativo.";
    case "COUPON_NOT_STARTED":
      return "Este cupom ainda não está em vigência. Tente novamente mais tarde.";
    case "COUPON_EXPIRED":
      return "Este cupom expirou.";
    case "COUPON_EXHAUSTED":
      return "Este cupom esgotou: o limite de usos já foi atingido.";
    case "COUPON_WRONG_WEEKDAY":
      return `Este cupom vale só em alguns dias da semana (${scheduleLabel({ ...rule, validFromMinute: null, validToMinute: null }) ?? "outros dias"}).`;
    case "COUPON_OUTSIDE_HOURS":
      return `Este cupom vale só das ${scheduleLabel({ ...rule, validWeekdays: null }) ?? "em outro horário"}.`;
    case "COUPON_NOT_YOURS":
      return "Este cupom é pessoal e foi feito para outra cliente.";
    case "COUPON_FIRST_PURCHASE_ONLY":
      return "Este cupom vale só para a primeira compra.";
    case "COUPON_CUSTOMER_LIMIT":
      return "Você já usou este cupom o número de vezes que ele permite.";
    case "COUPON_MIN_ORDER":
      return `Este cupom vale para pedidos a partir de ${formatCentsBRL(rule.minOrderCents)}.`;
    case "COUPON_NO_ELIGIBLE_ITEMS":
      return "Este cupom vale só para algumas peças, e nenhuma delas está na sacola.";
    case "COUPON_SHIPPING_SCOPE":
      return rule.freeShippingScope === "motoboy"
        ? "Este cupom de frete grátis vale só para entrega por motoboy."
        : "Este cupom de frete grátis vale só para envio pelos Correios.";
  }
}

/** Uma frase discreta para a sacola: o que ainda será confirmado no fechamento. */
export function pendingNotice(pending: readonly PendingCheck[]): string | null {
  if (pending.length === 0) return null;
  const parts: string[] = [];
  if (pending.includes("personal")) parts.push("que este cupom é seu");
  if (pending.includes("first_purchase")) parts.push("que esta é a sua primeira compra");
  if (pending.includes("customer_limit")) parts.push("que você ainda não usou este cupom");
  if (pending.includes("shipping_scope")) parts.push("o frete grátis ao escolher a entrega");
  if (parts.length === 1) return `Confirmamos no fechamento ${parts[0]}.`;
  const last = parts.pop();
  return `Confirmamos no fechamento ${parts.join(", ")} e ${last}.`;
}
