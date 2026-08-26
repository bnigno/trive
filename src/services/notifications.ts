// Notificações por e-mail dos marcos do pedido (Fase 3): confirmado, pago e
// enviado. Chamado pelos handlers do outbox — falha do provedor LANÇA de
// propósito (retry/backoff/DLQ da fila cuidam do resto).
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { getAdapterMode } from "@/adapters/adapter-mode";
import type { EmailProvider } from "@/adapters/email";
import { auditLog, customers, orderItems, orders, settings } from "@/db/schema";
import {
  orderConfirmedEmail,
  orderShippedEmail,
  paymentApprovedEmail,
  type EmailTemplate,
} from "@/emails/templates";
import type { DbOrTx } from "@/queue/enqueue";
import { ServiceError } from "@/services/settings";

export { ServiceError };

const DEFAULT_SITE_URL = "https://trivemaison.com.br";
const DEFAULT_STORE_NAME = "TRIVË";

export const ORDER_EMAIL_KINDS = ["confirmed", "paid", "shipped"] as const;
export type OrderEmailKind = (typeof ORDER_EMAIL_KINDS)[number];

const sendOrderEmailSchema = z.object({
  orderId: z.uuid(),
  kind: z.enum(ORDER_EMAIL_KINDS),
});

export type SendOrderEmailInput = z.input<typeof sendOrderEmailSchema>;

export type SendOrderEmailResult =
  | { sent: true }
  | { skipped: "sem_email" | "ja_enviado" | "email_nao_configurado" };

/**
 * Envia o e-mail do marco `kind` para o cliente do pedido. Cliente sem e-mail
 * NÃO é erro (checkout da loja aceita pedido sem e-mail): retorna
 * { skipped: 'sem_email' }. Reenvio do mesmo kind é skip idempotente.
 */
export async function sendOrderEmail(
  db: DbOrTx,
  emailProvider: EmailProvider,
  input: SendOrderEmailInput,
): Promise<SendOrderEmailResult> {
  const parsed = sendOrderEmailSchema.parse(input);

  // Em modo real SEM Resend configurado, e-mail fica desativado de forma
  // silenciosa (skip) — o WhatsApp/fluxo do pedido nunca pode travar por
  // falta de um canal opcional.
  if (getAdapterMode() === "real" && !process.env.RESEND_API_KEY) {
    return { skipped: "email_nao_configurado" };
  }

  const [order] = await db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      publicToken: orders.publicToken,
      paymentDueAt: orders.paymentDueAt,
      trackingCode: orders.shippingTrackingCode,
      totalCents: orders.totalCents,
      customerName: customers.fullName,
      customerEmail: customers.email,
    })
    .from(orders)
    .innerJoin(customers, eq(customers.id, orders.customerId))
    .where(eq(orders.id, parsed.orderId));

  if (!order) {
    throw new ServiceError(
      "pedido_nao_encontrado",
      `Pedido ${parsed.orderId} não encontrado para enviar a notificação.`,
    );
  }

  if (!order.customerEmail) {
    return { skipped: "sem_email" };
  }

  // Idempotência: rede SIMPLES via audit_log — se já registramos
  // notification.email deste kind para este pedido, não reenvia. O dedupe
  // forte já existe na chave (dedupe_key) do outbox; isto cobre reentregas
  // do mesmo evento (retry após falha parcial, varredura do cron etc.).
  const previousNotifications = await db
    .select({ after: auditLog.after })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, "notification.email"),
        eq(auditLog.entityType, "order"),
        eq(auditLog.entityId, parsed.orderId),
      ),
    );
  const alreadySent = previousNotifications.some(
    (row) => (row.after as { kind?: unknown } | null)?.kind === parsed.kind,
  );
  if (alreadySent) {
    return { skipped: "ja_enviado" };
  }

  const items = await db
    .select({
      name: orderItems.nameSnapshot,
      quantity: orderItems.quantity,
      unitPriceCents: orderItems.unitPriceCents,
    })
    .from(orderItems)
    .where(eq(orderItems.orderId, parsed.orderId));

  const [storeNameRow] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, "store_name"));
  const storeName =
    typeof storeNameRow?.value === "string" && storeNameRow.value.trim() !== ""
      ? storeNameRow.value.trim()
      : DEFAULT_STORE_NAME;

  const siteUrl = (
    process.env.NEXT_PUBLIC_SITE_URL?.trim() || DEFAULT_SITE_URL
  ).replace(/\/+$/, "");
  const publicUrl = `${siteUrl}/pedido/${order.publicToken}`;

  const base = {
    orderNumber: order.orderNumber,
    customerName: order.customerName,
    items,
    totalCents: order.totalCents,
    publicUrl,
    storeName,
  };

  let template: EmailTemplate;
  switch (parsed.kind) {
    case "confirmed":
      template = orderConfirmedEmail({
        ...base,
        paymentDueAt: order.paymentDueAt ?? undefined,
      });
      break;
    case "paid":
      template = paymentApprovedEmail(base);
      break;
    case "shipped":
      template = orderShippedEmail({
        ...base,
        trackingCode: order.trackingCode ?? undefined,
      });
      break;
  }

  // Efeito externo: se o provedor falhar, LANÇA — a fila re-tenta.
  await emailProvider.send({
    to: order.customerEmail,
    subject: template.subject,
    html: template.html,
    text: template.text,
  });

  await db.insert(auditLog).values({
    actorType: "system",
    actorId: null,
    action: "notification.email",
    entityType: "order",
    entityId: parsed.orderId,
    after: {
      kind: parsed.kind,
      to: order.customerEmail,
      subject: template.subject,
    },
  });

  return { sent: true };
}
