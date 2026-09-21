// Os vales de papel na caixa: "para você" (cupom pessoal da compradora) e
// "para uma amiga" (vale aberto, primeira compra, 1 por cliente, até 3 usos,
// com quem indicou). Nascem quando os cartões da edição são gerados — o
// código tem de estar na imagem —, idempotentes pela dedupe_key (gerar de
// novo reaproveita). Quando a amiga PAGA um pedido com o vale, quem indicou
// ganha o prêmio (referral_reward) e o aviso; cancelado/reembolsado o pedido
// de origem, os vales não usados são desativados.
import { and, eq } from "drizzle-orm";

import { couponExpiryAfterDays } from "@/core/coupons/expiry";
import { debutFirstName } from "@/core/edition/debut";
import { REFERRAL_MAX_USES, voucherPlan, voucherQrText, type VoucherCardData, type VoucherKind } from "@/core/edition/voucher";
import { auditLog, coupons, customers, orders } from "@/db/schema";
import { STORE_NAME_DEFAULT } from "@/lib/brand";
import { waMeUrl } from "@/lib/phone";
import type { DbOrTx } from "@/queue/enqueue";
import { enqueueCouponIssued } from "@/services/coupon-notices";
import { issueCoupon } from "@/services/coupons";
import { getSettingsMap } from "@/services/settings";

export interface PaperVoucherSettings {
  enabled: boolean;
  /** "Para você". */
  percent: number;
  /** "Para uma amiga" (a amiga). */
  referralPercent: number;
  /** O prêmio de quem indicou. */
  rewardPercent: number;
  /** Validade dos três, contada da geração (o papel diz "até dd/mm"). */
  days: number;
}

export const PAPER_VOUCHER_DEFAULTS: PaperVoucherSettings = { enabled: false, percent: 10, referralPercent: 10, rewardPercent: 10, days: 45 };

const SETTING_KEYS = ["paper_voucher_enabled", "paper_voucher_percent", "referral_percent", "referral_reward_percent", "paper_voucher_days"] as const;

export async function loadPaperVoucherSettings(db: DbOrTx): Promise<PaperVoucherSettings> {
  const map = await getSettingsMap(db, [...SETTING_KEYS]);
  const num = (key: string, fallback: number) => (typeof map[key] === "number" ? (map[key] as number) : fallback);
  return {
    enabled: map["paper_voucher_enabled"] === true,
    percent: num("paper_voucher_percent", PAPER_VOUCHER_DEFAULTS.percent),
    referralPercent: num("referral_percent", PAPER_VOUCHER_DEFAULTS.referralPercent),
    rewardPercent: num("referral_reward_percent", PAPER_VOUCHER_DEFAULTS.rewardPercent),
    days: num("paper_voucher_days", PAPER_VOUCHER_DEFAULTS.days),
  };
}

/** Pedidos que ganham vale: pagos e de pé. */
const VOUCHER_STATUSES = new Set(["paid", "preparing", "shipped", "delivered"]);

const dateFormatter = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit" });

interface VoucherContext {
  storeName: string;
  sellerName: string;
  editionName: string | null;
  storeWhatsapp: string | null;
}

async function voucherContext(db: DbOrTx): Promise<VoucherContext> {
  const map = await getSettingsMap(db, ["store_name", "bot_seller_name", "edition_name", "store_whatsapp"]);
  const text = (key: string) => (typeof map[key] === "string" ? (map[key] as string).trim() : "");
  return {
    storeName: text("store_name") || STORE_NAME_DEFAULT,
    sellerName: text("bot_seller_name") || "Lia",
    editionName: text("edition_name") || null,
    storeWhatsapp: text("store_whatsapp") || null,
  };
}

function toCardData(
  kind: VoucherKind,
  coupon: { code: string; value: number; expiresAt: Date | null },
  firstName: string,
  ctx: VoucherContext,
): VoucherCardData | null {
  const qrUrl = waMeUrl(ctx.storeWhatsapp, voucherQrText(ctx.sellerName, coupon.code));
  if (!qrUrl) return null;
  return {
    kind,
    code: coupon.code,
    percent: coupon.value,
    expiresLabel: coupon.expiresAt ? `até ${dateFormatter.format(coupon.expiresAt)}` : "",
    firstName,
    storeName: ctx.storeName,
    editionName: ctx.editionName,
    qrUrl,
  };
}

const ORIGIN_BY_KIND: Record<VoucherKind, "paper_voucher" | "referral"> = { para_voce: "paper_voucher", para_uma_amiga: "referral" };

/** Os vales JÁ emitidos deste pedido, como cartões (para a tela e a impressão digital). */
export async function existingOrderVouchers(db: DbOrTx, orderId: string): Promise<VoucherCardData[]> {
  const [order] = await db
    .select({ customerName: customers.fullName })
    .from(orders)
    .innerJoin(customers, eq(customers.id, orders.customerId))
    .where(eq(orders.id, orderId))
    .limit(1);
  if (!order) return [];
  const ctx = await voucherContext(db);
  const rows = await db
    .select({ code: coupons.code, value: coupons.value, expiresAt: coupons.expiresAt, origin: coupons.origin })
    .from(coupons)
    .where(and(eq(coupons.orderId, orderId)));
  const firstName = debutFirstName(order.customerName);
  const out: VoucherCardData[] = [];
  for (const kind of ["para_voce", "para_uma_amiga"] as const) {
    const row = rows.find((r) => r.origin === ORIGIN_BY_KIND[kind]);
    if (!row) continue;
    const data = toCardData(kind, row, firstName, ctx);
    if (data) out.push(data);
  }
  return out;
}

/** Que vales sairiam neste pedido hoje (mesmo antes de emitir): o plano. */
export async function plannedVoucherKinds(db: DbOrTx, input: { isGift: boolean }): Promise<VoucherKind[]> {
  const settings = await loadPaperVoucherSettings(db);
  const ctx = await voucherContext(db);
  return voucherPlan({ enabled: settings.enabled, isGift: input.isGift, hasStoreWhatsapp: ctx.storeWhatsapp !== null });
}

/**
 * Emite (ou reaproveita) os vales do pedido e devolve os cartões. Pedido que
 * não está pago e de pé não ganha vale. Idempotente: gerar os cartões de novo
 * devolve os mesmos códigos.
 */
export async function ensureOrderVouchers(db: DbOrTx, input: { orderId: string; now?: Date }): Promise<VoucherCardData[]> {
  const now = input.now ?? new Date();
  const settings = await loadPaperVoucherSettings(db);
  const [order] = await db
    .select({ id: orders.id, status: orders.status, isGift: orders.isGift, customerId: orders.customerId, customerName: customers.fullName })
    .from(orders)
    .innerJoin(customers, eq(customers.id, orders.customerId))
    .where(eq(orders.id, input.orderId))
    .limit(1);
  if (!order || !VOUCHER_STATUSES.has(order.status)) return [];
  const ctx = await voucherContext(db);
  const kinds = voucherPlan({ enabled: settings.enabled, isGift: order.isGift, hasStoreWhatsapp: ctx.storeWhatsapp !== null });
  if (kinds.length === 0) return [];

  const firstName = debutFirstName(order.customerName);
  return db.transaction(async (tx) => {
    const out: VoucherCardData[] = [];
    for (const kind of kinds) {
      const issued =
        kind === "para_voce"
          ? await issueCoupon(tx, {
              dedupeKey: `paper_voucher:${order.id}`,
              customerId: order.customerId,
              origin: "paper_voucher",
              type: "percent",
              value: settings.percent,
              expiresAt: couponExpiryAfterDays(now, settings.days),
              note: "Vale na caixa (para você)",
              orderId: order.id,
              now,
            })
          : await issueCoupon(tx, {
              dedupeKey: `referral:${order.id}`,
              customerId: null,
              origin: "referral",
              type: "percent",
              value: settings.referralPercent,
              expiresAt: couponExpiryAfterDays(now, settings.days),
              note: `Vale na caixa (para uma amiga) — indicação de ${firstName}`,
              orderId: order.id,
              referrerCustomerId: order.customerId,
              maxUses: REFERRAL_MAX_USES,
              perCustomerLimit: 1,
              firstPurchaseOnly: true,
              codePrefix: "AMIGA",
              now,
            });
      const [row] = await tx.select({ code: coupons.code, value: coupons.value, expiresAt: coupons.expiresAt }).from(coupons).where(eq(coupons.id, issued.couponId)).limit(1);
      const data = row ? toCardData(kind, row, firstName, ctx) : null;
      if (data) out.push(data);
    }
    return out;
  });
}

export type ReferralRewardResult =
  | { skipped: "sem_cupom" | "nao_e_vale_de_amiga" | "sem_quem_indicou" | "pedido_nao_pago" | "desligado" }
  | { rewarded: true; couponId: string; code: string; created: boolean };

/**
 * A amiga pagou um pedido com o vale: quem indicou ganha o prêmio (uma vez
 * por amiga que pagar — dedupe por vale + pedido) e o aviso. Chamado no
 * handler de order.paid; reprocessar não duplica.
 */
export async function rewardReferrerForPaidOrder(db: DbOrTx, input: { orderId: string; now?: Date }): Promise<ReferralRewardResult> {
  const now = input.now ?? new Date();
  const settings = await loadPaperVoucherSettings(db);
  const [order] = await db
    .select({ id: orders.id, status: orders.status, paidAt: orders.paidAt, couponId: orders.couponId, customerName: customers.fullName })
    .from(orders)
    .innerJoin(customers, eq(customers.id, orders.customerId))
    .where(eq(orders.id, input.orderId))
    .limit(1);
  if (!order || !order.couponId) return { skipped: "sem_cupom" };
  if (!VOUCHER_STATUSES.has(order.status) || !order.paidAt) return { skipped: "pedido_nao_pago" };
  const [voucher] = await db
    .select({ id: coupons.id, origin: coupons.origin, referrerCustomerId: coupons.referrerCustomerId })
    .from(coupons)
    .where(eq(coupons.id, order.couponId))
    .limit(1);
  if (!voucher || voucher.origin !== "referral") return { skipped: "nao_e_vale_de_amiga" };
  if (!voucher.referrerCustomerId) return { skipped: "sem_quem_indicou" };
  // O prêmio sai mesmo com o recurso desligado depois: o vale já estava na mão da amiga.
  const referrerId = voucher.referrerCustomerId;
  return db.transaction(async (tx) => {
    const issued = await issueCoupon(tx, {
      dedupeKey: `referral_reward:${voucher.id}:${order.id}`,
      customerId: referrerId,
      origin: "referral_reward",
      type: "percent",
      value: settings.rewardPercent,
      expiresAt: couponExpiryAfterDays(now, settings.days),
      note: `Prêmio da indicação: ${debutFirstName(order.customerName)} usou o vale e pagou`,
      orderId: order.id,
      now,
    });
    if (issued.created) {
      await enqueueCouponIssued(tx, { couponId: issued.couponId, vars: { amiga: debutFirstName(order.customerName) } });
      await tx.insert(auditLog).values({
        actorType: "system",
        actorId: null,
        action: "coupon.referral_reward",
        entityType: "coupon",
        entityId: issued.couponId,
        after: { referralCouponId: voucher.id, friendOrderId: order.id, referrerCustomerId: referrerId, percent: settings.rewardPercent },
      });
    }
    return { rewarded: true, couponId: issued.couponId, code: issued.code, created: issued.created };
  });
}
