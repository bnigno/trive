// O "toque" que cada mensagem recebida dá na conversa — última entrada,
// LID/cliente que faltavam, nome do WhatsApp, ponte do site — separado do
// registro da mensagem. Enquanto a Lia responde, a linha da conversa está
// presa (FOR UPDATE do turno); o webhook NÃO espera por ela: tenta o toque
// com um lock_timeout curto e, se a linha estiver presa, deixa o toque na
// fila (wa.conversation_touch). Quem pegar a conversa em seguida — o próprio
// turno, ao adquirir o lock, ou o worker — aplica. Todo toque é idempotente
// (greatest/coalesce/merge), então a ordem de chegada não importa.
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { mergeBridgeIntoState, parseBotState } from "@/core/bot/memory";
import { bridgeStateSchema } from "@/core/bot/site-bridge";
import { outboxEvents, waConversations } from "@/db/schema";
import { enqueueOutboxEvent, type DbOrTx } from "@/queue/enqueue";

/** Quanto o webhook espera pela linha da conversa antes de deixar o toque para depois. */
export const CONVERSATION_TOUCH_LOCK_TIMEOUT_MS = 3_000;
export const CONVERSATION_TOUCH_EVENT = "wa.conversation_touch";

export const conversationTouchSchema = z.object({
  conversationId: z.uuid(),
  /** Quando a mensagem chegou (ISO). */
  inboundAt: z.iso.datetime(),
  lid: z.string().nullable().optional(),
  customerId: z.uuid().nullable().optional(),
  displayName: z.string().max(80).optional(),
  /** Anotações que acompanham o telefone quando a conversa anterior foi fechada. */
  notes: z.array(z.string()).optional(),
  bridge: bridgeStateSchema.optional(),
});
export type ConversationTouch = z.infer<typeof conversationTouchSchema>;

/** Código do Postgres para "lock_timeout estourou" — o erro pode vir embrulhado pelo drizzle. */
export function isLockTimeoutError(error: unknown): boolean {
  const code = (candidate: unknown) => (typeof candidate === "object" && candidate !== null ? (candidate as { code?: unknown }).code : undefined);
  return code(error) === "55P03" || code((error as { cause?: unknown } | null)?.cause) === "55P03";
}

/**
 * Aplica o toque na linha (quem chama já tem o lock, ou aceita esperar).
 * greatest/coalesce/merge: aplicar duas vezes, ou fora de ordem, dá no mesmo.
 */
export async function applyConversationTouch(tx: DbOrTx, touch: ConversationTouch): Promise<void> {
  const inboundAt = new Date(touch.inboundAt);
  const patch: Record<string, unknown> = {
    lastInboundAt: sql`greatest(coalesce(${waConversations.lastInboundAt}, ${inboundAt}), ${inboundAt})`,
    updatedAt: sql`greatest(${waConversations.updatedAt}, ${inboundAt})`,
  };
  if (touch.lid) patch.lid = sql`coalesce(${waConversations.lid}, ${touch.lid})`;
  // Nunca sobrescreve um vínculo existente com outro cliente.
  if (touch.customerId) patch.customerId = sql`coalesce(${waConversations.customerId}, ${touch.customerId})`;
  const stateMerges: string[] = [];
  if (touch.notes && touch.notes.length > 0) stateMerges.push(JSON.stringify({ notes: touch.notes }));
  if (touch.displayName) stateMerges.push(JSON.stringify({ displayName: touch.displayName }));
  if (stateMerges.length > 0) {
    patch.botState = stateMerges.reduce<ReturnType<typeof sql>>(
      (acc, merge) => sql`${acc} || ${merge}::jsonb`,
      sql`coalesce(${waConversations.botState}, '{}'::jsonb)`,
    );
  }
  await tx.update(waConversations).set(patch).where(eq(waConversations.id, touch.conversationId));

  // A ponte do site funde a sacola do site com a da conversa: é regra do core,
  // por isso lê e regrava — só com a linha nossa (o chamador garante).
  if (touch.bridge) {
    const [current] = await tx
      .select({ botState: waConversations.botState })
      .from(waConversations)
      .where(eq(waConversations.id, touch.conversationId))
      .limit(1);
    await tx
      .update(waConversations)
      .set({ botState: mergeBridgeIntoState(parseBotState(current?.botState), touch.bridge), updatedAt: inboundAt })
      .where(eq(waConversations.id, touch.conversationId));
  }
}

/**
 * O webhook: tenta o toque agora, esperando no máximo CONVERSATION_TOUCH_LOCK_TIMEOUT_MS
 * pela linha (um savepoint isola o erro; a transação de quem chama segue).
 * Linha presa (a Lia está no meio do turno): o toque vai para a fila e o
 * turno seguinte o aplica assim que pegar a conversa. Devolve o id do evento
 * enfileirado, ou null quando aplicou na hora.
 */
export async function touchConversationOrDefer(tx: DbOrTx, touch: ConversationTouch): Promise<string | null> {
  try {
    await tx.transaction(async (savepoint) => {
      await savepoint.execute(sql.raw(`set local lock_timeout = '${CONVERSATION_TOUCH_LOCK_TIMEOUT_MS}ms'`));
      await applyConversationTouch(savepoint, touch);
    });
    return null;
  } catch (error) {
    if (!isLockTimeoutError(error)) throw error;
  }
  // O toque entra na fila ANTES do turno desta mensagem (next_attempt_at um
  // segundo atrás): quem drenar a conversa aplica o toque primeiro.
  return enqueueOutboxEvent(
    tx,
    {
      eventType: CONVERSATION_TOUCH_EVENT,
      aggregateType: "wa_conversation",
      aggregateId: touch.conversationId,
      payload: touch,
      nextAttemptAt: new Date(Date.now() - 1_000),
    },
    { kick: false },
  );
}

/**
 * O turno, já com a conversa em FOR UPDATE: aplica os toques que ficaram na
 * fila para esta conversa e os dá por feitos. Uma linha que o worker já
 * reclamou (processing) fica com ele — o handler espera o lock e aplica
 * depois do commit; o merge é o mesmo.
 */
export async function applyPendingConversationTouches(tx: DbOrTx, conversationId: string): Promise<number> {
  const rows = await tx
    .select({ id: outboxEvents.id, payload: outboxEvents.payload })
    .from(outboxEvents)
    .where(
      and(
        eq(outboxEvents.eventType, CONVERSATION_TOUCH_EVENT),
        eq(outboxEvents.aggregateId, conversationId),
        eq(outboxEvents.status, "pending"),
      ),
    )
    .orderBy(outboxEvents.createdAt)
    .for("update", { skipLocked: true });
  for (const row of rows) {
    const parsed = conversationTouchSchema.safeParse(row.payload);
    if (parsed.success) await applyConversationTouch(tx, parsed.data);
    await tx
      .update(outboxEvents)
      .set({ status: "done", processedAt: new Date(), lastError: parsed.success ? null : "payload inválido: ignorado" })
      .where(eq(outboxEvents.id, row.id));
  }
  return rows.length;
}
