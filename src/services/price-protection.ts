// Proteção de preço: quando um preço ativo cai (price.activated), quem pagou
// mais nos últimos N dias ganha a diferença em cupom pessoal — um por
// (pedido, variante), idempotente pela dedupe_key, com o aviso coupon.issued.
// Roda no handler da fila (fora da transação do preço): o cupom e o aviso
// nascem juntos numa transação por pedido.
import { and, eq, gte, inArray } from "drizzle-orm";
import { z } from "zod";

import { couponExpiryAfterDays } from "@/core/coupons/expiry";
import { isPriceDrop, priceProtectionNote, priceProtectionRefundCents, protectionWindowStart } from "@/core/pricing/price-protection";
import { auditLog, orderItems, orders, priceVersions } from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { enqueueCouponIssued } from "@/services/coupon-notices";
import { issueCoupon } from "@/services/coupons";
import { getSettingsMap } from "@/services/settings";

export const priceActivatedPayloadSchema = z.object({ variantId: z.uuid(), priceCents: z.number().int().min(0) });

/** Pedidos que contam: pagos e ainda de pé (reembolsado/cancelado não ganha). */
const PROTECTED_STATUSES = ["paid", "preparing", "shipped", "delivered"] as const;
const COUPON_DAYS = 30;

export interface PriceProtectionSettings {
  enabled: boolean;
  days: number;
}

export const PRICE_PROTECTION_DEFAULTS: PriceProtectionSettings = { enabled: false, days: 14 };

export async function loadPriceProtectionSettings(db: DbOrTx): Promise<PriceProtectionSettings> {
  const map = await getSettingsMap(db, ["price_protection_enabled", "price_protection_days"]);
  return {
    enabled: map["price_protection_enabled"] === true,
    days: typeof map["price_protection_days"] === "number" ? (map["price_protection_days"] as number) : PRICE_PROTECTION_DEFAULTS.days,
  };
}

export type PriceProtectionResult =
  | { skipped: "desligado" | "versao_inexistente" | "sem_queda" }
  | { issued: number; already: number; skipped?: undefined };

/**
 * Para cada pedido pago na janela com esta variante acima do preço novo:
 * cupom fixo da diferença × quantidade (30 dias) + aviso. Reprocessar o
 * evento não duplica (dedupe por pedido + variante).
 */
export async function protectPricesAfterDrop(
  db: DbOrTx,
  input: { versionId: string; variantId: string; priceCents: number; now?: Date },
): Promise<PriceProtectionResult> {
  const settings = await loadPriceProtectionSettings(db);
  if (!settings.enabled) return { skipped: "desligado" };
  const now = input.now ?? new Date();

  const [version] = await db
    .select({ previousPriceCents: priceVersions.previousPriceCents, productVariantId: priceVersions.productVariantId })
    .from(priceVersions)
    .where(eq(priceVersions.id, input.versionId))
    .limit(1);
  if (!version) return { skipped: "versao_inexistente" };
  if (!isPriceDrop({ priceCents: input.priceCents, previousPriceCents: version.previousPriceCents })) return { skipped: "sem_queda" };

  const rows = await db
    .select({
      orderId: orders.id,
      orderNumber: orders.orderNumber,
      customerId: orders.customerId,
      unitPriceCents: orderItems.unitPriceCents,
      quantity: orderItems.quantity,
      productName: orderItems.nameSnapshot,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(
      and(
        eq(orderItems.productVariantId, input.variantId),
        inArray(orders.status, [...PROTECTED_STATUSES]),
        gte(orders.paidAt, protectionWindowStart(now, settings.days)),
      ),
    );

  let issued = 0;
  let already = 0;
  for (const row of rows) {
    const refundCents = priceProtectionRefundCents({ unitPriceCents: row.unitPriceCents, quantity: row.quantity, newPriceCents: input.priceCents });
    if (refundCents <= 0) continue;
    const result = await db.transaction(async (tx) => {
      const coupon = await issueCoupon(tx, {
        dedupeKey: `price_protection:${row.orderId}:${input.variantId}`,
        customerId: row.customerId,
        origin: "price_protection",
        type: "fixed",
        value: refundCents,
        expiresAt: couponExpiryAfterDays(now, COUPON_DAYS),
        note: priceProtectionNote({ productName: row.productName, unitPriceCents: row.unitPriceCents, newPriceCents: input.priceCents, orderNumber: row.orderNumber }),
        orderId: row.orderId,
        now,
      });
      if (coupon.created) {
        await enqueueCouponIssued(tx, { couponId: coupon.couponId, vars: { peca: row.productName } });
        await tx.insert(auditLog).values({
          actorType: "system",
          actorId: null,
          action: "coupon.price_protection",
          entityType: "order",
          entityId: row.orderId,
          after: { couponId: coupon.couponId, code: coupon.code, variantId: input.variantId, refundCents, newPriceCents: input.priceCents, unitPriceCents: row.unitPriceCents },
        });
      }
      return coupon.created;
    });
    if (result) issued += 1;
    else already += 1;
  }
  return { issued, already };
}
