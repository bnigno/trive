// Serviço de WEBHOOKS inbound da Z-API (mensagem recebida no WhatsApp).
// Autenticação: o [secret] do path DEVE bater com ZAPI_WEBHOOK_SECRET (rota
// devolve 404 num mismatch — não revelamos que o endpoint existe); quando a
// Z-API manda o header Client-Token, ele também precisa bater. Idempotência
// por inbound_events (source 'zapi' + messageId). Comando SAIR/PARAR desliga
// o opt-in (LGPD) e confirma — SEMPRE antes de qualquer bot. Outro texto:
// se a conversa está 'open', o bot não está silenciado (bot_disabled_until)
// e o bot de vendas está habilitado, enfileira 'wa.bot_turn'; senão o texto
// é encaminhado ao DONO via outbox — humano responde.
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import {
  auditLog,
  customers,
  inboundEvents,
  waConversations,
  waMessages,
} from "@/db/schema";
import { isValidE164, toE164BR } from "@/lib/phone";
import { enqueueOutboxEvent, type DbOrTx } from "@/queue/enqueue";
import { isBotEnabled } from "@/services/wa-bot";

export const OPT_OUT_ACK_BODY =
  "Pronto! Você não receberá mais avisos. Se mudar de ideia, é só chamar. 💬";

const FORWARD_BODY_MAX_CHARS = 300;

// Corpo tolerante: a Z-API varia o formato entre versões — texto vem em
// text.message ou body.message; phone/messageId às vezes chegam numéricos.
// Qualquer coisa fora do reconhecível vira {} e o evento é ignorado.
const zapiInboundBodySchema = z
  .object({
    messageId: z.union([z.string(), z.number()]).optional(),
    phone: z.union([z.string(), z.number()]).optional(),
    fromMe: z.boolean().optional(),
    isGroup: z.boolean().optional(),
    senderName: z.string().optional(),
    chatName: z.string().optional(),
    text: z.object({ message: z.string().optional() }).optional(),
    body: z.object({ message: z.string().optional() }).optional(),
    // Callback de status de mensagem (webhook update-webhook-message-status):
    // status SENT/RECEIVED/READ/PLAYED + ids das mensagens afetadas.
    status: z.string().optional(),
    ids: z.array(z.union([z.string(), z.number()])).optional(),
    type: z.string().optional(),
  })
  .or(z.unknown().transform(() => ({}) as Record<string, never>));

export type ProcessZapiInboundInput = {
  /** O segmento [secret] do path do webhook. */
  providedSecret: string;
  /** Header 'client-token' enviado pela Z-API (quando configurado lá). */
  clientToken?: string | null;
  /** Body JSON já parseado (qualquer formato — validado aqui com tolerância). */
  body: unknown;
};

export type ProcessZapiInboundResult =
  | { action: "rejected"; rejected: "secret" | "client_token" }
  | { action: "ignored"; ignored: true }
  | { action: "duplicate"; duplicate: true }
  | { action: "status"; updated: number }
  | {
      action: "opt_out";
      conversationId: string;
      waMessageId: string;
      /** true quando havia cliente cadastrado com esse telefone para desligar. */
      optedOut: boolean;
    }
  | { action: "forwarded"; conversationId: string; waMessageId: string }
  | { action: "bot_queued"; conversationId: string; waMessageId: string };

/** trim + maiúsculas + sem acento, para comparar comandos como SAIR/PARAR. */
function normalizeKeyword(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toUpperCase();
}

/** Z-API manda '5511999998888' (sem '+'): normaliza BR; aceita E.164 estrangeiro. */
function normalizePhone(raw: string): string | null {
  const br = toE164BR(raw);
  if (br) return br;
  const digits = raw.replace(/\D/g, "");
  const candidate = `+${digits}`;
  return isValidE164(candidate) ? candidate : null;
}

export async function processZapiInbound(
  db: DbOrTx,
  input: ProcessZapiInboundInput,
): Promise<ProcessZapiInboundResult> {
  const expectedSecret = process.env.ZAPI_WEBHOOK_SECRET;
  if (!expectedSecret || input.providedSecret !== expectedSecret) {
    return { action: "rejected", rejected: "secret" };
  }

  const expectedClientToken = process.env.ZAPI_CLIENT_TOKEN;
  if (
    expectedClientToken &&
    input.clientToken != null &&
    input.clientToken !== expectedClientToken
  ) {
    return { action: "rejected", rejected: "client_token" };
  }

  const parsed = zapiInboundBodySchema.parse(input.body ?? {});
  const messageId =
    parsed.messageId !== undefined ? String(parsed.messageId) : undefined;
  const rawPhone = parsed.phone !== undefined ? String(parsed.phone) : undefined;
  const text = parsed.text?.message ?? parsed.body?.message;

  // Callback de STATUS de mensagem (entregue/lida): atualiza wa_messages
  // pelo zapi_message_id de forma MONOTÔNICA (nunca regride) — é o que torna
  // visível uma mensagem "aceita mas nunca entregue" (número sem WhatsApp).
  const statusUpper = parsed.status?.toUpperCase();
  const statusTarget =
    statusUpper === "RECEIVED" || statusUpper === "DELIVERED"
      ? "delivered"
      : statusUpper === "READ" || statusUpper === "PLAYED"
        ? "read"
        : null;
  const statusIds = (parsed.ids ?? (messageId ? [messageId] : [])).map(String);
  if (statusTarget && statusIds.length > 0 && !text) {
    let updated = 0;
    for (const id of statusIds) {
      const res = await db
        .update(waMessages)
        .set(
          statusTarget === "read"
            ? { status: "read", readAt: new Date() }
            : { status: "delivered", deliveredAt: new Date() },
        )
        .where(
          and(
            eq(waMessages.zapiMessageId, id),
            statusTarget === "read"
              ? inArray(waMessages.status, ["sent", "delivered"])
              : eq(waMessages.status, "sent"),
          ),
        )
        .returning({ id: waMessages.id });
      updated += res.length;
    }
    return { action: "status", updated };
  }

  // Sem texto = status/ack/mídia — por ora ignorados (não registram inbound,
  // senão o DELIVERED consumiria o dedupe do messageId). Ecos das nossas
  // próprias mensagens (fromMe) e grupos também não entram no fluxo.
  if (!messageId || !rawPhone || !text || parsed.fromMe === true || parsed.isGroup === true) {
    return { action: "ignored", ignored: true };
  }

  const phoneE164 = normalizePhone(rawPhone);
  if (!phoneE164) {
    return { action: "ignored", ignored: true };
  }

  return db.transaction(async (tx) => {
    const insertedInbound = await tx
      .insert(inboundEvents)
      .values({
        source: "zapi",
        externalEventId: messageId,
        eventType: "message.received",
        payload: (input.body ?? {}) as Record<string, unknown>,
      })
      .onConflictDoNothing({
        target: [inboundEvents.source, inboundEvents.externalEventId],
      })
      .returning({ id: inboundEvents.id });

    const inboundId = insertedInbound[0]?.id;
    if (!inboundId) {
      // Z-API reentregou o mesmo messageId: tudo já registrado/enfileirado.
      return { action: "duplicate", duplicate: true } as const;
    }

    const [customer] = await tx
      .select({
        id: customers.id,
        fullName: customers.fullName,
        marketingOptIn: customers.marketingOptIn,
      })
      .from(customers)
      .where(and(eq(customers.phoneE164, phoneE164), isNull(customers.deletedAt)))
      .limit(1);

    const now = new Date();

    // No máximo UMA conversa não-fechada por telefone (unique parcial):
    // upsert reaproveita a aberta; conversa fechada não conflita e nasce outra.
    const [conversation] = await tx
      .insert(waConversations)
      .values({
        phoneE164,
        customerId: customer?.id ?? null,
        lastInboundAt: now,
      })
      .onConflictDoUpdate({
        target: waConversations.phoneE164,
        targetWhere: sql`${waConversations.status} <> 'closed'`,
        set: {
          lastInboundAt: now,
          updatedAt: now,
          // Nunca sobrescreve um vínculo existente com outro cliente.
          ...(customer
            ? { customerId: sql`coalesce(${waConversations.customerId}, ${customer.id})` }
            : {}),
        },
      })
      .returning({
        id: waConversations.id,
        status: waConversations.status,
        botDisabledUntil: waConversations.botDisabledUntil,
      });

    const [message] = await tx
      .insert(waMessages)
      .values({
        conversationId: conversation.id,
        direction: "inbound",
        zapiMessageId: messageId,
        body: text,
        status: "delivered",
        deliveredAt: now,
      })
      .onConflictDoNothing({ target: waMessages.zapiMessageId })
      .returning({ id: waMessages.id });

    if (!message) {
      return { action: "duplicate", duplicate: true } as const;
    }

    const markDone = () =>
      tx
        .update(inboundEvents)
        .set({ status: "done", processedAt: new Date() })
        .where(eq(inboundEvents.id, inboundId));

    const keyword = normalizeKeyword(text);
    if (keyword === "SAIR" || keyword === "PARAR") {
      if (customer) {
        await tx
          .update(customers)
          .set({ marketingOptIn: false, updatedAt: sql`now()` })
          .where(eq(customers.id, customer.id));

        await tx.insert(auditLog).values({
          actorType: "customer",
          actorId: customer.id,
          action: "wa.opt_out",
          entityType: "customer",
          entityId: customer.id,
          before: { marketingOptIn: customer.marketingOptIn },
          after: { marketingOptIn: false },
          reason: `Comando ${keyword} recebido via WhatsApp`,
        });
      }

      // Confirmação educada — resposta transacional a um pedido do próprio
      // cliente, portanto NÃO exige opt-in. Sai pela fila como tudo.
      await enqueueOutboxEvent(tx, {
        eventType: "wa.send",
        dedupeKey: `wa.optout_ack:${messageId}`,
        aggregateType: "wa_conversation",
        aggregateId: conversation.id,
        payload: {
          templateKey: null,
          phoneE164,
          body: OPT_OUT_ACK_BODY,
          dedupeKey: `wa.optout_ack:${messageId}`,
        },
      });

      await markDone();
      return {
        action: "opt_out",
        conversationId: conversation.id,
        waMessageId: message.id,
        optedOut: customer !== undefined,
      } as const;
    }

    // Texto comum: se a conversa está 'open', o bot não está silenciado
    // (bot_disabled_until nulo ou no passado) e o bot de vendas está ligado,
    // o turno vai para a fila — a resposta acontece no handler 'wa.bot_turn',
    // nunca inline no webhook. Checagens baratas primeiro; isBotEnabled (que
    // consulta settings) só roda quando a conversa é elegível.
    const botEligible =
      conversation.status === "open" &&
      (conversation.botDisabledUntil === null ||
        conversation.botDisabledUntil.getTime() <= now.getTime()) &&
      (await isBotEnabled(tx));

    if (botEligible) {
      await enqueueOutboxEvent(tx, {
        eventType: "wa.bot_turn",
        dedupeKey: `wa.bot_turn:${messageId}`,
        aggregateType: "wa_conversation",
        aggregateId: conversation.id,
        payload: { conversationId: conversation.id },
      });

      await markDone();
      return {
        action: "bot_queued",
        conversationId: conversation.id,
        waMessageId: message.id,
      } as const;
    }

    // Bot desligado/silenciado ou conversa assumida por humano: encaminha ao
    // DONO (aviso interno, sem opt-in) e um humano responde.
    await enqueueOutboxEvent(tx, {
      eventType: "wa.owner_forward",
      dedupeKey: `wa.fwd:${messageId}`,
      aggregateType: "wa_conversation",
      aggregateId: conversation.id,
      payload: {
        phoneE164,
        body: text.slice(0, FORWARD_BODY_MAX_CHARS),
        ...(customer ? { customerName: customer.fullName } : {}),
      },
    });

    await markDone();
    return {
      action: "forwarded",
      conversationId: conversation.id,
      waMessageId: message.id,
    } as const;
  });
}
