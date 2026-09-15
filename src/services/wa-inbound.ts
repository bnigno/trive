// Serviço de WEBHOOKS inbound da Z-API (mensagem recebida no WhatsApp).
// Autenticação: o [secret] do path DEVE bater com ZAPI_WEBHOOK_SECRET (rota
// devolve 404 num mismatch — não revelamos que o endpoint existe); quando a
// Z-API manda o header Client-Token, ele também precisa bater. Idempotência
// por inbound_events (source 'zapi' + messageId). Comando SAIR/PARAR desliga
// o opt-in (LGPD) e confirma — SEMPRE antes de qualquer bot. Antes ainda,
// a mensagem do celular do DONO: foto, áudio ou recado com fotos recentes é
// o Ateliê (rascunho de peça), nunca a Lia; texto solto dele segue o fluxo
// normal, para ele poder testar a Lia como cliente. Outro texto:
// se a conversa está 'open', o bot não está silenciado (bot_disabled_until)
// e o bot de vendas está habilitado, enfileira 'wa.bot_turn'; senão o texto
// é encaminhado ao DONO via outbox — humano responde.
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import {
  auditLog,
  customers,
  inboundEvents,
  waConversations,
  waMessages,
} from "@/db/schema";
import { isTranscriptionConfigured } from "@/adapters/transcription";
import { INBOUND_MEDIA_MARKERS, type WaMediaMeta } from "@/core/whatsapp/media";
import { isValidE164, toE164BR } from "@/lib/phone";
import { enqueueOutboxEvent, kickOutbox, type DbOrTx } from "@/queue/enqueue";
import {
  enqueueAtelierHelp,
  enqueueAtelierNudge,
  isAtelierEnabled,
  openAtelierIntake,
  routeOwnerInbound,
} from "@/services/atelier";
import { lookConsentHistoryText, parseLookRowId } from "@/core/looks/consent";
import { feedbackHandledBy, feedbackHistoryText, parseFeedbackRowId } from "@/core/orders/feedback";
import { recordLookConsent } from "@/services/customer-looks";
import { cancelBotFollowupsByPhone } from "@/services/wa-followups";
import { recordDeliveryFeedback } from "@/services/delivery-feedback";
import { handOffToHuman } from "@/services/bot/owner";
import { isBotEnabled } from "@/services/wa-bot";
import { isBotMediaEnabled } from "@/services/wa-media";
import { firstNameOf, isOwnerPhone } from "@/services/wa-messaging";
import { findActiveCourierByPhone } from "@/services/couriers";
import { bridgeContextLine, extractBridgeCode } from "@/core/bot/site-bridge";
import { mergeBridgeIntoState, parseBotState } from "@/core/bot/memory";
import { cancelDropWaitlistByPhone } from "@/services/drop-waitlist";
import { cancelStockAlertsByPhone } from "@/services/stock-alerts";
import { consumeSiteCartByCode } from "@/services/site-carts";

export const OPT_OUT_ACK_BODY =
  "Pronto! Você não receberá mais avisos. Se mudar de ideia, é só chamar. 💬";

const FORWARD_BODY_MAX_CHARS = 300;

// Corpo tolerante: a Z-API varia o formato entre versões — texto vem em
// text.message ou body.message; respostas interativas (toque em lista de
// opções ou botão) chegam em listResponseMessage/buttonsResponseMessage;
// phone/messageId às vezes chegam numéricos. Qualquer coisa fora do
// reconhecível vira {} e o evento é ignorado.
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
    listResponseMessage: z
      .object({
        message: z.string().optional(),
        title: z.string().optional(),
        selectedRowId: z.string().optional(),
      })
      .optional(),
    buttonsResponseMessage: z
      .object({
        buttonId: z.string().optional(),
        message: z.string().optional(),
      })
      .optional(),
    // Mídia recebida (a Z-API manda um objeto por tipo). Registramos o fato
    // para a vendedora responder com honestidade em vez de ignorar a cliente.
    image: z
      .object({
        imageUrl: z.string().optional(),
        caption: z.string().optional(),
        mimeType: z.string().optional(),
        width: z.number().optional(),
        height: z.number().optional(),
      })
      .optional(),
    audio: z
      .object({
        audioUrl: z.string().optional(),
        mimeType: z.string().optional(),
        seconds: z.number().optional(),
      })
      .optional(),
    video: z.object({ videoUrl: z.string().optional() }).optional(),
    document: z
      .object({ documentUrl: z.string().optional(), fileName: z.string().optional() })
      .optional(),
    sticker: z.object({ stickerUrl: z.string().optional() }).optional(),
    location: z.object({ address: z.string().optional() }).optional(),
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
  | { action: "bot_queued"; conversationId: string; waMessageId: string }
  | { action: "transcribe_queued"; conversationId: string; waMessageId: string }
  // Ateliê (mensagem do dono): chegada aberta, foto guardada no lote ou
  // orientação de como mandar.
  | { action: "atelier_queued"; conversationId: string; waMessageId: string }
  | { action: "atelier_photo"; conversationId: string; waMessageId: string }
  | { action: "atelier_help"; conversationId: string; waMessageId: string }
  // Resposta ao "Chegou bem?" que vai direto para a equipe (defeito / falar).
  | { action: "feedback_handoff"; conversationId: string; waMessageId: string }
  | { action: "look_consent"; conversationId: string; waMessageId: string };

export type InboundRoute = "bot_queued" | "forwarded" | "atelier_queued" | "atelier_help";

/** trim + maiúsculas + sem acento, para comparar comandos como SAIR/PARAR. */
function normalizeKeyword(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toUpperCase();
}

// Toque numa lista de opções vira texto normal para o fluxo: option id
// 'produto:{slug}' vira um pedido explícito de detalhe (detalhar_produto
// resolve o slug com match exato); 'variante:{sku}' vira a escolha daquela
// combinação de cor/tamanho, pelo SKU exato (ambos os ids são montados em
// src/services/wa-bot.ts); outra opção usa o título visível.
function listResponseText(
  list:
    | { message?: string; title?: string; selectedRowId?: string }
    | undefined,
): string | undefined {
  if (!list) return undefined;
  const rowId = list.selectedRowId;
  if (rowId?.startsWith("produto:")) {
    return `Quero ver o produto ${rowId.slice("produto:".length)}`;
  }
  if (rowId?.startsWith("variante:")) {
    const sku = rowId.slice("variante:".length);
    const escolha = list.title ? `${list.title} ` : "";
    return `Escolhi esta opção: ${escolha}(SKU ${sku}). Confirme comigo essa combinação.`;
  }
  return list.title ?? list.message;
}

export { INBOUND_MEDIA_MARKERS };

type InboundMedia = {
  /** kind de wa_messages: foto e áudio têm representação própria no painel. */
  kind: "image" | "audio" | "text";
  body: string;
  mediaUrl?: string;
  mediaMeta?: WaMediaMeta;
};

/**
 * Mídia recebida vira uma mensagem inbound com um marcador em português: a
 * vendedora lê "[a cliente enviou um áudio]" (ou a transcrição, quando a
 * fila transcreve) e o painel mostra o que chegou em vez de sumir com a
 * mensagem.
 */
function describeInboundMedia(parsed: {
  image?: { imageUrl?: string; caption?: string; mimeType?: string; width?: number; height?: number };
  audio?: { audioUrl?: string; mimeType?: string; seconds?: number };
  video?: { videoUrl?: string };
  document?: { documentUrl?: string; fileName?: string };
  sticker?: { stickerUrl?: string };
  location?: { address?: string };
}): InboundMedia | undefined {
  if (parsed.image) {
    const caption = parsed.image.caption?.trim();
    return {
      kind: "image",
      body: caption
        ? `${INBOUND_MEDIA_MARKERS.image} ${caption}`
        : INBOUND_MEDIA_MARKERS.image,
      ...(parsed.image.imageUrl ? { mediaUrl: parsed.image.imageUrl } : {}),
      mediaMeta: {
        ...(parsed.image.mimeType ? { mimeType: parsed.image.mimeType } : {}),
        ...(parsed.image.width ? { width: parsed.image.width } : {}),
        ...(parsed.image.height ? { height: parsed.image.height } : {}),
      },
    };
  }
  if (parsed.audio) {
    return {
      kind: "audio",
      body: INBOUND_MEDIA_MARKERS.audio,
      ...(parsed.audio.audioUrl ? { mediaUrl: parsed.audio.audioUrl } : {}),
      mediaMeta: {
        ...(parsed.audio.mimeType ? { mimeType: parsed.audio.mimeType } : {}),
        ...(parsed.audio.seconds ? { seconds: parsed.audio.seconds } : {}),
      },
    };
  }
  if (parsed.video) return { kind: "text", body: INBOUND_MEDIA_MARKERS.video };
  if (parsed.document) {
    const name = parsed.document.fileName?.trim();
    return {
      kind: "text",
      body: name
        ? `${INBOUND_MEDIA_MARKERS.document} ${name}`
        : INBOUND_MEDIA_MARKERS.document,
    };
  }
  if (parsed.sticker) return { kind: "text", body: INBOUND_MEDIA_MARKERS.sticker };
  if (parsed.location) {
    return { kind: "text", body: INBOUND_MEDIA_MARKERS.location };
  }
  return undefined;
}

/**
 * Decisão de rota de uma mensagem da cliente, compartilhada pelo webhook e
 * pela transcrição: conversa 'open', bot não silenciado e ligado → turno
 * da vendedora na fila; senão → encaminha ao dono. Dedupes pelo id da
 * mensagem na Z-API: reentrega nunca duplica.
 */
export async function routeInboundMessage(
  tx: DbOrTx,
  input: {
    conversation: { id: string; status: string; botDisabledUntil: Date | null };
    phoneE164: string;
    zapiMessageId: string;
    /** O que a vendedora lê. */
    text: string;
    /** O que o dono lê no encaminhamento (default: o próprio texto). */
    forwardText?: string;
    customerName?: string;
    now: Date;
    /** A mensagem já gravada, quando a rota vem depois (transcrição): o Ateliê precisa dela. */
    waMessageId?: string;
    kind?: "audio";
  },
): Promise<InboundRoute> {
  const { conversation } = input;

  // Áudio do dono transcrito: recado com fotos recentes vira chegada; sem
  // fotos, ele recebe a orientação (áudio dele ao número da maison é sempre
  // Ateliê — o webhook já decidiu isso antes de transcrever).
  if (
    input.waMessageId &&
    input.kind === "audio" &&
    (await isOwnerPhone(tx, input.phoneE164)) &&
    (await isAtelierEnabled(tx))
  ) {
    const decision = await routeOwnerInbound(tx, {
      phoneE164: input.phoneE164,
      kind: "note",
      body: input.text,
      mediaUrl: null,
      now: input.now,
    });
    if (decision.kind === "intake") {
      await openAtelierIntake(tx, {
        conversationId: conversation.id,
        phoneE164: input.phoneE164,
        triggerWaMessageId: input.waMessageId,
        zapiMessageId: input.zapiMessageId,
        kind: "audio",
        body: input.text,
        now: input.now,
      });
      return "atelier_queued";
    }
    if (decision.kind === "help") {
      await enqueueAtelierHelp(tx, {
        conversationId: conversation.id,
        zapiMessageId: input.zapiMessageId,
        reason: decision.reason,
      });
      return "atelier_help";
    }
  }

  // Motoboy respondendo ao link da saída ("ok", "saí", "cheguei"): é
  // recado para a dona — a Lia não vende para o motoboy.
  const courier = await findActiveCourierByPhone(tx, input.phoneE164);
  if (courier) {
    await enqueueOutboxEvent(tx, {
      eventType: "wa.owner_forward",
      dedupeKey: `wa.fwd:${input.zapiMessageId}`,
      aggregateType: "wa_conversation",
      aggregateId: conversation.id,
      payload: {
        phoneE164: input.phoneE164,
        body: (input.forwardText ?? input.text).slice(0, FORWARD_BODY_MAX_CHARS),
        customerName: `Motoboy ${firstNameOf(courier.name)}`,
      },
    });
    return "forwarded";
  }

  const botEligible =
    conversation.status === "open" &&
    (conversation.botDisabledUntil === null ||
      conversation.botDisabledUntil.getTime() <= input.now.getTime()) &&
    (await isBotEnabled(tx));

  if (botEligible) {
    // Sem kick aqui: a transação de quem chama ainda está aberta e o kick
    // chegaria antes do commit. Quem chama dá o kick depois de commitar.
    await enqueueOutboxEvent(
      tx,
      {
        eventType: "wa.bot_turn",
        dedupeKey: `wa.bot_turn:${input.zapiMessageId}`,
        aggregateType: "wa_conversation",
        aggregateId: conversation.id,
        payload: { conversationId: conversation.id },
      },
      { kick: false },
    );
    return "bot_queued";
  }

  await enqueueOutboxEvent(tx, {
    eventType: "wa.owner_forward",
    dedupeKey: `wa.fwd:${input.zapiMessageId}`,
    aggregateType: "wa_conversation",
    aggregateId: conversation.id,
    payload: {
      phoneE164: input.phoneE164,
      body: (input.forwardText ?? input.text).slice(0, FORWARD_BODY_MAX_CHARS),
      ...(input.customerName ? { customerName: input.customerName } : {}),
    },
  });
  return "forwarded";
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
  const media = describeInboundMedia(parsed);
  const text =
    parsed.text?.message ??
    parsed.body?.message ??
    listResponseText(parsed.listResponseMessage) ??
    parsed.buttonsResponseMessage?.message ??
    media?.body;

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

  // Sem texto nem mídia = status/ack — ignorados (não registram inbound,
  // senão o DELIVERED consumiria o dedupe do messageId). Ecos das nossas
  // próprias mensagens (fromMe) e grupos também não entram no fluxo.
  if (!messageId || !rawPhone || !text || parsed.fromMe === true || parsed.isGroup === true) {
    return { action: "ignored", ignored: true };
  }

  const phoneE164 = normalizePhone(rawPhone);
  if (!phoneE164) {
    return { action: "ignored", ignored: true };
  }

  const result = await db.transaction(async (tx) => {
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
        createdAt: waConversations.createdAt,
        botDisabledUntil: waConversations.botDisabledUntil,
      });

    const [message] = await tx
      .insert(waMessages)
      .values({
        conversationId: conversation.id,
        direction: "inbound",
        zapiMessageId: messageId,
        kind: media?.kind ?? "text",
        body: text,
        ...(media?.mediaUrl ? { mediaUrl: media.mediaUrl } : {}),
        ...(media?.mediaMeta ? { mediaMeta: media.mediaMeta } : {}),
        status: "delivered",
        deliveredAt: now,
      })
      .onConflictDoNothing({ target: waMessages.zapiMessageId })
      .returning({ id: waMessages.id });

    // Conversa recém-criada (a anterior foi encerrada no painel): o caderninho
    // da vendedora (anotações) acompanha o telefone, não a conversa.
    if (conversation.createdAt.getTime() >= now.getTime() - 1000) {
      const [previous] = await tx
        .select({ botState: waConversations.botState })
        .from(waConversations)
        .where(
          and(
            eq(waConversations.phoneE164, phoneE164),
            eq(waConversations.status, "closed"),
          ),
        )
        .orderBy(desc(waConversations.updatedAt))
        .limit(1);
      const notes =
        previous?.botState &&
        typeof previous.botState === "object" &&
        Array.isArray((previous.botState as { notes?: unknown }).notes)
          ? ((previous.botState as { notes: unknown[] }).notes.filter(
              (note): note is string => typeof note === "string",
            ) as string[])
          : [];
      if (notes.length > 0) {
        await tx
          .update(waConversations)
          .set({
            botState: sql`coalesce(${waConversations.botState}, '{}'::jsonb) || jsonb_build_object('notes', ${JSON.stringify(notes)}::jsonb)`,
          })
          .where(eq(waConversations.id, conversation.id));
      }
    }

    // Nome do perfil do WhatsApp: a vendedora chama a cliente pelo nome sem
    // precisar perguntar. Vai para o bot_state (jsonb livre), só se houver.
    const senderName = parsed.senderName?.trim();
    if (senderName && senderName.length <= 80) {
      await tx
        .update(waConversations)
        .set({
          botState: sql`coalesce(${waConversations.botState}, '{}'::jsonb) || jsonb_build_object('displayName', ${senderName}::text)`,
        })
        .where(eq(waConversations.id, conversation.id));
    }

    if (!message) {
      return { action: "duplicate", duplicate: true } as const;
    }

    const markDone = () =>
      tx
        .update(inboundEvents)
        .set({ status: "done", processedAt: new Date() })
        .where(eq(inboundEvents.id, inboundId));

    const queueTranscription = async () => {
      await tx
        .update(waMessages)
        .set({
          mediaMeta: sql`coalesce(${waMessages.mediaMeta}, '{}'::jsonb) || '{"transcript":{"status":"pending"}}'::jsonb`,
        })
        .where(eq(waMessages.id, message.id));
      await enqueueOutboxEvent(
        tx,
        {
          eventType: "wa.transcribe",
          dedupeKey: `wa.transcribe:${messageId}`,
          aggregateType: "wa_conversation",
          aggregateId: conversation.id,
          payload: { waMessageId: message.id },
        },
        { kick: false },
      );
    };

    const keyword = normalizeKeyword(text);
    const isOptOut = keyword === "SAIR" || keyword === "PARAR";

    // O celular do dono no número da maison: Ateliê antes de tudo. Foto
    // abre o lote; áudio vai transcrever (a rota volta ao Ateliê depois);
    // recado com fotos recentes abre a chegada; documento pede a foto.
    // Texto solto dele cai no fluxo normal (testar a Lia como cliente);
    // SAIR/PARAR continua sendo o comando, mesmo com lote aberto.
    if (!isOptOut && (await isOwnerPhone(tx, phoneE164)) && (await isAtelierEnabled(tx))) {
      const decision = await routeOwnerInbound(tx, {
        phoneE164,
        kind: media?.kind ?? "text",
        body: text,
        mediaUrl: media?.mediaUrl ?? null,
        now,
        waMessageId: message.id,
      });
      const done = async (action: "atelier_queued" | "atelier_photo" | "atelier_help" | "transcribe_queued") => {
        await markDone();
        return { action, conversationId: conversation.id, waMessageId: message.id } as const;
      };
      if (decision.kind === "intake") {
        await openAtelierIntake(tx, {
          conversationId: conversation.id,
          phoneE164,
          triggerWaMessageId: message.id,
          zapiMessageId: messageId,
          kind: media?.kind ?? "text",
          body: text,
          now,
        });
        return done("atelier_queued");
      }
      if (decision.kind === "photo") {
        // A primeira foto do lote agenda o lembrete "faltou o recado" (+3 min).
        if (decision.batchStart) {
          await enqueueAtelierNudge(tx, { conversationId: conversation.id, phoneE164, photoWaMessageId: message.id, now });
        }
        return done("atelier_photo");
      }
      if (decision.kind === "transcribe") {
        await queueTranscription();
        return done("transcribe_queued");
      }
      if (decision.kind === "help") {
        await enqueueAtelierHelp(tx, { conversationId: conversation.id, zapiMessageId: messageId, reason: decision.reason });
        return done("atelier_help");
      }
    }

    if (isOptOut) {
      // Com ou sem cadastro: o que esse telefone pediu para receber é cancelado
      // (lista da estreia e avisos de "voltou") — a /estreia é sem login.
      await cancelDropWaitlistByPhone(tx, phoneE164, now);
      await cancelStockAlertsByPhone(tx, phoneE164, now);
      await cancelBotFollowupsByPhone(tx, { phoneE164, reason: "sair", now });
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

    // "Chegou bem?": o toque na lista volta como feedback:<resposta>:<pedido>.
    // A resposta é gravada na linha do pedido (só do telefone que recebeu a
    // pergunta) e vira texto com contexto; grande/pequeno/amei caem na Lia,
    // defeito e "falar" vão direto para a equipe.
    const feedbackRow = parseFeedbackRowId(parsed.listResponseMessage?.selectedRowId);
    if (feedbackRow) {
      const recorded = await recordDeliveryFeedback(tx, {
        orderId: feedbackRow.orderId,
        answer: feedbackRow.answer,
        phoneE164,
        waMessageId: message.id,
        now,
      });
      if (recorded.recorded && recorded.context) {
        const contextText = feedbackHistoryText(recorded.context);
        await tx.update(waMessages).set({ body: contextText }).where(eq(waMessages.id, message.id));
        if (feedbackHandledBy(feedbackRow.answer) === "human") {
          await handOffToHuman(
            tx,
            { conversationId: conversation.id, phoneE164, lastInboundId: message.id },
            feedbackRow.answer === "defeito" ? "Veio com defeito (Chegou bem?)" : "Quer falar com alguém (Chegou bem?)",
            contextText,
          );
          await markDone();
          return { action: "feedback_handoff", conversationId: conversation.id, waMessageId: message.id } as const;
        }
        const route = await routeInboundMessage(tx, {
          conversation,
          phoneE164,
          zapiMessageId: messageId,
          text: contextText,
          forwardText: contextText,
          ...(customer ? { customerName: customer.fullName } : {}),
          now,
        });
        await markDone();
        return { action: route, conversationId: conversation.id, waMessageId: message.id } as const;
      }
    }

    // "Posso mostrar na página?": o toque volta como look:sim|nao:<foto>. A
    // resposta é gravada (só do telefone que recebeu a pergunta), a
    // confirmação curta sai pela fila e a Lia não precisa de turno.
    const lookRow = parseLookRowId(parsed.listResponseMessage?.selectedRowId);
    if (lookRow) {
      const consent = await recordLookConsent(tx, {
        lookId: lookRow.lookId,
        answer: lookRow.answer,
        phoneE164,
        waMessageId: message.id,
        now,
      });
      if (consent) {
        await tx.update(waMessages).set({ body: lookConsentHistoryText(consent.answer, consent.productName) }).where(eq(waMessages.id, message.id));
        await markDone();
        return { action: "look_consent", conversationId: conversation.id, waMessageId: message.id } as const;
      }
    }

    // A ponte do site: a mensagem trouxe "#K7F2" → a ponte vira caderninho
    // (peça em vista, sacola fundida) e a conversa fica ligada a ela. Código
    // inventado, velho ou já usado não faz nada. Se o bot estiver desligado,
    // a linha "Veio do site" vai junto no encaminhamento ao dono.
    let forwardText: string | undefined;
    const bridgeCode = extractBridgeCode(text);
    if (bridgeCode) {
      const bridge = await consumeSiteCartByCode(tx, { code: bridgeCode, conversationId: conversation.id, now });
      if (bridge) {
        const [current] = await tx
          .select({ botState: waConversations.botState })
          .from(waConversations)
          .where(eq(waConversations.id, conversation.id))
          .limit(1);
        const state = parseBotState(current?.botState);
        await tx
          .update(waConversations)
          .set({ botState: mergeBridgeIntoState(state, bridge), updatedAt: now })
          .where(eq(waConversations.id, conversation.id));
        // O texto da cliente vem primeiro e inteiro (o encaminhamento corta em
        // FORWARD_BODY_MAX_CHARS); a linha da ponte fecha, curta.
        const bridgeLine = bridgeContextLine(bridge, now).slice(0, 90);
        forwardText = `${text.slice(0, FORWARD_BODY_MAX_CHARS - bridgeLine.length - 1)}\n${bridgeLine}`;
      }
    }

    // Áudio: com a vendedora ouvindo (setting + chave), a mensagem vai para a
    // fila de transcrição; quem transcreve decide a rota depois (bot ou dono).
    if (
      media?.kind === "audio" &&
      media.mediaUrl &&
      (await isBotMediaEnabled(tx)) &&
      isTranscriptionConfigured()
    ) {
      await queueTranscription();
      await markDone();
      return {
        action: "transcribe_queued",
        conversationId: conversation.id,
        waMessageId: message.id,
      } as const;
    }

    // Texto comum (ou mídia sem transcrição): a rota decide entre o turno da
    // vendedora (fila) e o encaminhamento ao dono — nunca inline no webhook.
    const route = await routeInboundMessage(tx, {
      conversation,
      phoneE164,
      zapiMessageId: messageId,
      text,
      ...(forwardText ? { forwardText } : {}),
      ...(customer ? { customerName: customer.fullName } : {}),
      now,
    });
    await markDone();
    return {
      action: route,
      conversationId: conversation.id,
      waMessageId: message.id,
    } as const;
  });
  // O kick só depois do commit: a linha do outbox já está visível para o
  // outbox-kick e a resposta da Lia sai em segundos, não no cron seguinte.
  if (result.action !== "duplicate") await kickOutbox();
  return result;
}
