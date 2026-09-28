// Cliente de pedido com telefone sem WhatsApp (caso real do #1011: um dígito
// errado no checkout; a cliente não recebeu confirmação, pagamento, "saiu
// para entrega" nem o link de acompanhamento, e ninguém soube). Dois usos:
//
// - o handler da fila (order.customer_no_whatsapp) avisa a dona pelo
//   WhatsApp, uma vez por pedido e número, com a dica do número certo quando
//   um número parecido falou com a loja nos últimos dias;
// - a página do pedido mostra o mesmo alerta enquanto o telefone não for
//   corrigido.
import { and, desc, eq, gte, isNotNull, like } from "drizzle-orm";
import { z } from "zod";

import type { MessagingProvider } from "@/adapters/zapi";
import { likelyIntendedPhone } from "@/core/whatsapp/phone-typo";
import { customers, orders, waConversations, waMessages } from "@/db/schema";
import { formatPhoneBR, isValidE164, sameE164 } from "@/lib/phone";
import type { DbOrTx } from "@/queue/enqueue";
import { sendToOwner, type SendWaMessageResult } from "@/services/wa-messaging";

export const OWNER_NO_WHATSAPP_TEMPLATE_KEY = "owner_customer_no_whatsapp";

/** Janela em que um número parecido que falou com a loja vira dica. */
const INTENDED_PHONE_WINDOW_MS = 72 * 3_600_000;

export const orderNoWhatsappPayloadSchema = z.object({
  orderId: z.uuid(),
  phoneE164: z.string().refine(isValidE164, "Telefone deve estar em E.164."),
});

/** O número que parece o certo: um que falou com a loja nos últimos dias e muda só um dígito. */
async function findIntendedPhone(db: DbOrTx, failingPhone: string, now: Date): Promise<string | null> {
  const rows = await db
    .select({ phone: waConversations.phoneE164 })
    .from(waConversations)
    .where(and(isNotNull(waConversations.lastInboundAt), gte(waConversations.lastInboundAt, new Date(now.getTime() - INTENDED_PHONE_WINDOW_MS))));
  return likelyIntendedPhone(
    failingPhone,
    rows.map((row) => row.phone).filter(isValidE164),
  );
}

async function loadOrderCustomer(db: DbOrTx, orderId: string) {
  const [row] = await db
    .select({
      orderNumber: orders.orderNumber,
      customerId: customers.id,
      customerName: customers.fullName,
      customerPhone: customers.phoneE164,
    })
    .from(orders)
    .innerJoin(customers, eq(customers.id, orders.customerId))
    .where(eq(orders.id, orderId))
    .limit(1);
  return row ?? null;
}

/**
 * O aviso à dona. Não avisa se o telefone da cliente já foi corrigido desde
 * a falha (o próximo aviso do pedido já vai para o número novo).
 */
export async function notifyOwnerCustomerNoWhatsapp(
  db: DbOrTx,
  provider: MessagingProvider,
  rawPayload: unknown,
  now = new Date(),
): Promise<SendWaMessageResult | { skipped: "pedido_nao_encontrado" | "telefone_corrigido" }> {
  const payload = orderNoWhatsappPayloadSchema.parse(rawPayload);
  const order = await loadOrderCustomer(db, payload.orderId);
  if (!order) return { skipped: "pedido_nao_encontrado" };
  if (!sameE164(order.customerPhone, payload.phoneE164)) return { skipped: "telefone_corrigido" };

  const intended = await findIntendedPhone(db, payload.phoneE164, now);
  const dica = intended
    ? `\nParece erro de digitação: o ${formatPhoneBR(intended)} falou com a loja nos últimos dias e muda só um dígito. Se for esse, corrija o telefone no cadastro da cliente — os próximos avisos já vão para o número certo.`
    : "\nConfira o telefone com a cliente e corrija no cadastro — os próximos avisos já vão para o número certo.";
  return sendToOwner(db, provider, {
    templateKey: OWNER_NO_WHATSAPP_TEMPLATE_KEY,
    vars: {
      pedido: String(order.orderNumber),
      cliente: order.customerName,
      telefone: formatPhoneBR(payload.phoneE164),
      dica,
    },
    dedupeKey: `wa.owner_no_whatsapp:${payload.orderId}:${payload.phoneE164.replace(/\D/g, "")}`,
  });
}

export type OrderWhatsappProblem = {
  /** O telefone do cadastro, que não tem WhatsApp. */
  phoneE164: string;
  /** Avisos do pedido que não chegaram. */
  failedCount: number;
  /** O número parecido que falou com a loja (dica), ou null. */
  intendedPhone: string | null;
  customerId: string;
};

/**
 * Para a página do pedido: os avisos do pedido estão falhando por "número sem
 * WhatsApp" E o telefone do cadastro ainda é esse. null = nada a avisar.
 */
export async function getOrderWhatsappProblem(db: DbOrTx, orderId: string, now = new Date()): Promise<OrderWhatsappProblem | null> {
  const id = z.uuid().parse(orderId);
  const order = await loadOrderCustomer(db, id);
  if (!order?.customerPhone) return null;
  const failed = await db
    .select({ phone: waConversations.phoneE164 })
    .from(waMessages)
    .innerJoin(waConversations, eq(waConversations.id, waMessages.conversationId))
    .where(and(eq(waMessages.orderId, id), eq(waMessages.status, "failed"), like(waMessages.errorDetail, "Número sem WhatsApp%")))
    .orderBy(desc(waMessages.createdAt));
  const current = failed.filter((row) => sameE164(row.phone, order.customerPhone));
  if (current.length === 0) return null;
  return {
    phoneE164: order.customerPhone,
    failedCount: current.length,
    intendedPhone: await findIntendedPhone(db, order.customerPhone, now),
    customerId: order.customerId,
  };
}
