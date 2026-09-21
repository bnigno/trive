// Handler de `push.new_message`: relê a conversa na hora de mandar (a fila
// só carrega ids) e avisa cada aparelho inscrito. Quem já leu não recebe;
// a conversa de avisos internos nunca; inscrição morta (404/410) é apagada;
// falha transitória em qualquer aparelho lança para a fila tentar de novo —
// e a repetição pula os aparelhos que já receberam (o handler anota cada
// sucesso em `payload.sentTo` do próprio evento), para ninguém vibrar duas vezes.
import { and, desc, eq, sql } from "drizzle-orm";

import type { PushProvider } from "@/adapters/push";
import { parseBotState } from "@/core/bot/memory";
import { PUSH_TTL_SECONDS, type PushNewMessagePayload, pushPayloadFor } from "@/core/notify/push";
import { customers, outboxEvents, pushSubscriptions, waConversations, waMessages } from "@/db/schema";
import { maskPhone } from "@/lib/phone";
import { inboundPreview } from "@/lib/wa-preview";
import type { DbOrTx } from "@/queue/enqueue";
import { listActivePushSubscriptions } from "@/services/push-subscriptions";
import { isBotEnabled } from "@/services/wa-bot";
import { isOwnerPhone } from "@/services/wa-messaging";

export type PushNotifyResult =
  | { sent: number; removed: number; alreadySent: number; skipped?: undefined }
  | { skipped: "conversa_inexistente" | "mensagem_inexistente" | "ja_vista" | "avisos_internos" | "sem_inscricoes" | "encerrada" };

export async function sendPushForConversation(
  db: DbOrTx,
  provider: PushProvider,
  input: PushNewMessagePayload,
  opts: { outboxEventId?: string } = {},
): Promise<PushNotifyResult> {
  const [conversation] = await db
    .select({
      id: waConversations.id,
      phoneE164: waConversations.phoneE164,
      status: waConversations.status,
      botDisabledUntil: waConversations.botDisabledUntil,
      ownerLastSeenAt: waConversations.ownerLastSeenAt,
      botState: waConversations.botState,
      customerName: customers.fullName,
    })
    .from(waConversations)
    .leftJoin(customers, eq(customers.id, waConversations.customerId))
    .where(eq(waConversations.id, input.conversationId))
    .limit(1);
  if (!conversation) return { skipped: "conversa_inexistente" };
  if (conversation.status === "closed") return { skipped: "encerrada" };
  if (await isOwnerPhone(db, conversation.phoneE164)) return { skipped: "avisos_internos" };

  // A prévia é da ÚLTIMA inbound (a janela de 2 min pode ter juntado mais de
  // uma); o "já vista" olha essa última: se o dono abriu depois dela, nada.
  const [last] = await db
    .select({ id: waMessages.id, body: waMessages.body, createdAt: waMessages.createdAt })
    .from(waMessages)
    .where(and(eq(waMessages.conversationId, conversation.id), eq(waMessages.direction, "inbound")))
    .orderBy(desc(waMessages.createdAt))
    .limit(1);
  if (!last) return { skipped: "mensagem_inexistente" };
  if (conversation.ownerLastSeenAt && conversation.ownerLastSeenAt.getTime() >= last.createdAt.getTime()) return { skipped: "ja_vista" };

  const subscriptions = await listActivePushSubscriptions(db);
  if (subscriptions.length === 0) return { skipped: "sem_inscricoes" };

  const botEnabled = await isBotEnabled(db);
  const awaitingOwner =
    !botEnabled ||
    conversation.status === "human" ||
    (conversation.botDisabledUntil !== null && conversation.botDisabledUntil.getTime() > Date.now());
  const displayName = parseBotState(conversation.botState).displayName?.trim() || null;
  const payload = pushPayloadFor({
    conversationId: conversation.id,
    label: conversation.customerName ?? displayName ?? maskPhone(conversation.phoneE164),
    preview: inboundPreview(last.body),
    awaitingOwner,
  });

  let sent = 0;
  let removed = 0;
  let alreadySent = 0;
  const sentTo = new Set(input.sentTo ?? []);
  const transient: string[] = [];
  for (const subscription of subscriptions) {
    if (sentTo.has(subscription.id)) {
      alreadySent += 1;
      continue;
    }
    const result = await provider.send({ subscription, payload, ttlSeconds: PUSH_TTL_SECONDS });
    if (result.ok) {
      sent += 1;
      sentTo.add(subscription.id);
      await db.update(pushSubscriptions).set({ lastOkAt: sql`now()`, lastError: null }).where(eq(pushSubscriptions.id, subscription.id));
      if (opts.outboxEventId) {
        await db
          .update(outboxEvents)
          .set({ payload: sql`${outboxEvents.payload} || jsonb_build_object('sentTo', ${JSON.stringify([...sentTo])}::jsonb)` })
          .where(eq(outboxEvents.id, opts.outboxEventId));
      }
    } else if (result.gone) {
      removed += 1;
      await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, subscription.id));
    } else {
      transient.push(`${subscription.endpoint.slice(0, 60)}: ${result.error}`);
      await db.update(pushSubscriptions).set({ lastError: result.error.slice(0, 300) }).where(eq(pushSubscriptions.id, subscription.id));
    }
  }
  if (transient.length > 0) {
    throw new Error(`push.new_message: ${transient.length} de ${subscriptions.length} falharam — ${transient.join("; ")}`);
  }
  return { sent, removed, alreadySent };
}
