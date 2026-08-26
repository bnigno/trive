// Painel de conversas do WhatsApp (Fase 5, Onda C): leitura das conversas e
// ações do dono — assumir o atendimento, devolver ao bot e responder na mão.
// Resposta manual SEMPRE assume a conversa: com duas "vozes" ativas (dono e
// bot) o cliente receberia respostas conflitantes. O envio em si vai pela
// fila ('wa.send'), nunca inline — se a sessão Z-API cair, nada se perde.
import { desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { auditLog, customers, waConversations, waMessages } from "@/db/schema";
import { enqueueOutboxEvent, type DbOrTx } from "@/queue/enqueue";
import { ServiceError } from "@/services/settings";

// ---------------------------------------------------------------------------
// Leitura — lista e thread
// ---------------------------------------------------------------------------

export interface WaConversationListItem {
  id: string;
  phoneE164: string;
  customerName: string | null;
  status: string;
  botDisabledUntil: Date | null;
  lastMessageAt: Date | null;
  lastMessageDirection: "inbound" | "outbound" | null;
  lastMessagePreview: string | null;
}

export async function listWaConversations(
  db: DbOrTx,
  options: { limit?: number } = {},
): Promise<WaConversationListItem[]> {
  const limit = options.limit ?? 50;

  const rows = await db
    .select({
      id: waConversations.id,
      phoneE164: waConversations.phoneE164,
      customerName: customers.fullName,
      status: waConversations.status,
      botDisabledUntil: waConversations.botDisabledUntil,
      updatedAt: waConversations.updatedAt,
    })
    .from(waConversations)
    .leftJoin(customers, eq(customers.id, waConversations.customerId))
    .orderBy(desc(waConversations.updatedAt))
    .limit(limit);

  if (rows.length === 0) return [];

  // Última mensagem de cada conversa em uma única consulta (DISTINCT ON).
  const ids = rows.map((row) => row.id);
  const lastMessages = await db
    .selectDistinctOn([waMessages.conversationId], {
      conversationId: waMessages.conversationId,
      direction: waMessages.direction,
      body: waMessages.body,
      createdAt: waMessages.createdAt,
    })
    .from(waMessages)
    .where(inArray(waMessages.conversationId, ids))
    .orderBy(waMessages.conversationId, desc(waMessages.createdAt));

  const byConversation = new Map(
    lastMessages.map((message) => [message.conversationId, message]),
  );

  return rows.map((row) => {
    const last = byConversation.get(row.id) ?? null;
    return {
      id: row.id,
      phoneE164: row.phoneE164,
      customerName: row.customerName,
      status: row.status,
      botDisabledUntil: row.botDisabledUntil,
      lastMessageAt: last?.createdAt ?? null,
      lastMessageDirection:
        last?.direction === "inbound" || last?.direction === "outbound"
          ? last.direction
          : null,
      lastMessagePreview: last?.body ?? null,
    };
  });
}

export interface WaThreadMessage {
  id: string;
  direction: "inbound" | "outbound";
  /** 'text' | 'image' (body é a legenda) | 'option_list' (body traz o menu). */
  kind: string;
  body: string;
  mediaUrl: string | null;
  templateKey: string | null;
  status: string;
  errorDetail: string | null;
  createdAt: Date;
}

export interface WaConversationThread {
  conversation: {
    id: string;
    phoneE164: string;
    customerId: string | null;
    customerName: string | null;
    status: string;
    botDisabledUntil: Date | null;
    createdAt: Date;
  };
  messages: WaThreadMessage[];
}

export async function getWaConversationThread(
  db: DbOrTx,
  conversationId: string,
): Promise<WaConversationThread | null> {
  const [conversation] = await db
    .select({
      id: waConversations.id,
      phoneE164: waConversations.phoneE164,
      customerId: waConversations.customerId,
      customerName: customers.fullName,
      status: waConversations.status,
      botDisabledUntil: waConversations.botDisabledUntil,
      createdAt: waConversations.createdAt,
    })
    .from(waConversations)
    .leftJoin(customers, eq(customers.id, waConversations.customerId))
    .where(eq(waConversations.id, conversationId))
    .limit(1);
  if (!conversation) return null;

  const rows = await db
    .select({
      id: waMessages.id,
      direction: waMessages.direction,
      kind: waMessages.kind,
      body: waMessages.body,
      mediaUrl: waMessages.mediaUrl,
      templateKey: waMessages.templateKey,
      status: waMessages.status,
      errorDetail: waMessages.errorDetail,
      createdAt: waMessages.createdAt,
    })
    .from(waMessages)
    .where(eq(waMessages.conversationId, conversationId))
    .orderBy(waMessages.createdAt);

  return {
    conversation,
    messages: rows.map((row) => ({
      ...row,
      direction: row.direction === "inbound" ? "inbound" : "outbound",
    })),
  };
}

// ---------------------------------------------------------------------------
// Ações do dono
// ---------------------------------------------------------------------------

async function loadConversationForAction(db: DbOrTx, conversationId: string) {
  const [conversation] = await db
    .select({
      id: waConversations.id,
      phoneE164: waConversations.phoneE164,
      customerId: waConversations.customerId,
      status: waConversations.status,
    })
    .from(waConversations)
    .where(eq(waConversations.id, conversationId))
    .limit(1);
  if (!conversation) {
    throw new ServiceError("conversa_inexistente", "Conversa não encontrada.");
  }
  if (conversation.status === "closed") {
    throw new ServiceError(
      "conversa_fechada",
      "Esta conversa já foi encerrada.",
    );
  }
  return conversation;
}

const actorSchema = z.object({
  conversationId: z.uuid(),
  userId: z.uuid(),
});

/** Dono assume a conversa: o bot para de responder imediatamente. */
export async function takeOverWaConversation(
  db: DbOrTx,
  input: z.input<typeof actorSchema>,
): Promise<{ status: "human" }> {
  const parsed = actorSchema.parse(input);
  const conversation = await loadConversationForAction(
    db,
    parsed.conversationId,
  );
  if (conversation.status === "human") return { status: "human" };

  await db
    .update(waConversations)
    .set({ status: "human", updatedAt: new Date() })
    .where(eq(waConversations.id, conversation.id));
  await db.insert(auditLog).values({
    actorType: "user",
    actorId: parsed.userId,
    action: "wa.conversation_takeover",
    entityType: "wa_conversation",
    entityId: conversation.id,
    before: { status: conversation.status },
    after: { status: "human" },
  });
  return { status: "human" };
}

/** Dono devolve a conversa ao bot: reabre e limpa o silêncio pós-handoff. */
export async function returnWaConversationToBot(
  db: DbOrTx,
  input: z.input<typeof actorSchema>,
): Promise<{ status: "open" }> {
  const parsed = actorSchema.parse(input);
  const conversation = await loadConversationForAction(
    db,
    parsed.conversationId,
  );

  await db
    .update(waConversations)
    .set({ status: "open", botDisabledUntil: null, updatedAt: new Date() })
    .where(eq(waConversations.id, conversation.id));
  await db.insert(auditLog).values({
    actorType: "user",
    actorId: parsed.userId,
    action: "wa.conversation_return_to_bot",
    entityType: "wa_conversation",
    entityId: conversation.id,
    before: { status: conversation.status },
    after: { status: "open", botDisabledUntil: null },
  });
  return { status: "open" };
}

const manualReplySchema = actorSchema.extend({
  body: z
    .string()
    .trim()
    .min(1, "Escreva a mensagem antes de enviar.")
    .max(4000, "A mensagem deve ter no máximo 4000 caracteres."),
});

/**
 * Resposta manual do dono. Assume a conversa (se ainda estava com o bot) e
 * enfileira o envio; o dedupe único por clique fica no evento da fila.
 */
export async function sendManualWaReply(
  db: DbOrTx,
  input: z.input<typeof manualReplySchema>,
): Promise<{ queued: true }> {
  const parsed = manualReplySchema.parse(input);
  const conversation = await loadConversationForAction(
    db,
    parsed.conversationId,
  );

  if (conversation.status !== "human") {
    await takeOverWaConversation(db, {
      conversationId: parsed.conversationId,
      userId: parsed.userId,
    });
  }

  await enqueueOutboxEvent(db, {
    eventType: "wa.send",
    aggregateType: "wa_conversation",
    aggregateId: conversation.id,
    payload: {
      phoneE164: conversation.phoneE164,
      body: parsed.body,
      ...(conversation.customerId ? { customerId: conversation.customerId } : {}),
    },
  });
  return { queued: true };
}
