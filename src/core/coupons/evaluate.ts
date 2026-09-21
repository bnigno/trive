// O que um cupom vale para uma sacola — PURO. Aqui mora a única regra de
// cupom da casa: loja, checkout, Lia e o fechamento do pedido montam o
// contexto e chamam evaluateCoupon. Nada de banco, relógio ou fetch: quem
// chama diz que horas são e quem é a cliente.
//
// Regras por cliente (cupom pessoal, primeira compra, limite por cliente)
// só se decidem com identidade: na sacola anônima ficam PENDENTES e o
// fechamento do pedido é quem confirma.
import { spDayKey, spMinutesOfDay, weekdayIndexSP } from "@/lib/sp-day";

import { collectiveValue, isCollective } from "./collective";
import { effectiveValue, type ValueStep } from "./schedule";

export type CouponType = "percent" | "fixed" | "free_shipping";
export type FreeShippingScope = "any" | "motoboy" | "correios";
export type ShippingKind = "motoboy" | "correios";

/** O cupom como o core o enxerga (o service traduz a linha do banco + N:N). */
export interface CouponRule {
  id: string;
  code: string;
  type: CouponType;
  value: number;
  minOrderCents: number;
  startsAt: Date | null;
  expiresAt: Date | null;
  maxUses: number | null;
  usedCount: number;
  isActive: boolean;
  perCustomerLimit: number | null;
  customerId: string | null;
  phoneE164: string | null;
  firstPurchaseOnly: boolean;
  freeShippingScope: FreeShippingScope;
  /** 0 = domingo … 6 = sábado (calendário de São Paulo); null = todo dia. */
  validWeekdays: number[] | null;
  /** Minutos de São Paulo, início inclusivo; null = o dia todo. */
  validFromMinute: number | null;
  /** Fim exclusivo (900 = 15:00). */
  validToMinute: number | null;
  productIds: string[];
  categoryIds: string[];
  /** Degraus do cupom que muda com o tempo (core/coupons/schedule); null = valor fixo. */
  valueSchedule: ValueStep[] | null;
  /** Cupom da turma (core/coupons/collective): 0 = comum. */
  growthPerRedeemer: number;
  growthCap: number | null;
  createdAt: Date;
}

export interface CouponContextItem {
  productId: string;
  categoryId: string | null;
  unitPriceCents: number;
  quantity: number;
}

export interface CouponIdentity {
  customerId: string | null;
  phoneE164: string | null;
}

export interface CouponContext {
  now: Date;
  items: CouponContextItem[];
  /** null = entrega ainda não escolhida (sacola sem CEP, Lia antes de cotar). */
  shipping: { cents: number; kind: ShippingKind } | null;
  /** null = cliente anônima (sacola): as regras por cliente ficam pendentes. */
  identity: CouponIdentity | null;
  /** Compras de verdade da cliente (countsAsPurchase); null = desconhecido. */
  priorPurchases: number | null;
  /** Resgates NÃO devolvidos desta cliente neste cupom; null = desconhecido. */
  priorRedemptionsByThisCustomer: number | null;
  /** Reservado ao cupom da turma: clientes distintas que já resgataram. */
  distinctRedeemers?: number;
}

/** O que só o fechamento (com CPF/telefone e entrega escolhida) confirma. */
export type PendingCheck = "personal" | "first_purchase" | "customer_limit" | "shipping_scope";

export type CouponErrorCode =
  | "COUPON_NOT_FOUND"
  | "COUPON_INACTIVE"
  | "COUPON_NOT_STARTED"
  | "COUPON_EXPIRED"
  | "COUPON_EXHAUSTED"
  | "COUPON_WRONG_WEEKDAY"
  | "COUPON_OUTSIDE_HOURS"
  | "COUPON_NOT_YOURS"
  | "COUPON_FIRST_PURCHASE_ONLY"
  | "COUPON_CUSTOMER_LIMIT"
  | "COUPON_MIN_ORDER"
  | "COUPON_NO_ELIGIBLE_ITEMS"
  | "COUPON_SHIPPING_SCOPE";

export type CouponEvaluation =
  | {
      ok: true;
      /** Desconto sobre as peças elegíveis (0 em free_shipping). */
      discountCents: number;
      /** O valor do cupom usado (10 = "10%", 2000 = R$ 20,00; 0 em frete grátis). */
      appliedValue: number;
      freeShipping: boolean;
      /** Frete perdoado: o valor da entrega quando ela já é conhecida; senão 0. */
      shippingDiscountCents: number;
      eligibleSubtotalCents: number;
      subtotalCents: number;
      pending: PendingCheck[];
    }
  | { ok: false; code: CouponErrorCode };

export function isPersonal(rule: Pick<CouponRule, "customerId" | "phoneE164">): boolean {
  return rule.customerId !== null || rule.phoneE164 !== null;
}

export function hasItemRestriction(rule: Pick<CouponRule, "productIds" | "categoryIds">): boolean {
  return rule.productIds.length > 0 || rule.categoryIds.length > 0;
}

/** Cupom vale agora, no relógio de São Paulo (dia da semana e faixa de minutos). */
export function isWithinSchedule(
  rule: Pick<CouponRule, "validWeekdays" | "validFromMinute" | "validToMinute">,
  now: Date,
): { weekday: boolean; hours: boolean } {
  const weekday =
    rule.validWeekdays === null ||
    rule.validWeekdays.length === 0 ||
    rule.validWeekdays.includes(weekdayIndexSP(spDayKey(now)));
  const minute = spMinutesOfDay(now);
  const hours =
    rule.validFromMinute === null ||
    rule.validToMinute === null ||
    (minute >= rule.validFromMinute && minute < rule.validToMinute);
  return { weekday, hours };
}

export function subtotalOf(items: readonly CouponContextItem[]): number {
  return items.reduce((sum, item) => sum + item.unitPriceCents * item.quantity, 0);
}

/** Só as peças que o cupom cobre (todas, quando o cupom não restringe). */
export function eligibleSubtotalCents(
  rule: Pick<CouponRule, "productIds" | "categoryIds">,
  items: readonly CouponContextItem[],
): number {
  if (!hasItemRestriction(rule)) return subtotalOf(items);
  return subtotalOf(
    items.filter(
      (item) =>
        rule.productIds.includes(item.productId) ||
        (item.categoryId !== null && rule.categoryIds.includes(item.categoryId)),
    ),
  );
}

function identityMatches(rule: CouponRule, identity: CouponIdentity): boolean {
  if (rule.customerId !== null && identity.customerId !== null && rule.customerId === identity.customerId) return true;
  if (rule.phoneE164 !== null && identity.phoneE164 !== null && rule.phoneE164 === identity.phoneE164) return true;
  return false;
}

export function evaluateCoupon(rule: CouponRule, ctx: CouponContext): CouponEvaluation {
  if (!rule.isActive) return { ok: false, code: "COUPON_INACTIVE" };
  if (rule.startsAt !== null && ctx.now.getTime() < rule.startsAt.getTime()) {
    return { ok: false, code: "COUPON_NOT_STARTED" };
  }
  if (rule.expiresAt !== null && ctx.now.getTime() > rule.expiresAt.getTime()) {
    return { ok: false, code: "COUPON_EXPIRED" };
  }
  if (rule.maxUses !== null && rule.usedCount >= rule.maxUses) {
    return { ok: false, code: "COUPON_EXHAUSTED" };
  }

  const schedule = isWithinSchedule(rule, ctx.now);
  if (!schedule.weekday) return { ok: false, code: "COUPON_WRONG_WEEKDAY" };
  if (!schedule.hours) return { ok: false, code: "COUPON_OUTSIDE_HOURS" };

  const pending: PendingCheck[] = [];

  if (isPersonal(rule)) {
    if (ctx.identity === null) pending.push("personal");
    else if (!identityMatches(rule, ctx.identity)) return { ok: false, code: "COUPON_NOT_YOURS" };
  }

  if (rule.firstPurchaseOnly) {
    if (ctx.priorPurchases === null) pending.push("first_purchase");
    else if (ctx.priorPurchases > 0) return { ok: false, code: "COUPON_FIRST_PURCHASE_ONLY" };
  }

  if (rule.perCustomerLimit !== null) {
    if (ctx.priorRedemptionsByThisCustomer === null) pending.push("customer_limit");
    else if (ctx.priorRedemptionsByThisCustomer >= rule.perCustomerLimit) {
      return { ok: false, code: "COUPON_CUSTOMER_LIMIT" };
    }
  }

  const subtotalCents = subtotalOf(ctx.items);
  if (subtotalCents < rule.minOrderCents) return { ok: false, code: "COUPON_MIN_ORDER" };

  const eligible = eligibleSubtotalCents(rule, ctx.items);
  if (hasItemRestriction(rule) && eligible === 0) return { ok: false, code: "COUPON_NO_ELIGIBLE_ITEMS" };

  if (rule.type === "free_shipping") {
    if (rule.freeShippingScope !== "any") {
      if (ctx.shipping === null) pending.push("shipping_scope");
      else if (ctx.shipping.kind !== rule.freeShippingScope) {
        return { ok: false, code: "COUPON_SHIPPING_SCOPE" };
      }
    }
    return {
      ok: true,
      discountCents: 0,
      appliedValue: 0,
      freeShipping: true,
      shippingDiscountCents: ctx.shipping?.cents ?? 0,
      eligibleSubtotalCents: eligible,
      subtotalCents,
      pending,
    };
  }

  // O valor de HOJE: cupom da turma cresce com as amigas; degraus por tempo
  // com o calendário; sem mecânica é o da coluna.
  const value = isCollective(rule) ? collectiveValue(rule, ctx.distinctRedeemers ?? 0) : effectiveValue(rule, ctx.now);
  const discountCents =
    rule.type === "percent"
      ? Math.floor((eligible * value) / 100)
      : Math.min(value, eligible);

  return {
    ok: true,
    discountCents,
    appliedValue: value,
    freeShipping: false,
    shippingDiscountCents: 0,
    eligibleSubtotalCents: eligible,
    subtotalCents,
    pending,
  };
}
