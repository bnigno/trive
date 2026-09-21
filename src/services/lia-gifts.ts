// Gentilezas da Lia: o cupom de bolso que a vendedora pode oferecer dentro
// da cota da dona. A decisão é do core (decideLiaGift) com os fatos daqui —
// cota do dia (relógio de São Paulo), compras da cliente, última gentileza —
// e a emissão passa pelo issueCoupon (idempotente por conversa + dia). Um
// advisory lock serializa as emissões: duas conversas ao mesmo tempo não
// furam a cota.
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";

import {
  decideLiaGift,
  LIA_GIFT_DEFAULTS,
  liaGiftCode,
  liaGiftDedupeKey,
  liaGiftPolicySchema,
  type LiaGiftDecision,
  type LiaGiftPolicy,
  type LiaGiftRefusal,
} from "@/core/coupons/lia-gift";
import { auditLog, coupons, customers } from "@/db/schema";
import { spDayEnd, spDayKey, spDayStart } from "@/lib/sp-day";
import type { DbOrTx } from "@/queue/enqueue";
import { issueCoupon, quoteCoupon, type CouponQuote } from "@/services/coupons";
import { countCustomerPurchases } from "@/services/customer-lookup";
import { getSettingsMap } from "@/services/settings";

export const LIA_GIFT_SETTING_KEYS = [
  "lia_gift_enabled",
  "lia_gift_percent",
  "lia_gift_daily_quota",
  "lia_gift_min_purchases",
  "lia_gift_min_cart_cents",
  "lia_gift_days",
  "lia_gift_cooldown_days",
] as const;

export async function loadLiaGiftPolicy(db: DbOrTx): Promise<LiaGiftPolicy> {
  const map = await getSettingsMap(db, [...LIA_GIFT_SETTING_KEYS]);
  const num = (key: string, fallback: number) => (typeof map[key] === "number" ? (map[key] as number) : fallback);
  const candidate = {
    enabled: map["lia_gift_enabled"] === true,
    percent: num("lia_gift_percent", LIA_GIFT_DEFAULTS.percent),
    dailyQuota: num("lia_gift_daily_quota", LIA_GIFT_DEFAULTS.dailyQuota),
    minPurchases: num("lia_gift_min_purchases", LIA_GIFT_DEFAULTS.minPurchases),
    minCartCents: num("lia_gift_min_cart_cents", LIA_GIFT_DEFAULTS.minCartCents),
    validDays: num("lia_gift_days", LIA_GIFT_DEFAULTS.validDays),
    cooldownDays: num("lia_gift_cooldown_days", LIA_GIFT_DEFAULTS.cooldownDays),
  };
  const parsed = liaGiftPolicySchema.safeParse(candidate);
  return parsed.success ? parsed.data : { ...LIA_GIFT_DEFAULTS, enabled: candidate.enabled };
}

/** Gentilezas emitidas hoje (dia de São Paulo), em todas as conversas. */
export async function countLiaGiftsToday(db: DbOrTx, now: Date): Promise<number> {
  const day = spDayKey(now);
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(coupons)
    .where(and(eq(coupons.origin, "lia_gift"), gte(coupons.createdAt, spDayStart(day)), lt(coupons.createdAt, spDayEnd(day))));
  return row?.count ?? 0;
}

async function lastGiftAtFor(db: DbOrTx, customerId: string): Promise<Date | null> {
  const [row] = await db
    .select({ createdAt: coupons.createdAt })
    .from(coupons)
    .where(and(eq(coupons.customerId, customerId), eq(coupons.origin, "lia_gift")))
    .orderBy(desc(coupons.createdAt))
    .limit(1);
  return row?.createdAt ?? null;
}

export interface LiaGiftInput {
  conversationId: string;
  customerId: string | null;
  items: { variantId: string; quantity: number }[];
  cartSubtotalCents: number;
  motivo: string;
  now: Date;
  alreadyOfferedInConversation: boolean;
  hasValidatedCoupon: boolean;
  copilot: boolean;
  proactive: boolean;
}

export type LiaGiftPreview = LiaGiftDecision;

/** Só a decisão, sem escrever nada (o ensaio da Lia usa). */
export async function previewLiaGift(db: DbOrTx, input: LiaGiftInput): Promise<LiaGiftPreview> {
  const policy = await loadLiaGiftPolicy(db);
  return decideLiaGift(policy, await factsFor(db, policy, input));
}

async function factsFor(db: DbOrTx, policy: LiaGiftPolicy, input: LiaGiftInput) {
  return {
    now: input.now,
    customerId: input.customerId,
    priorPurchases: input.customerId && policy.minPurchases > 0 ? await countCustomerPurchases(db, input.customerId) : 0,
    cartSubtotalCents: input.cartSubtotalCents,
    issuedTodayCount: await countLiaGiftsToday(db, input.now),
    lastGiftAt: input.customerId ? await lastGiftAtFor(db, input.customerId) : null,
    alreadyOfferedInConversation: input.alreadyOfferedInConversation,
    hasValidatedCoupon: input.hasValidatedCoupon,
    copilot: input.copilot,
    proactive: input.proactive,
  };
}

export type OfferLiaGiftResult =
  | { ok: true; code: string; couponId: string; percent: number; expiresAt: Date; quote: CouponQuote; created: boolean }
  | { ok: false; refusal: LiaGiftRefusal; reason: string };

/**
 * Decide e emite. Idempotente: a mesma conversa no mesmo dia devolve o mesmo
 * cupom (retry do turno). A cota é conferida e consumida sob lock.
 */
export async function offerLiaGift(db: DbOrTx, input: LiaGiftInput): Promise<OfferLiaGiftResult> {
  const policy = await loadLiaGiftPolicy(db);
  if (!policy.enabled) return { ok: false, refusal: "disabled", reason: "recurso desligado" };
  return db.transaction(async (tx): Promise<OfferLiaGiftResult> => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('lia_gift'))`);
    // Retry do turno no mesmo dia: a gentileza desta conversa já existe —
    // devolve a mesma, sem decidir de novo (a própria emissão viraria "cooldown").
    const dedupeKey = liaGiftDedupeKey(input.conversationId, spDayKey(input.now));
    const [existing] = await tx
      .select({ id: coupons.id, code: coupons.code, value: coupons.value, expiresAt: coupons.expiresAt })
      .from(coupons)
      .where(eq(coupons.dedupeKey, dedupeKey))
      .limit(1);
    if (existing && input.customerId) {
      const quote = await quoteCoupon(tx, { code: existing.code, items: input.items, identity: { customerId: input.customerId }, now: input.now });
      return { ok: true, code: existing.code, couponId: existing.id, percent: existing.value, expiresAt: existing.expiresAt ?? input.now, quote, created: false };
    }
    const decision = decideLiaGift(policy, await factsFor(tx, policy, input));
    if (!decision.ok) return { ok: false, refusal: decision.code, reason: decision.reason };
    const customerId = input.customerId as string;
    const [customer] = await tx.select({ fullName: customers.fullName }).from(customers).where(eq(customers.id, customerId)).limit(1);
    const issued = await issueCoupon(tx, {
      dedupeKey,
      customerId,
      origin: "lia_gift",
      type: "percent",
      value: decision.percent,
      expiresAt: decision.expiresAt,
      note: input.motivo,
      conversationId: input.conversationId,
      code: liaGiftCode(customer?.fullName ?? null, input.conversationId.replace(/-/g, "").slice(0, 4)),
      minOrderCents: policy.minCartCents,
      now: input.now,
    });
    if (issued.created) {
      await tx.insert(auditLog).values({
        actorType: "system",
        actorId: null,
        action: "coupon.lia_gift",
        entityType: "coupon",
        entityId: issued.couponId,
        reason: input.motivo,
        after: { conversationId: input.conversationId, customerId, percent: decision.percent, expiresAt: decision.expiresAt.toISOString(), code: issued.code },
      });
    }
    const quote = await quoteCoupon(tx, { code: issued.code, items: input.items, identity: { customerId }, now: input.now });
    return { ok: true, code: issued.code, couponId: issued.couponId, percent: decision.percent, expiresAt: issued.expiresAt, quote, created: issued.created };
  });
}
