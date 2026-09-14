// Sugestões do copiloto: nascem no turno (na transação), a dona aprova
// (envia como está ou editada) ou descarta na Central; a fila entrega com os
// mesmos dedupes de um turno da Lia. A nova mensagem da cliente supera a
// pendente. O modo efetivo (loja + override da conversa) também mora aqui.
import { and, count, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import type { MessagingProvider } from "@/adapters/zapi";
import { resolveBotMode, type BotMode } from "@/core/bot/copilot";
import { auditLog, customers, settings, waConversations, waMessages, waSuggestions } from "@/db/schema";
import { enqueueOutboxEvent, type DbOrTx } from "@/queue/enqueue";
import type { BotAttachment } from "@/services/bot/shared";
import { ServiceError } from "@/services/settings";
import { deliverBotTurn } from "@/services/wa-bot";
import { maskPhone } from "@/lib/phone";

export const SUGGESTION_SEND_EVENT = "wa.suggestion_send";
export const suggestionSendPayloadSchema = z.object({ suggestionId: z.uuid() });
/** Um aviso no WhatsApp da dona por conversa a cada meia hora, no máximo. */
export const SUGGESTION_NOTICE_BUCKET_MS = 30 * 60_000;

const bubblesSchema = z.array(z.string().trim().min(1).max(4000)).min(1).max(3);

/** O modo da loja (setting bot_mode; ausente = autônoma). */
export async function loadStoreBotMode(db: DbOrTx): Promise<BotMode> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, "bot_mode")).limit(1);
  return resolveBotMode(row?.value, null);
}

/** O modo efetivo desta conversa: o override dela vence o da loja. */
export async function resolveConversationBotMode(db: DbOrTx, conversation: { botMode: string | null }): Promise<BotMode> {
  return resolveBotMode(await loadStoreBotMode(db), conversation.botMode);
}

/** "Só sugerir nesta conversa" / "deixar responder sozinha" / voltar ao modo da loja (null). */
export async function setConversationBotMode(
  db: DbOrTx,
  input: { conversationId: string; mode: BotMode | null; userId: string },
): Promise<void> {
  const conversationId = z.uuid().parse(input.conversationId);
  const [row] = await db.select({ botMode: waConversations.botMode }).from(waConversations).where(eq(waConversations.id, conversationId)).limit(1);
  if (!row) throw new ServiceError("conversa_inexistente", "Conversa não encontrada.");
  await db.update(waConversations).set({ botMode: input.mode, updatedAt: new Date() }).where(eq(waConversations.id, conversationId));
  await db.insert(auditLog).values({
    actorType: "user",
    actorId: input.userId,
    action: "wa.bot_mode_override",
    entityType: "wa_conversation",
    entityId: conversationId,
    before: { botMode: row.botMode },
    after: { botMode: input.mode },
  });
}

export interface PendingSuggestion {
  id: string;
  conversationId: string;
  inboundMessageId: string | null;
  followupId: string | null;
  bubbles: string[];
  attachments: BotAttachment[];
  toolCalls: { name: string; ok: boolean }[];
  createdAt: Date;
}

/**
 * No turno (transação): a sugestão nasce; a pendente anterior da conversa é
 * superada. Uma por mensagem recebida — a reentrada da fila devolve a que já
 * existe sem criar outra.
 */
export async function createSuggestion(
  tx: DbOrTx,
  input: {
    conversationId: string;
    inboundMessageId?: string | null;
    followupId?: string | null;
    bubbles: string[];
    attachments: BotAttachment[];
    toolCalls: { name: string; ok: boolean }[];
    now: Date;
  },
): Promise<{ suggestionId: string; created: boolean }> {
  const key = input.inboundMessageId ? eq(waSuggestions.inboundMessageId, input.inboundMessageId) : input.followupId ? eq(waSuggestions.followupId, input.followupId) : null;
  if (key) {
    const [existing] = await tx.select({ id: waSuggestions.id }).from(waSuggestions).where(key).limit(1);
    if (existing) return { suggestionId: existing.id, created: false };
  }
  await tx
    .update(waSuggestions)
    .set({ status: "superseded", supersededAt: input.now, updatedAt: input.now })
    .where(and(eq(waSuggestions.conversationId, input.conversationId), eq(waSuggestions.status, "pending")));
  const [row] = await tx
    .insert(waSuggestions)
    .values({
      conversationId: input.conversationId,
      inboundMessageId: input.inboundMessageId ?? null,
      followupId: input.followupId ?? null,
      bubbles: input.bubbles,
      attachments: input.attachments,
      toolCalls: input.toolCalls,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .returning({ id: waSuggestions.id });
  return { suggestionId: row.id, created: true };
}

/** Aviso no WhatsApp da dona: uma vez por conversa a cada meia hora (dedupe por balde). */
export async function enqueueSuggestionNotice(
  tx: DbOrTx,
  input: { conversationId: string; phoneE164: string; customerName: string | null; now: Date },
): Promise<void> {
  const bucket = Math.floor(input.now.getTime() / SUGGESTION_NOTICE_BUCKET_MS);
  await enqueueOutboxEvent(tx, {
    eventType: "wa.owner_forward",
    dedupeKey: `wa.suggestion_notice:${input.conversationId}:${bucket}`,
    aggregateType: "wa_conversation",
    aggregateId: input.conversationId,
    payload: {
      phoneE164: input.phoneE164,
      body: `💡 A vendedora sugeriu uma resposta para ${input.customerName ?? maskPhone(input.phoneE164)}. Abra a Central para enviar, editar ou descartar.`,
      raw: true,
    },
  });
}

function toPending(row: typeof waSuggestions.$inferSelect): PendingSuggestion {
  return {
    id: row.id,
    conversationId: row.conversationId,
    inboundMessageId: row.inboundMessageId,
    followupId: row.followupId,
    bubbles: bubblesSchema.catch([]).parse(row.bubbles),
    attachments: (Array.isArray(row.attachments) ? row.attachments : []) as BotAttachment[],
    toolCalls: (Array.isArray(row.toolCalls) ? row.toolCalls : []) as { name: string; ok: boolean }[],
    createdAt: row.createdAt,
  };
}

export async function getPendingSuggestion(db: DbOrTx, conversationId: string): Promise<PendingSuggestion | null> {
  const [row] = await db
    .select()
    .from(waSuggestions)
    .where(and(eq(waSuggestions.conversationId, conversationId), eq(waSuggestions.status, "pending")))
    .orderBy(desc(waSuggestions.createdAt))
    .limit(1);
  return row ? toPending(row) : null;
}

export async function countPendingSuggestions(db: DbOrTx): Promise<number> {
  const [row] = await db.select({ total: count() }).from(waSuggestions).where(eq(waSuggestions.status, "pending"));
  return row?.total ?? 0;
}

/** Badge/toast: as conversas com sugestão pendente e um rótulo humano. */
export async function listPendingSuggestions(db: DbOrTx): Promise<{ conversationId: string; label: string; createdAt: Date }[]> {
  const rows = await db
    .select({ conversationId: waSuggestions.conversationId, createdAt: waSuggestions.createdAt, phoneE164: waConversations.phoneE164, customerName: customers.fullName })
    .from(waSuggestions)
    .innerJoin(waConversations, eq(waConversations.id, waSuggestions.conversationId))
    .leftJoin(customers, eq(customers.id, waConversations.customerId))
    .where(eq(waSuggestions.status, "pending"))
    .orderBy(desc(waSuggestions.createdAt));
  return rows.map((row) => ({ conversationId: row.conversationId, label: row.customerName ?? maskPhone(row.phoneE164), createdAt: row.createdAt }));
}

/** As conversas (ids) com sugestão pendente — para a lista marcar. */
export async function conversationIdsWithPendingSuggestion(db: DbOrTx, conversationIds: readonly string[]): Promise<Set<string>> {
  if (conversationIds.length === 0) return new Set();
  const rows = await db
    .select({ conversationId: waSuggestions.conversationId })
    .from(waSuggestions)
    .where(and(eq(waSuggestions.status, "pending"), inArray(waSuggestions.conversationId, [...conversationIds])));
  return new Set(rows.map((row) => row.conversationId));
}

/**
 * Enviar (como está ou editada): a sugestão vira 'sent' e a fila entrega —
 * na transação, com dedupe por sugestão. Só a pendente aceita.
 */
export async function approveSuggestion(
  db: DbOrTx,
  input: { suggestionId: string; userId: string; body?: string | null; now?: Date },
): Promise<{ queued: true }> {
  const suggestionId = z.uuid().parse(input.suggestionId);
  const now = input.now ?? new Date();
  const finalBubbles = input.body && input.body.trim() !== "" ? bubblesSchema.parse([input.body.trim()]) : null;
  const updated = await db
    .update(waSuggestions)
    .set({ status: "sent", sentBy: input.userId, sentAt: now, finalBubbles, updatedAt: now })
    .where(and(eq(waSuggestions.id, suggestionId), eq(waSuggestions.status, "pending")))
    .returning({ id: waSuggestions.id, conversationId: waSuggestions.conversationId });
  if (updated.length === 0) throw new ServiceError("sugestao_indisponivel", "Esta sugestão já foi enviada, descartada ou superada por uma mensagem nova.");
  await enqueueOutboxEvent(db, {
    eventType: SUGGESTION_SEND_EVENT,
    dedupeKey: `wa.suggestion_send:${suggestionId}`,
    aggregateType: "wa_conversation",
    aggregateId: updated[0].conversationId,
    payload: { suggestionId },
  });
  await db.insert(auditLog).values({
    actorType: "user",
    actorId: input.userId,
    action: "wa.suggestion_approved",
    entityType: "wa_conversation",
    entityId: updated[0].conversationId,
    after: { suggestionId, edited: finalBubbles !== null },
  });
  return { queued: true };
}

export async function discardSuggestion(db: DbOrTx, input: { suggestionId: string; userId: string; now?: Date }): Promise<{ discarded: boolean }> {
  const suggestionId = z.uuid().parse(input.suggestionId);
  const now = input.now ?? new Date();
  const updated = await db
    .update(waSuggestions)
    .set({ status: "discarded", discardedBy: input.userId, discardedAt: now, updatedAt: now })
    .where(and(eq(waSuggestions.id, suggestionId), eq(waSuggestions.status, "pending")))
    .returning({ id: waSuggestions.id, conversationId: waSuggestions.conversationId });
  if (updated.length === 0) return { discarded: false };
  await db.insert(auditLog).values({
    actorType: "user",
    actorId: input.userId,
    action: "wa.suggestion_discarded",
    entityType: "wa_conversation",
    entityId: updated[0].conversationId,
    after: { suggestionId },
  });
  return { discarded: true };
}

export type SendSuggestionResult = { sent: true; replied: boolean } | { skipped: "inexistente" | "nao_aprovada" | "conversa_inexistente" };

/**
 * Handler de wa.suggestion_send: entrega os balões (editados ou originais) e
 * os anexos com os dedupes de um turno da Lia (`suggestion:<id>`) — a
 * reentrada nunca duplica. Sai como mensagem da Lia (origem 'bot').
 */
export async function sendApprovedSuggestion(
  db: DbOrTx,
  provider: MessagingProvider,
  input: z.input<typeof suggestionSendPayloadSchema>,
): Promise<SendSuggestionResult> {
  const { suggestionId } = suggestionSendPayloadSchema.parse(input);
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(waSuggestions).where(eq(waSuggestions.id, suggestionId)).for("update");
    if (!row) return { skipped: "inexistente" };
    if (row.status !== "sent") return { skipped: "nao_aprovada" };
    const [conversation] = await tx
      .select({ phoneE164: waConversations.phoneE164, customerId: waConversations.customerId })
      .from(waConversations)
      .where(eq(waConversations.id, row.conversationId))
      .limit(1);
    if (!conversation) return { skipped: "conversa_inexistente" };
    const pending = toPending(row);
    const bubbles = row.finalBubbles ? bubblesSchema.catch(pending.bubbles).parse(row.finalBubbles) : pending.bubbles;
    const delivered = await deliverBotTurn(tx, provider, {
      conversation,
      dedupeBase: `suggestion:${suggestionId}`,
      // Editada pela dona: o anexo da Lia pode não combinar mais com o texto — só o texto.
      attachments: row.finalBubbles ? [] : pending.attachments,
      bubbles,
      handedOff: false,
    });
    return { sent: true, replied: delivered.replied };
  });
}

/** A última inbound de uma conversa (para o cartão saber o que a Lia respondeu). */
export async function getInboundPreview(db: DbOrTx, inboundMessageId: string | null): Promise<string | null> {
  if (!inboundMessageId) return null;
  const [row] = await db.select({ body: waMessages.body }).from(waMessages).where(eq(waMessages.id, inboundMessageId)).limit(1);
  return row?.body ?? null;
}
