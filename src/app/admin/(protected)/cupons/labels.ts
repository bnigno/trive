// Rótulos do painel de cupons (servidor e cliente compartilham).
import type { Coupon, CouponOrigin } from "@/services/coupons";
import { formatCentsBRL } from "@/lib/money";

export const ORIGIN_LABELS: Record<CouponOrigin, string> = {
  manual: "Criado no painel",
  late_delivery: "Desculpas pelo atraso",
  price_protection: "Proteção de preço",
  look_photo: "Mimo pela foto",
  paper_voucher: "Vale na caixa",
  lia_gift: "Gentileza da Lia",
  referral: "Vale para uma amiga",
  referral_reward: "Prêmio da indicação",
  provador_welcome: "Boas-vindas ao Provador",
  troca: "Crédito de troca",
};

const SCOPE_LABELS = { any: "", motoboy: " (motoboy)", correios: " (Correios)" } as const;

/** '10%', 'R$ 10,00' ou 'Frete grátis (motoboy)'. */
export function formatCouponValue(coupon: Pick<Coupon, "type" | "value" | "freeShippingScope">): string {
  if (coupon.type === "free_shipping") return `Frete grátis${SCOPE_LABELS[coupon.freeShippingScope]}`;
  return coupon.type === "percent" ? `${coupon.value}%` : formatCentsBRL(coupon.value);
}
