// O aviso de um cupom emitido pela casa (desculpas pelo atraso, proteção de
// preço, prêmio da indicação): evento coupon.issued → uma mensagem de
// WhatsApp com template escolhido pela origem do cupom. Regras iguais às dos
// outros avisos: só com opt-in, dentro da janela de envio (fora, re-enfileira
// datado), dedupe por cupom — nenhum skip lança.
import { eq } from "drizzle-orm";
import { z } from "zod";

import type { MessagingProvider } from "@/adapters/zapi";
import { coupons, customers, orders } from "@/db/schema";
import { STORE_NAME_DEFAULT } from "@/lib/brand";
import { formatCentsBRL } from "@/lib/money";
import { enqueueOutboxEvent, type DbOrTx } from "@/queue/enqueue";
import type { CouponOrigin } from "@/services/coupons";
import { getSettingsMap } from "@/services/settings";
import { firstNameOf, isWaEnabled, sendTemplateMessage, siteBaseUrl, type WaSkipReason } from "@/services/wa-messaging";
import { deferOutsideSendWindow, loadSendPolicy } from "@/services/wa-send-policy";

export const COUPON_ISSUED_EVENT = "coupon.issued";

export const couponIssuedPayloadSchema = z.object({
  couponId: z.uuid(),
  /** Variáveis a mais do template ({{atraso}}, {{peca}}, {{amiga}}…). */
  vars: z.record(z.string(), z.string()).optional(),
});
export type CouponIssuedPayload = z.infer<typeof couponIssuedPayloadSchema>;

/** Qual template fala de cada cupom automático; origem sem template não avisa (o painel mostra). */
export const COUPON_TEMPLATE_BY_ORIGIN: Partial<Record<CouponOrigin, string>> = {
  late_delivery: "late_delivery_coupon",
  price_protection: "price_protection_coupon",
  referral_reward: "referral_reward_coupon",
};

const dateFormatter = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit" });

/** "10%" / "R$ 20,00" / "frete grátis". */
export function couponValueLabel(coupon: { type: string; value: number }): string {
  if (coupon.type === "free_shipping") return "frete grátis";
  return coupon.type === "percent" ? `${coupon.value}%` : formatCentsBRL(coupon.value);
}

/** Enfileira o aviso na MESMA transação em que o cupom nasceu. */
export async function enqueueCouponIssued(tx: DbOrTx, input: CouponIssuedPayload): Promise<void> {
  await enqueueOutboxEvent(tx, {
    eventType: COUPON_ISSUED_EVENT,
    dedupeKey: `coupon.issued:${input.couponId}`,
    aggregateType: "coupon",
    aggregateId: input.couponId,
    payload: input,
  });
}

export type CouponNoticeResult =
  | { sent: true; waMessageId: string }
  | { skipped: WaSkipReason | "cupom_inexistente" | "inativo" | "sem_aviso" | "sem_telefone" | "fora_da_janela" };

export async function sendCouponIssuedWa(
  db: DbOrTx,
  provider: MessagingProvider,
  input: CouponIssuedPayload & { now?: Date },
): Promise<CouponNoticeResult> {
  const { couponId, vars } = couponIssuedPayloadSchema.parse(input);
  const now = input.now ?? new Date();
  if (!(await isWaEnabled(db))) return { skipped: "desabilitado" };

  const [row] = await db
    .select({
      code: coupons.code,
      type: coupons.type,
      value: coupons.value,
      origin: coupons.origin,
      isActive: coupons.isActive,
      expiresAt: coupons.expiresAt,
      orderId: coupons.orderId,
      orderNumber: orders.orderNumber,
      customerId: coupons.customerId,
      couponPhone: coupons.phoneE164,
      customerName: customers.fullName,
      customerPhone: customers.phoneE164,
    })
    .from(coupons)
    .leftJoin(customers, eq(customers.id, coupons.customerId))
    .leftJoin(orders, eq(orders.id, coupons.orderId))
    .where(eq(coupons.id, couponId))
    .limit(1);
  if (!row) return { skipped: "cupom_inexistente" };
  if (!row.isActive) return { skipped: "inativo" };
  const templateKey = COUPON_TEMPLATE_BY_ORIGIN[row.origin as CouponOrigin];
  if (!templateKey) return { skipped: "sem_aviso" };
  const phoneE164 = row.customerPhone ?? row.couponPhone;
  if (!phoneE164) return { skipped: "sem_telefone" };

  const policy = await loadSendPolicy(db);
  const deferred = await deferOutsideSendWindow(db, policy, {
    eventType: COUPON_ISSUED_EVENT,
    dedupeBase: `coupon.issued:${couponId}`,
    aggregateType: "coupon",
    aggregateId: couponId,
    payload: { couponId, ...(vars ? { vars } : {}) },
    now,
  });
  if (deferred) return { skipped: "fora_da_janela" };

  const settingsMap = await getSettingsMap(db, ["store_name"]);
  const storeName = typeof settingsMap["store_name"] === "string" && settingsMap["store_name"].trim() !== "" ? settingsMap["store_name"].trim() : STORE_NAME_DEFAULT;

  const result = await sendTemplateMessage(db, provider, {
    templateKey,
    phoneE164,
    vars: {
      nome: row.customerName ? firstNameOf(row.customerName) : "",
      cupom: row.code,
      valor: couponValueLabel(row),
      validade: row.expiresAt ? dateFormatter.format(row.expiresAt) : "",
      pedido: row.orderNumber !== null ? String(row.orderNumber) : "",
      // O link já aplica o cupom na sacola (PR do painel: /c/CÓDIGO).
      link: `${siteBaseUrl()}/c/${row.code}`,
      loja: storeName,
      ...(vars ?? {}),
    },
    customerId: row.customerId ?? undefined,
    orderId: row.orderId ?? undefined,
    dedupeKey: `wa.coupon:${couponId}`,
    // O cupom é dela de qualquer jeito; o AVISO só com opt-in.
    requireOptIn: true,
  });
  return "sent" in result ? { sent: true, waMessageId: result.waMessageId } : result;
}
