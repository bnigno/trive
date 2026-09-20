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
import { isValidE164, isWaLid, toE164BR, toWaLid } from "@/lib/phone";
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
// Campos de texto chegam null em vez de ausentes para alguns contatos: tudo
// é `nullish`. Um campo estranho NÃO pode derrubar a mensagem inteira.
const optionalText = z.string().nullish();

const zapiInboundBodySchema = z
  .object({
    messageId: z.union([z.string(), z.number()]).nullish(),
    // Telefone ('5591…') OU, quando o WhatsApp esconde o número, o LID
    // ('220839349862480@lid'). chatLid/participantLid trazem o LID mesmo
    // quando `phone` vem numérico — guardamos para reencontrar a pessoa.
    phone: z.union([z.string(), z.number()]).nullish(),
    chatLid: optionalText,
    participantLid: optionalText,
    senderLid: optionalText,
    fromMe: z.boolean().nullish(),
    isGroup: z.boolean().nullish(),
    senderName: optionalText,
    chatName: optionalText,
    text: z.object({ message: optionalText }).nullish(),
    body: z.object({ message: optionalText }).nullish(),
    listResponseMessage: z
      .object({
        message: optionalText,
        title: optionalText,
        selectedRowId: optionalText,
      })
      .nullish(),
    buttonsResponseMessage: z
      .object({
        buttonId: optionalText,
        message: optionalText,
      })
      .nullish(),
    // Mídia recebida (a Z-API manda um objeto por tipo). Registramos o fato
    // para a vendedora responder com honestidade em vez de ignorar a cliente.
    image: z
      .object({
        imageUrl: optionalText,
        caption: optionalText,
        mimeType: optionalText,
        width: z.number().nullish(),
        height: z.number().nullish(),
      })
      .nullish(),
    audio: z
      .object({
        audioUrl: optionalText,
        mimeType: optionalText,
        seconds: z.number().nullish(),
      })
      .nullish(),
    video: z.object({ videoUrl: optionalText }).nullish(),
    document: z
      .object({ documentUrl: optionalText, fileName: optionalText })
      .nullish(),
    sticker: z.object({ stickerUrl: optionalText }).nullish(),
    location: z.object({ address: optionalText }).nullish(),
    // Callback de status de mensagem (webhook update-webhook-message-status):
    // status SENT/RECEIVED/READ/PLAYED + ids das mensagens afetadas.
    status: optionalText,
    ids: z.array(z.union([z.string(), z.number()])).nullish(),
    type: optionalText,
  });

type ZapiInboundBody = z.infer<typeof zapiInboundBodySchema>;

/** Corpo que o schema não engoliu: em vez de virar {} em silêncio, é registrado como ignorado com o motivo. */
function parseInboundBody(body: unknown): { parsed: ZapiInboundBody; issue: string | null } {
  const result = zapiInboundBodySchema.safeParse(body ?? {});
  if (result.success) return { parsed: result.data, issue: null };
  const first = result.error.issues[0];
  const issue = `${first?.path.join(".") || "?"}: ${first?.message ?? "inválido"}`;
  // Segunda chance: só os campos que importam, um a um, para não perder a
  // mensagem por causa de um campo decorativo com formato novo.
  const loose = z.object({}).passthrough().safeParse(body ?? {});
  const partial: ZapiInboundBody = {};
  if (loose.success) {
    for (const key of Object.keys(zapiInboundBodySchema.shape) as (keyof ZapiInboundBody)[]) {
      const field = zapiInboundBodySchema.shape[key].safeParse(loose.data[key]);
      if (field.success) (partial as Record<string, unknown>)[key] = field.data;
    }
  }
  return { parsed: partial, issue };
}

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
  | { action: "ignored"; ignored: true; reason?: string }
  | { action: "duplicate"; duplicate: true }
  | { action: "status"; updated: number }
  // `outboxEventId`: o evento que esta mensagem enfileirou (turno da Lia,
  // aviso ao dono, transcrição, confirmação do SAIR) — quem chamou pode
  // rodá-lo na mesma invocação, depois de responder à Z-API. Null quando o
  // dedupe já tinha a linha.
  | {
      action: "opt_out";
      conversationId: string;
      waMessageId: string;
      /** true quando havia cliente cadastrado com esse telefone para desligar. */
      optedOut: boolean;
      outboxEventId: string | null;
    }
  | { action: "forwarded"; conversationId: string; waMessageId: string; outboxEventId: string | null }
  | { action: "bot_queued"; conversationId: string; waMessageId: string; outboxEventId: string | null }
  | { action: "transcribe_queued"; conversationId: string; waMessageId: string; outboxEventId: string | null }
  // Ateliê (mensagem do dono): chegada aberta, foto guardada no lote ou
  // orientação de como mandar.
  | { action: "atelier_queued"; conversationId: string; waMessageId: string; outboxEventId: string | null }
  | { action: "atelier_photo"; conversationId: string; waMessageId: string; outboxEventId: string | null }
  | { action: "atelier_help"; conversationId: string; waMessageId: string; outboxEventId: string | null }
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
type Nullish<T> = { [K in keyof T]?: T[K] | null };

function listResponseText(
  list: Nullish<{ message: string; title: string; selectedRowId: string }> | null | undefined,
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
  return list.title ?? list.message ?? undefined;
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
  image?: Nullish<{ imageUrl: string; caption: string; mimeType: string; width: number; height: number }> | null;
  audio?: Nullish<{ audioUrl: string; mimeType: string; seconds: number }> | null;
  video?: Nullish<{ videoUrl: string }> | null;
  document?: Nullish<{ documentUrl: string; fileName: string }> | null;
  sticker?: Nullish<{ stickerUrl: string }> | null;
  location?: Nullish<{ address: string }> | null;
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
    /** Endereço de entrega da conversa (telefone ou LID): para onde a resposta volta. */
    phoneE164: string;
    /** Telefone REAL quando conhecido (identidade: dono, motoboy) — senão o endereço. */
    identityPhone: string;
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
): Promise<{ route: InboundRoute; outboxEventId: string | null }> {
  const { conversation } = input;

  // Áudio do dono transcrito: recado com fotos recentes vira chegada; sem
  // fotos, ele recebe a orientação (áudio dele ao número da maison é sempre
  // Ateliê — o webhook já decidiu isso antes de transcrever).
  if (
    input.waMessageId &&
    input.kind === "audio" &&
    (await isOwnerPhone(tx, input.identityPhone)) &&
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
      return { route: "atelier_queued", outboxEventId: null };
    }
    if (decision.kind === "help") {
      await enqueueAtelierHelp(tx, {
        conversationId: conversation.id,
        zapiMessageId: input.zapiMessageId,
        reason: decision.reason,
      });
      return { route: "atelier_help", outboxEventId: null };
    }
  }

  // Motoboy respondendo ao link da saída ("ok", "saí", "cheguei"): é
  // recado para a dona — a Lia não vende para o motoboy.
  const courier = await findActiveCourierByPhone(tx, input.identityPhone);
  if (courier) {
    const outboxEventId = await enqueueOutboxEvent(tx, {
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
    return { route: "forwarded", outboxEventId };
  }

  const botEligible =
    conversation.status === "open" &&
    (conversation.botDisabledUntil === null ||
      conversation.botDisabledUntil.getTime() <= input.now.getTime()) &&
    (await isBotEnabled(tx));

  if (botEligible) {
    // Sem kick aqui: a transação de quem chama ainda está aberta e o kick
    // chegaria antes do commit. Quem chama dá o kick depois de commitar (e
    // roda o turno na mesma invocação quando tem tempo).
    const outboxEventId = await enqueueOutboxEvent(
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
    return { route: "bot_queued", outboxEventId };
  }

  const outboxEventId = await enqueueOutboxEvent(tx, {
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
  return { route: "forwarded", outboxEventId };
}

/** Z-API manda '5511999998888' (sem '+'): normaliza BR; aceita E.164 estrangeiro. */
function normalizePhone(raw: string): string | null {
  const br = toE164BR(raw);
  if (br) return br;
  const digits = raw.replace(/\D/g, "");
  const candidate = `+${digits}`;
  return isValidE164(candidate) ? candidate : null;
}

const IGNORED_ALERT_MAX_CHARS = 160;

/**
 * Mensagem que chegou mas não deu para processar (sem id, sem telefone nem
 * LID, corpo fora do formato): fica em inbound_events com status 'ignored'
 * e o motivo — para ninguém precisar adivinhar o que a Z-API mandou — e o
 * dono recebe um aviso no WhatsApp com o texto, para responder pelo
 * celular. O id externo ganha o prefixo 'ignored:' para não consumir o
 * dedupe do messageId (se a Z-API reenviar certo, entra normalmente).
 */
async function recordIgnoredInbound(
  db: DbOrTx,
  input: { body: unknown; messageId: string | undefined; reason: string; senderName?: string; text: string },
): Promise<void> {
  const externalEventId = `ignored:${input.messageId ?? `sem-id:${Date.now()}`}`;
  const inserted = await db
    .insert(inboundEvents)
    .values({
      source: "zapi",
      externalEventId,
      eventType: "message.received",
      payload: (input.body ?? {}) as Record<string, unknown>,
      status: "ignored",
      lastError: input.reason.slice(0, 500),
      processedAt: new Date(),
    })
    .onConflictDoNothing({ target: [inboundEvents.source, inboundEvents.externalEventId] })
    .returning({ id: inboundEvents.id });
  if (inserted.length === 0) return;
  const who = input.senderName?.trim() || "alguém";
  await enqueueOutboxEvent(db, {
    eventType: "wa.owner_forward",
    dedupeKey: `wa.fwd:${externalEventId}`,
    payload: {
      raw: true,
      body: `⚠️ Mensagem de ${who} chegou no WhatsApp da loja, mas o sistema não conseguiu identificar quem mandou (${input.reason.split(" ")[0]}). Responda pelo celular. Texto: "${input.text.slice(0, IGNORED_ALERT_MAX_CHARS)}"`,
    },
  });
}

/** Quanto a fila espera para repetir um recibo que chegou antes de a mensagem existir (o turno da Lia já commitou até lá). */
export const STATUS_REPLAY_DELAY_MS = 20_000;
export type MessageStatusTarget = "delivered" | "read";

/**
 * Aplica um recibo da Z-API à mensagem pelo zapi_message_id, de forma
 * MONOTÔNICA (nunca regride). Devolve quantas linhas mudaram: 0 = a mensagem
 * não existe (ainda) ou já estava adiante.
 */
export async function applyMessageStatus(db: DbOrTx, input: { zapiMessageId: string; target: MessageStatusTarget }): Promise<number> {
  const res = await db
    .update(waMessages)
    .set(
      input.target === "read"
        ? // Lida implica entregue: READ que chegou antes do DELIVERED (ou DELIVERED perdido) não deixa delivered_at vazio.
          { status: "read", readAt: new Date(), deliveredAt: sql`coalesce(${waMessages.deliveredAt}, now())` }
        : { status: "delivered", deliveredAt: new Date() },
    )
    .where(
      and(
        eq(waMessages.zapiMessageId, input.zapiMessageId),
        input.target === "read" ? inArray(waMessages.status, ["sent", "delivered"]) : eq(waMessages.status, "sent"),
      ),
    )
    .returning({ id: waMessages.id });
  return res.length;
}

async function messageExists(db: DbOrTx, zapiMessageId: string): Promise<boolean> {
  const [row] = await db.select({ id: waMessages.id }).from(waMessages).where(eq(waMessages.zapiMessageId, zapiMessageId)).limit(1);
  return row !== undefined;
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

  const { parsed, issue } = parseInboundBody(input.body);
  const messageId = parsed.messageId != null ? String(parsed.messageId) : undefined;
  const rawPhone = parsed.phone != null ? String(parsed.phone).trim() : undefined;
  const media = describeInboundMedia(parsed);
  const text =
    parsed.text?.message ??
    parsed.body?.message ??
    listResponseText(parsed.listResponseMessage) ??
    parsed.buttonsResponseMessage?.message ??
    media?.body ??
    undefined;

  // Callback de STATUS de mensagem (entregue/lida): atualiza wa_messages
  // pelo zapi_message_id de forma MONOTÔNICA (nunca regride) — é o que torna
  // visível uma mensagem "aceita mas nunca entregue" (número sem WhatsApp).
  const statusUpper = parsed.status?.toUpperCase() ?? undefined;
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
      const changed = await applyMessageStatus(db, { zapiMessageId: id, target: statusTarget });
      updated += changed;
      // Recibo que chegou antes de a linha existir (o turno da Lia ainda não
      // commitou o balão que acabou de enviar) não pode se perder: repete
      // daqui a pouco pela fila — é ele que alimenta o ✓✓ e "entregue no
      // celular". Linha que existe e já está adiante (DELIVERED depois do
      // READ) não precisa de nada; mensagem que nunca foi nossa só faz a
      // fila olhar de novo e concluir.
      if (changed === 0 && !(await messageExists(db, id))) {
        await enqueueOutboxEvent(
          db,
          {
            eventType: "wa.status_replay",
            dedupeKey: `wa.status:${id}:${statusTarget}`,
            payload: { zapiMessageId: id, status: statusTarget },
            nextAttemptAt: new Date(Date.now() + STATUS_REPLAY_DELAY_MS),
          },
          { kick: false },
        );
      }
    }
    return { action: "status", updated };
  }

  // Sem texto nem mídia = status/ack — ignorados (não registram inbound,
  // senão o DELIVERED consumiria o dedupe do messageId). Ecos das nossas
  // próprias mensagens (fromMe) e grupos também não entram no fluxo.
  // Texto só de espaços também: viraria um bloco vazio para o modelo (400).
  if (!text || text.trim() === "" || parsed.fromMe === true || parsed.isGroup === true) {
    return { action: "ignored", ignored: true };
  }

  // O endereço da pessoa: telefone (E.164) ou, quando o WhatsApp esconde o
  // número, o LID — a Z-API põe o LID no próprio `phone` ('…@lid') e/ou em
  // chatLid. Um LID nunca passa por normalizePhone: os dígitos viram um
  // "número" que não existe.
  const lid =
    toWaLid(rawPhone) ?? toWaLid(parsed.chatLid) ?? toWaLid(parsed.participantLid) ?? toWaLid(parsed.senderLid);
  // JID antigo ('5591…@c.us' / '@s.whatsapp.net') é telefone; qualquer outro
  // '@' (LID, canal) não é. E o LID cru sem sufixo no phone (mesmos dígitos
  // do chatLid) também não é telefone.
  const phoneDigits = rawPhone?.replace(/@(c\.us|s\.whatsapp\.net)$/i, "");
  const looksLikeLid = lid !== null && phoneDigits?.replace(/\D/g, "") === lid.replace("@lid", "");
  const realPhone = phoneDigits && !phoneDigits.includes("@") && !looksLikeLid ? normalizePhone(phoneDigits) : null;
  const address = realPhone ?? lid;

  // Mensagem de verdade que não dá para processar: fica REGISTRADA (status
  // 'ignored' + motivo) e o dono é avisado — nunca some em silêncio.
  if (!messageId || !address) {
    const reason = !messageId ? "sem_id" : issue ? `payload_invalido (${issue})` : "sem_endereco";
    await recordIgnoredInbound(db, { body: input.body, messageId, reason, senderName: parsed.senderName ?? undefined, text });
    return { action: "ignored", ignored: true, reason };
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

    const now = new Date();

    // A mesma pessoa pode chegar ora pelo telefone, ora só pelo LID. A
    // conversa do TELEFONE manda (é a que tem cliente e caderninho): se
    // existir, ganha o LID; uma conversa aberta só com o LID é fechada para
    // a pessoa não alternar entre duas. Sem conversa do telefone, a do LID
    // serve — e, se o telefone acabou de aparecer, ela passa a usá-lo.
    const openConversation = (where: ReturnType<typeof eq>) =>
      tx
        .select({ id: waConversations.id, phoneE164: waConversations.phoneE164 })
        .from(waConversations)
        .where(and(where, sql`${waConversations.status} <> 'closed'`))
        .orderBy(desc(waConversations.updatedAt))
        .limit(1);
    const [byPhone] = realPhone ? await openConversation(eq(waConversations.phoneE164, realPhone)) : [];
    const [byLid] = lid && !byPhone ? await openConversation(eq(waConversations.lid, lid)) : [];
    const [byLidAddress] = lid && !byPhone && !byLid ? await openConversation(eq(waConversations.phoneE164, lid)) : [];
    const lidConversation = byLid ?? byLidAddress;
    let conversationAddress = address;
    if (byPhone) {
      conversationAddress = realPhone as string;
      if (lid) {
        const [stray] = await openConversation(eq(waConversations.phoneE164, lid));
        if (stray && stray.id !== byPhone.id) {
          await tx.update(waConversations).set({ status: "closed", updatedAt: now }).where(eq(waConversations.id, stray.id));
        }
      }
    } else if (lidConversation) {
      if (realPhone && lidConversation.phoneE164 !== realPhone) {
        await tx.update(waConversations).set({ phoneE164: realPhone, updatedAt: now }).where(eq(waConversations.id, lidConversation.id));
        conversationAddress = realPhone;
      } else {
        conversationAddress = lidConversation.phoneE164;
      }
    }

    // Cliente cadastrada só pelo telefone real — o da mensagem ou o que a
    // conversa já conhece (o LID não está no cadastro).
    const customerPhone = realPhone ?? (isWaLid(conversationAddress) ? null : conversationAddress);
    const [customer] = customerPhone
      ? await tx
          .select({
            id: customers.id,
            fullName: customers.fullName,
            marketingOptIn: customers.marketingOptIn,
          })
          .from(customers)
          .where(and(eq(customers.phoneE164, customerPhone), isNull(customers.deletedAt)))
          .limit(1)
      : [];

    // No máximo UMA conversa não-fechada por endereço (unique parcial):
    // upsert reaproveita a aberta; conversa fechada não conflita e nasce outra.
    const [conversation] = await tx
      .insert(waConversations)
      .values({
        phoneE164: conversationAddress,
        lid: lid ?? null,
        customerId: customer?.id ?? null,
        lastInboundAt: now,
      })
      .onConflictDoUpdate({
        target: waConversations.phoneE164,
        targetWhere: sql`${waConversations.status} <> 'closed'`,
        set: {
          lastInboundAt: now,
          updatedAt: now,
          ...(lid ? { lid: sql`coalesce(${waConversations.lid}, ${lid})` } : {}),
          // Nunca sobrescreve um vínculo existente com outro cliente.
          ...(customer
            ? { customerId: sql`coalesce(${waConversations.customerId}, ${customer.id})` }
            : {}),
        },
      })
      .returning({
        id: waConversations.id,
        phoneE164: waConversations.phoneE164,
        status: waConversations.status,
        createdAt: waConversations.createdAt,
        botDisabledUntil: waConversations.botDisabledUntil,
      });
    // Daqui em diante, o endereço é o da CONVERSA (telefone quando conhecido,
    // senão o LID): é para ele que a resposta volta. A IDENTIDADE (dono,
    // motoboy, opt-out, feedback) usa o telefone real quando o temos.
    const phoneE164 = conversation.phoneE164;
    const identityPhone = customerPhone ?? phoneE164;

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

    const queueTranscription = async (): Promise<string | null> => {
      await tx
        .update(waMessages)
        .set({
          mediaMeta: sql`coalesce(${waMessages.mediaMeta}, '{}'::jsonb) || '{"transcript":{"status":"pending"}}'::jsonb`,
        })
        .where(eq(waMessages.id, message.id));
      return enqueueOutboxEvent(
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
    if (!isOptOut && (await isOwnerPhone(tx, identityPhone)) && (await isAtelierEnabled(tx))) {
      const decision = await routeOwnerInbound(tx, {
        phoneE164,
        kind: media?.kind ?? "text",
        body: text,
        mediaUrl: media?.mediaUrl ?? null,
        now,
        waMessageId: message.id,
      });
      const done = async (action: "atelier_queued" | "atelier_photo" | "atelier_help" | "transcribe_queued", outboxEventId: string | null = null) => {
        await markDone();
        return { action, conversationId: conversation.id, waMessageId: message.id, outboxEventId } as const;
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
        return done("transcribe_queued", await queueTranscription());
      }
      if (decision.kind === "help") {
        await enqueueAtelierHelp(tx, { conversationId: conversation.id, zapiMessageId: messageId, reason: decision.reason });
        return done("atelier_help");
      }
    }

    if (isOptOut) {
      // Com ou sem cadastro: o que esse telefone pediu para receber é cancelado
      // (lista da estreia e avisos de "voltou") — a /estreia é sem login.
      await cancelDropWaitlistByPhone(tx, identityPhone, now);
      await cancelStockAlertsByPhone(tx, identityPhone, now);
      await cancelBotFollowupsByPhone(tx, { phoneE164: identityPhone, reason: "sair", now });
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
      const ackEventId = await enqueueOutboxEvent(tx, {
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
        outboxEventId: ackEventId,
      } as const;
    }

    // "Chegou bem?": o toque na lista volta como feedback:<resposta>:<pedido>.
    // A resposta é gravada na linha do pedido (só do telefone que recebeu a
    // pergunta) e vira texto com contexto; grande/pequeno/amei caem na Lia,
    // defeito e "falar" vão direto para a equipe.
    const feedbackRow = parseFeedbackRowId(parsed.listResponseMessage?.selectedRowId ?? undefined);
    if (feedbackRow) {
      const recorded = await recordDeliveryFeedback(tx, {
        orderId: feedbackRow.orderId,
        answer: feedbackRow.answer,
        phoneE164: identityPhone,
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
        const { route, outboxEventId } = await routeInboundMessage(tx, {
          conversation,
          phoneE164,
          identityPhone,
          zapiMessageId: messageId,
          text: contextText,
          forwardText: contextText,
          ...(customer ? { customerName: customer.fullName } : {}),
          now,
        });
        await markDone();
        return { action: route, conversationId: conversation.id, waMessageId: message.id, outboxEventId } as const;
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
        phoneE164: identityPhone,
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
    // Áudio de motoboy não vale transcrição paga: vai direto para a dona.
    if (
      media?.kind === "audio" &&
      media.mediaUrl &&
      (await isBotMediaEnabled(tx)) &&
      isTranscriptionConfigured() &&
      !(await findActiveCourierByPhone(tx, identityPhone))
    ) {
      const outboxEventId = await queueTranscription();
      await markDone();
      return {
        action: "transcribe_queued",
        conversationId: conversation.id,
        waMessageId: message.id,
        outboxEventId,
      } as const;
    }

    // Texto comum (ou mídia sem transcrição): a rota decide entre o turno da
    // vendedora e o encaminhamento ao dono — ambos vão para o outbox dentro
    // desta transação; quem roda é a rota do webhook (depois do 200) ou a fila.
    const { route, outboxEventId } = await routeInboundMessage(tx, {
      conversation,
      phoneE164,
      identityPhone,
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
      outboxEventId,
    } as const;
  });
  // O kick só depois do commit — e com o id do evento que a mensagem gerou:
  // é a rede de segurança do turno inline (a linha já está visível; se a
  // invocação do webhook morrer no meio, o Inngest a acha pendente).
  if (result.action !== "duplicate") {
    await kickOutbox("outboxEventId" in result && result.outboxEventId ? result.outboxEventId : undefined);
  }
  return result;
}
