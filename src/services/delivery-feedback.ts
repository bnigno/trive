// "Chegou bem?": um dia depois da entrega (dentro da janela 9–21), a cliente
// recebe UMA lista tocável — Amei / Ficou grande / Ficou pequeno / Veio com
// defeito / Quero falar com alguém. O toque volta pelo webhook como
// listResponseMessage.selectedRowId ("feedback:grande:<pedido>"): grande e
// pequeno caem num turno da Lia (que ajusta a cartela e oferece a troca);
// defeito e "falar" vão direto para a equipe. As respostas viram o sinal
// de caimento por tamanho na ficha e na vitrine.
import { and, countDistinct, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";

import type { MessagingProvider } from "@/adapters/zapi";
import { compareSizeLabels, findSizeAxis } from "@/core/catalog/measurements";
import { FIT_SIZE_SINGLE, fitSignal, type FitSignal } from "@/core/catalog/fit-signal";
import {
  FEEDBACK_DELAY_MS,
  feedbackMemoryLine,
  feedbackOptions,
  isFeedbackAnswer,
  type FeedbackAnswer,
} from "@/core/orders/feedback";
import { renderTemplate } from "@/core/whatsapp/render";
import { customers, deliveryFeedback, orderItems, orders, productVariants, settings, waTemplates } from "@/db/schema";
import { STORE_NAME_DEFAULT } from "@/lib/brand";
import { spDayKey } from "@/lib/sp-day";
import { enqueueOutboxEvent, type DbOrTx } from "@/queue/enqueue";
import { getSettingsMap } from "@/services/settings";
import { buildOrderVars, isWaEnabled, sendMediaMessage, type SendWaMessageResult, type WaSkipReason } from "@/services/wa-messaging";
import { deferOutsideSendWindow, loadSendPolicy } from "@/services/wa-send-policy";

export const FEEDBACK_ASK_EVENT = "wa.feedback_ask";
export const FEEDBACK_ASK_TEMPLATE_KEY = "delivery_feedback_ask";

export const feedbackAskPayloadSchema = z.object({ orderId: z.uuid() });

/** Setting feedback_ask_enabled: ausente = ligado. */
export async function isFeedbackAskEnabled(db: DbOrTx): Promise<boolean> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, "feedback_ask_enabled")).limit(1);
  return row?.value !== false;
}

/**
 * A pergunta fica agendada para um dia depois da ENTREGA (delivered_at do
 * pedido; `now` só quando o pedido ainda não a tem), com dedupe por pedido:
 * o retry do handler não agenda duas vezes nem desliza a hora.
 */
export async function scheduleDeliveryFeedback(tx: DbOrTx, input: { orderId: string; now: Date }): Promise<void> {
  const [order] = await tx.select({ deliveredAt: orders.deliveredAt }).from(orders).where(eq(orders.id, input.orderId)).limit(1);
  const base = order?.deliveredAt ?? input.now;
  await enqueueOutboxEvent(tx, {
    eventType: FEEDBACK_ASK_EVENT,
    dedupeKey: `wa.feedback_ask:${input.orderId}`,
    aggregateType: "order",
    aggregateId: input.orderId,
    payload: { orderId: input.orderId },
    nextAttemptAt: new Date(base.getTime() + FEEDBACK_DELAY_MS),
  });
}

export type AskFeedbackResult =
  | { sent: true; waMessageId: string }
  | { skipped: WaSkipReason | "desligado" | "nao_entregue" | "sem_telefone" | "ja_perguntado" | "fora_da_janela" };

/** A linha de delivery_feedback nasce só depois de a lista SAIR (UNIQUE por pedido). */
async function markAsked(db: DbOrTx, input: { orderId: string; customerId: string; phoneE164: string; productVariantId: string | null; now: Date }): Promise<void> {
  await db
    .insert(deliveryFeedback)
    .values({ orderId: input.orderId, customerId: input.customerId, phoneE164: input.phoneE164, productVariantId: input.productVariantId, askedAt: input.now })
    .onConflictDoNothing({ target: deliveryFeedback.orderId });
}

/**
 * A pergunta. Guardas em ordem: recurso ligado, pedido ainda entregue (não
 * reembolsado), cliente com telefone e opt-in, ainda não perguntado, dentro
 * da janela (fora, re-enfileira para a abertura com dedupe datado), template
 * ativo. O árbitro do envio é o dedupe de wa_messages (UNIQUE; retoma uma
 * linha 'failed' no retry): a linha de delivery_feedback nasce DEPOIS de a
 * lista sair — provedor fora do ar ou número sem WhatsApp não deixam
 * "perguntado" sem pergunta.
 */
export async function askDeliveryFeedback(
  db: DbOrTx,
  provider: MessagingProvider,
  input: { orderId: string; now?: Date },
): Promise<AskFeedbackResult> {
  const { orderId } = feedbackAskPayloadSchema.parse(input);
  const now = input.now ?? new Date();
  if (!(await isFeedbackAskEnabled(db))) return { skipped: "desligado" };
  if (!(await isWaEnabled(db))) return { skipped: "desabilitado" };

  const [row] = await db
    .select({
      status: orders.status,
      orderNumber: orders.orderNumber,
      publicToken: orders.publicToken,
      totalCents: orders.totalCents,
      paymentDueAt: orders.paymentDueAt,
      customerId: customers.id,
      customerName: customers.fullName,
      phoneE164: customers.phoneE164,
      marketingOptIn: customers.marketingOptIn,
    })
    .from(orders)
    .innerJoin(customers, eq(customers.id, orders.customerId))
    .where(eq(orders.id, orderId))
    .limit(1);
  if (!row || row.status !== "delivered") return { skipped: "nao_entregue" };
  if (!row.phoneE164) return { skipped: "sem_telefone" };
  if (!row.marketingOptIn) return { skipped: "sem_opt_in" };

  const [existing] = await db.select({ id: deliveryFeedback.id }).from(deliveryFeedback).where(eq(deliveryFeedback.orderId, orderId)).limit(1);
  if (existing) return { skipped: "ja_perguntado" };

  const policy = await loadSendPolicy(db);
  const deferred = await deferOutsideSendWindow(db, policy, {
    eventType: FEEDBACK_ASK_EVENT,
    dedupeBase: `wa.feedback_ask:${orderId}`,
    aggregateType: "order",
    aggregateId: orderId,
    payload: { orderId },
    now,
  });
  if (deferred) return { skipped: "fora_da_janela" };

  const [template] = await db
    .select({ bodyTemplate: waTemplates.bodyTemplate, isActive: waTemplates.isActive })
    .from(waTemplates)
    .where(eq(waTemplates.key, FEEDBACK_ASK_TEMPLATE_KEY))
    .limit(1);
  if (!template || !template.isActive) return { skipped: "sem_template" };

  // A peça (uma só) é a que ganha o sinal de caimento; com várias, a resposta
  // vale para o pedido e a peça fica de fora do sinal.
  const items = await db
    .select({ productVariantId: orderItems.productVariantId, name: orderItems.nameSnapshot })
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId));
  const single = items.length === 1 ? items[0] : null;
  const settingsMap = await getSettingsMap(db, ["store_name"]);
  const storeName = typeof settingsMap["store_name"] === "string" && settingsMap["store_name"].trim() !== "" ? settingsMap["store_name"].trim() : STORE_NAME_DEFAULT;
  const body = renderTemplate(template.bodyTemplate, {
    ...buildOrderVars({
      orderNumber: row.orderNumber,
      customerName: row.customerName,
      totalCents: row.totalCents,
      publicToken: row.publicToken,
      paymentDueAt: row.paymentDueAt,
      storeName,
    }),
    peca: single ? single.name : items.length > 1 ? "suas peças" : "sua peça",
  });

  const result: SendWaMessageResult = await sendMediaMessage(db, provider, {
    kind: "option_list",
    body,
    optionList: { title: "Chegou bem?", buttonLabel: "Responder", options: feedbackOptions(orderId) },
    phoneE164: row.phoneE164,
    customerId: row.customerId,
    orderId,
    dedupeKey: `wa.feedback_ask:${orderId}`,
    requireOptIn: true,
  });
  // Saiu agora, ou já tinha saído (retry depois de a linha não ter sido
  // gravada): a linha nasce aqui. Qualquer outro skip não deixa rastro.
  if ("sent" in result || result.skipped === "ja_enviado") {
    await markAsked(db, { orderId, customerId: row.customerId, phoneE164: row.phoneE164, productVariantId: single?.productVariantId ?? null, now });
  }
  return "sent" in result ? { sent: true, waMessageId: result.waMessageId } : result;
}

export type FeedbackContext = { orderNumber: number; itemLabel: string | null; answer: FeedbackAnswer; previous?: FeedbackAnswer | null };

/**
 * O toque chegou (webhook): grava a resposta na linha do pedido — só se o
 * telefone é o mesmo que recebeu a pergunta. Se ela tocar de novo com outra
 * opção, a ÚLTIMA vale (ficha, caderninho e sinal ficam iguais à conversa) e
 * o contexto carrega a anterior; o mesmo toque repetido não muda nada.
 */
export async function recordDeliveryFeedback(
  tx: DbOrTx,
  input: { orderId: string; answer: FeedbackAnswer; phoneE164: string; waMessageId: string; now: Date },
): Promise<{ recorded: boolean; context: FeedbackContext | null }> {
  const [row] = await tx
    .select({
      id: deliveryFeedback.id,
      phoneE164: deliveryFeedback.phoneE164,
      answer: deliveryFeedback.answer,
      orderNumber: orders.orderNumber,
    })
    .from(deliveryFeedback)
    .innerJoin(orders, eq(orders.id, deliveryFeedback.orderId))
    .where(eq(deliveryFeedback.orderId, input.orderId))
    .limit(1);
  if (!row || row.phoneE164 !== input.phoneE164) return { recorded: false, context: null };
  const items = await tx
    .select({ name: orderItems.nameSnapshot, sku: orderItems.skuSnapshot, variantId: orderItems.productVariantId })
    .from(orderItems)
    .where(eq(orderItems.orderId, input.orderId));
  const itemLabel = items.length === 1 ? await variantLabelOf(tx, items[0].variantId, items[0].name) : items.length > 1 ? `${items.length} peças` : null;
  const previous = isFeedbackAnswer(row.answer) && row.answer !== input.answer ? row.answer : null;
  const context: FeedbackContext = { orderNumber: row.orderNumber, itemLabel, answer: input.answer, previous };
  if (row.answer === input.answer) return { recorded: false, context };
  await tx
    .update(deliveryFeedback)
    .set({ answer: input.answer, answeredAt: input.now, answerWaMessageId: input.waMessageId })
    .where(eq(deliveryFeedback.id, row.id));
  return { recorded: true, context };
}

async function variantLabelOf(db: DbOrTx, variantId: string, name: string): Promise<string> {
  const [variant] = await db.select({ attributes: productVariants.attributes }).from(productVariants).where(eq(productVariants.id, variantId)).limit(1);
  const attributes = (variant?.attributes ?? {}) as Record<string, string>;
  const values = Object.values(attributes).filter((value) => typeof value === "string" && value !== "");
  return values.length > 0 ? `${name} · ${values.join(" · ")}` : name;
}

/** As últimas respostas desta cliente, para o caderninho da Lia. */
export async function listFeedbackByPhone(db: DbOrTx, phoneE164: string, limit = 3): Promise<string[]> {
  const rows = await db
    .select({
      orderId: deliveryFeedback.orderId,
      orderNumber: orders.orderNumber,
      answer: deliveryFeedback.answer,
      answeredAt: deliveryFeedback.answeredAt,
    })
    .from(deliveryFeedback)
    .innerJoin(orders, eq(orders.id, deliveryFeedback.orderId))
    .where(and(eq(deliveryFeedback.phoneE164, phoneE164), isNotNull(deliveryFeedback.answer)))
    .orderBy(desc(deliveryFeedback.answeredAt))
    .limit(limit);
  const lines: string[] = [];
  for (const row of rows) {
    if (!isFeedbackAnswer(row.answer) || !row.answeredAt) continue;
    const items = await db
      .select({ name: orderItems.nameSnapshot, variantId: orderItems.productVariantId })
      .from(orderItems)
      .where(eq(orderItems.orderId, row.orderId));
    const itemLabel = items.length === 1 ? await variantLabelOf(db, items[0].variantId, items[0].name) : null;
    const [, m, d] = spDayKey(row.answeredAt).split("-");
    lines.push(feedbackMemoryLine({ orderNumber: row.orderNumber, itemLabel, answer: row.answer, dayLabel: `${d}/${m}` }));
  }
  return lines;
}

export type ProductFitSignals = { size: string; amei: number; grande: number; pequeno: number; signal: FitSignal | null }[];

/**
 * Por tamanho: quantas CLIENTES (uma opinião por pessoa) disseram amei /
 * grande / pequeno, e o sinal quando há base. Peça sem eixo de tamanho
 * (lenço, bolsa, tamanho único) junta tudo em "único" — a vitrine não fala
 * em "um número acima/abaixo" para ela.
 */
export async function getFitSignalsForProduct(db: DbOrTx, productId: string): Promise<ProductFitSignals> {
  const rows = await db
    .select({
      attributes: productVariants.attributes,
      answer: deliveryFeedback.answer,
      total: countDistinct(sql`coalesce(${deliveryFeedback.customerId}::text, ${deliveryFeedback.phoneE164})`),
    })
    .from(deliveryFeedback)
    .innerJoin(productVariants, eq(productVariants.id, deliveryFeedback.productVariantId))
    .where(and(eq(productVariants.productId, productId), inArray(deliveryFeedback.answer, ["amei", "grande", "pequeno"])))
    .groupBy(productVariants.attributes, deliveryFeedback.answer);
  const bySize = new Map<string, { amei: number; grande: number; pequeno: number }>();
  for (const row of rows) {
    const attributes = (row.attributes ?? {}) as Record<string, string>;
    const sizeAxis = findSizeAxis(Object.keys(attributes));
    const size = sizeAxis && attributes[sizeAxis] ? attributes[sizeAxis] : FIT_SIZE_SINGLE;
    const counts = bySize.get(size) ?? { amei: 0, grande: 0, pequeno: 0 };
    counts[row.answer as "amei" | "grande" | "pequeno"] += Number(row.total);
    bySize.set(size, counts);
  }
  return [...bySize.entries()]
    .map(([size, counts]) => ({ size, ...counts, signal: fitSignal(counts) }))
    .sort((a, b) => compareSizeLabels(a.size, b.size));
}

/** O estado da pergunta para a ficha do pedido. */
export async function getFeedbackForOrder(db: DbOrTx, orderId: string): Promise<{ askedAt: Date; answer: FeedbackAnswer | null; answeredAt: Date | null } | null> {
  const [row] = await db
    .select({ askedAt: deliveryFeedback.askedAt, answer: deliveryFeedback.answer, answeredAt: deliveryFeedback.answeredAt })
    .from(deliveryFeedback)
    .where(eq(deliveryFeedback.orderId, orderId))
    .limit(1);
  if (!row) return null;
  return { askedAt: row.askedAt, answer: isFeedbackAnswer(row.answer) ? row.answer : null, answeredAt: row.answeredAt };
}
