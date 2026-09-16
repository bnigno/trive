import { eq } from "drizzle-orm";
import { z } from "zod";

import { isWaLid } from "@/lib/phone";

import { getSalesAssistant } from "@/adapters/assistant";
import { getEmailProvider } from "@/adapters/email";
import { getMailboxProvider } from "@/adapters/mailbox";
import { getPaymentGateway } from "@/adapters/mercadopago";
import { getFileStorage } from "@/adapters/storage";
import { renderCardPng } from "@/cards/render";
import { renderGiftNotePng } from "@/receipts/render-gift-note";
import { runProductCardsPrerender } from "@/queue/handlers/product-cards";
import { runOrderEditionCards } from "@/queue/handlers/order-edition-cards";
import { renderDebutLetterPng } from "@/receipts/render-debut-letter";
import { renderEditionCardPng } from "@/receipts/render-edition-card";
import { sendGiftNoteWa } from "@/services/gifts";
import { sendDropStoryToOwner } from "@/services/drop-story";
import {
  atelierHelpPayloadSchema,
  atelierIntakePayloadSchema,
  atelierNudgePayloadSchema,
  processAtelierIntake,
  sendAtelierHelp,
  sendAtelierNudge,
} from "@/services/atelier";
import { atelierCardPayloadSchema, renderAndSendAtelierCard } from "@/services/atelier-card";
import { sendDeliveredWa } from "@/services/delivery";
import { customerLookCardPayloadSchema, renderAndSendCustomerLookCard } from "@/services/customer-looks";

const storeRevalidatePayloadSchema = z.object({ paths: z.array(z.string().regex(/^\/[a-z0-9\-/]*$/i)).min(1).max(10) });
import { askDeliveryFeedback, feedbackAskPayloadSchema, scheduleDeliveryFeedback } from "@/services/delivery-feedback";
import { fanOutDropWaitlist, notifyDropOpen } from "@/services/drop-waitlist";
import { sendDropInvite } from "@/services/drops";
import { fanOutRestockAlerts, notifyRestockAlert } from "@/services/stock-alerts";
import { getMessagingProvider } from "@/adapters/zapi";
import { getGeocoder } from "@/adapters/geocoding";
import { GEOCODE_MAX_ROUNDS, geocodeRunStops } from "@/services/delivery-runs";
import { getDb } from "@/db/client";
import { orders, products, productVariants, stockLevels } from "@/db/schema";
import { enqueueOutboxEvent } from "@/queue/enqueue";
import { loadReceiptAssets } from "@/receipts/assets";
import { renderReceiptPng } from "@/receipts/render";
import { renderDailyDigestPng } from "@/receipts/render-digest";
import { getTranscriber } from "@/adapters/transcription";
import { cardRenderPayloadSchema, renderAndSendBotCard } from "@/services/bot-cards";
import { sendDailyDigestWa } from "@/services/daily-digest";
import { transcribeInboundAudio } from "@/services/wa-transcribe";
import { sendQueuedEmail } from "@/services/email-inbox";
import { sendOrderEmail } from "@/services/notifications";
import {
  notifyOwnerChargeback,
  notifyOwnerFeeDivergent,
  sendOrderCanceledWa,
  sendOrderRefundedWa,
} from "@/services/order-notices";
import { processPaymentEvent } from "@/services/payments";
import { sendPackedWa } from "@/services/packing";
import { sendReceiptWa } from "@/services/receipts";
import { runBotTurn, runScheduledBotTurn } from "@/services/wa-bot";
import { botFollowupPayloadSchema } from "@/services/wa-followups";
import { sendApprovedSuggestion, suggestionSendPayloadSchema } from "@/services/wa-suggestions";
import {
  isWaEnabled,
  sendTemplateMessage,
  sendToOwner,
} from "@/services/wa-messaging";
import { loadOrderWaContext } from "./wa-helpers";

// Payload mínimo do evento de pagamento (Zod na fronteira da fila).
const mpPaymentEventPayloadSchema = z.object({
  mpPaymentId: z.string().min(1),
});

// Avisos de pedido (cancelado/reembolsado/chargeback) só precisam do id.
const orderNoticePayloadSchema = z.object({ orderId: z.uuid() });
const feeDivergentPayloadSchema = orderNoticePayloadSchema.extend({
  estimatedCents: z.number().int().min(0),
  actualCents: z.number().int().min(0),
});

// ---------------------------------------------------------------------------
// WhatsApp dos marcos do pedido (Fase 4). REGRA: skip (desabilitado, sem
// opt-in, sem template, já enviado) NUNCA lança — só falha REAL do provedor
// lança, e aí o retry da fila reprocessa TUDO com idempotência: e-mail pula
// via audit, WhatsApp retoma/pula via dedupe_key.
// ---------------------------------------------------------------------------

const ORDER_WA_MILESTONES = {
  store_created: {
    clientTemplate: "order_confirmed",
    clientDedupePrefix: "wa.order_confirmed:",
    ownerTemplate: "owner_new_order",
    ownerDedupePrefix: "wa.owner_new:",
  },
  paid: {
    clientTemplate: "payment_approved",
    clientDedupePrefix: "wa.payment_approved:",
    ownerTemplate: "owner_payment_approved",
    ownerDedupePrefix: "wa.owner_paid:",
  },
  shipped: {
    clientTemplate: "order_shipped",
    clientDedupePrefix: "wa.order_shipped:",
    ownerTemplate: null,
    ownerDedupePrefix: null,
  },
  // Dinheiro na entrega saiu com o motoboy (sem transição de status).
  out_for_delivery: {
    clientTemplate: "order_out_for_delivery",
    clientDedupePrefix: "wa.order_out_for_delivery:",
    ownerTemplate: null,
    ownerDedupePrefix: null,
  },
} as const;

async function sendOrderWa(
  orderId: string,
  milestone: keyof typeof ORDER_WA_MILESTONES,
): Promise<void> {
  const db = getDb();
  if (!(await isWaEnabled(db))) return;
  const provider = getMessagingProvider();
  const ctx = await loadOrderWaContext(db, orderId);
  if (!ctx) return;

  const spec = ORDER_WA_MILESTONES[milestone];
  // Dinheiro na entrega: confirmação SEM link de pagamento nem prazo de
  // reserva (o template order_confirmed quebraria com {{prazo}} vazio).
  // Motoboy: "enviado" não tem rastreio — é "saiu da maison, chega hoje
  // entre 19h e 21h". A chave de dedupe é a mesma do despacho em dinheiro
  // (order.out_for_delivery): um pedido só recebe "saiu" uma vez, por
  // qualquer caminho.
  const motoboyOut = ctx.hasDeliveryWindow && (milestone === "shipped" || milestone === "out_for_delivery");
  const clientTemplate =
    milestone === "store_created" && ctx.paymentMethod === "cash"
      ? "order_confirmed_cash"
      : motoboyOut
        ? "order_out_for_delivery"
        : spec.clientTemplate;
  const clientDedupePrefix = motoboyOut ? ORDER_WA_MILESTONES.out_for_delivery.clientDedupePrefix : spec.clientDedupePrefix;
  // Dinheiro na entrega: "pagamento aprovado, já estamos preparando" não
  // faz sentido — o pagamento é a própria entrega. Só a dona é avisada.
  const skipClient = milestone === "paid" && ctx.paymentMethod === "cash";
  // Cliente sem telefone não é erro: o e-mail (quando houver) já cobriu.
  if (ctx.customer.phoneE164 && !skipClient) {
    await sendTemplateMessage(db, provider, {
      templateKey: clientTemplate,
      phoneE164: ctx.customer.phoneE164,
      vars: ctx.vars,
      customerId: ctx.customer.id,
      orderId,
      dedupeKey: `${clientDedupePrefix}${orderId}`,
      requireOptIn: true,
    });
  }
  if (spec.ownerTemplate && spec.ownerDedupePrefix) {
    await sendToOwner(db, provider, {
      templateKey: spec.ownerTemplate,
      vars: ctx.vars,
      dedupeKey: `${spec.ownerDedupePrefix}${orderId}`,
    });
  }
}

// Envio avulso (ex.: resposta manual do dono no admin) — corpo pronto no
// payload, sem opt-in (transacional/resposta a contato do cliente).
const waSendPayloadSchema = z.object({
  // E.164 ou LID (número oculto pelo WhatsApp): a resposta manual do painel e
  // o ack de SAIR para uma conversa LID passam por aqui.
  phoneE164: z
    .string()
    .refine((value) => /^\+[1-9]\d{7,14}$/.test(value) || isWaLid(value), "Telefone deve estar em E.164 ou ser um LID do WhatsApp."),
  body: z.string().min(1),
  customerId: z.uuid().optional(),
  orderId: z.uuid().optional(),
  dedupeKey: z.string().min(1).optional(),
});

// Turno do bot de vendas: um por mensagem inbound (dedupe no enqueue).
const waBotTurnPayloadSchema = z.object({
  conversationId: z.uuid(),
});

// Resposta do dono a um e-mail de cliente: a linha 'queued' já existe em
// email_messages (gravada na mesma transação que este evento) e o payload só
// aponta para ela.
const emailSendPayloadSchema = z.object({
  emailMessageId: z.uuid(),
});

// Resposta de cliente encaminhada ao dono (bot desligado: humano responde).
// raw: true envia o corpo como está — avisos do sistema (ex.: transferência
// do bot) já chegam formatados e não são "fala de cliente".
const waTranscribePayloadSchema = z.object({ waMessageId: z.uuid() });

const stockRestockedPayloadSchema = z.object({ variantId: z.uuid(), movementId: z.uuid() });
const restockNotifyPayloadSchema = z.object({ alertId: z.uuid(), movementId: z.uuid() });
const dropInvitePayloadSchema = z.object({ inviteId: z.uuid() });
const dropPublishedPayloadSchema = z.object({ dropId: z.uuid() });
const dropOpenNotifyPayloadSchema = z.object({ waitlistId: z.uuid(), dropId: z.uuid() });
const dropStorySendPayloadSchema = z.object({ dropId: z.uuid(), variant: z.enum(["teaser", "open"]), path: z.string().min(1) });

const digestDailyPayloadSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const waOwnerForwardPayloadSchema = z.object({
  phoneE164: z.string().optional(),
  customerName: z.string().optional(),
  body: z.string().min(1),
  raw: z.boolean().optional(),
  dedupeKey: z.string().min(1).optional(),
});

export type OutboxEvent = {
  id: string;
  eventType: string;
  aggregateType: string | null;
  aggregateId: string | null;
  payload: Record<string, unknown>;
  attempts: number;
  /** Quando entrou na fila (created_at da linha — o BEGIN da transação de quem enfileirou). */
  createdAt: Date;
  /** Até quando o worker deixa este evento rodar (orçamento da varredura), quando há um. */
  deadlineAt?: Date;
};

export type OutboxHandler = (event: OutboxEvent) => Promise<void>;

async function prerenderProductCards(event: OutboxEvent): Promise<void> {
  const assets = await loadReceiptAssets();
  await runProductCardsPrerender(
    {
      db: getDb(),
      storage: getFileStorage(),
      render: (data) => renderCardPng(data, assets),
      revalidate: async (path) => {
        const { revalidatePath } = await import("next/cache");
        revalidatePath(path);
      },
    },
    event,
  );
}

/**
 * revalidatePath fora do runtime do Next (worker, testes) lança: captura e
 * loga — o cache expira sozinho e o evento não deve ir para a DLQ.
 */
async function revalidateQuietly(paths: string[], context: string): Promise<void> {
  try {
    const { revalidatePath } = await import("next/cache");
    for (const path of paths) revalidatePath(path);
  } catch (error) {
    console.warn(`[outbox] ${context}: revalidatePath indisponível neste contexto.`, error);
  }
}

export const outboxHandlers: Record<string, OutboxHandler> = {
  "system.ping": async (event) => {
    console.log(`[outbox] system.ping received (event ${event.id})`);
  },
  // Preço ativado → revalida a vitrine pública. Fora do runtime do Next
  // (worker standalone, testes) revalidatePath pode lançar: capturamos e
  // logamos — o cache expira sozinho e o evento não deve ir para a DLQ.
  "price.activated": async (event) => {
    try {
      const { revalidatePath } = await import("next/cache");
      revalidatePath("/", "layout");
    } catch (error) {
      console.warn(
        `[outbox] price.activated (event ${event.id}): revalidatePath indisponível neste contexto.`,
        error,
      );
    }
  },
  // Marcos do pedido: e-mail (Fase 3) + WhatsApp (Fase 4) no MESMO evento.
  // Falha de qualquer provedor LANÇA de propósito: retry/backoff/DLQ da fila
  // reentregam, e a idempotência de cada canal (audit no e-mail, dedupe_key
  // no WhatsApp) evita duplicar o que já saiu. O payload é validado com Zod
  // dentro de sendOrderEmail.
  "order.store_created": async (event) => {
    const orderId = String(event.payload.orderId);
    // Dinheiro na entrega: a caixa é preparada ANTES de o pedido virar pago
    // (a dona marca pago com o dinheiro na mão), então os cartões e a carta
    // de estreia nascem já na criação. O dedupe_key é o mesmo do order.paid:
    // uma geração por pedido, a que vier primeiro.
    const [order] = await getDb()
      .select({ paymentMethod: orders.paymentMethod })
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);
    if (order?.paymentMethod === "cash") {
      await enqueueOutboxEvent(getDb(), {
        eventType: "order.edition_cards",
        dedupeKey: `order.edition_cards:${orderId}`,
        aggregateType: "order",
        aggregateId: orderId,
        payload: { orderId },
      });
    }
    await sendOrderEmail(getDb(), getEmailProvider(), {
      orderId,
      kind: "confirmed",
    });
    await sendOrderWa(orderId, "store_created");
  },
  "order.paid": async (event) => {
    const orderId = String(event.payload.orderId);
    // Os cartões da edição (e a carta de estreia) ficam prontos antes de a
    // dona chegar à mesa de embalagem. Evento próprio, uma vez por pedido —
    // enfileirado ANTES dos avisos, para não ficar refém de uma sessão da
    // Z-API caída (o dedupe_key torna a repetição inofensiva).
    await enqueueOutboxEvent(getDb(), {
      eventType: "order.edition_cards",
      dedupeKey: `order.edition_cards:${orderId}`,
      aggregateType: "order",
      aggregateId: orderId,
      payload: { orderId },
    });
    await sendOrderEmail(getDb(), getEmailProvider(), {
      orderId,
      kind: "paid",
    });
    await sendOrderWa(orderId, "paid");
    // O comprovante em imagem tem evento próprio: uma falha do desenho
    // (Satori) tem retry e status só dele e nunca derruba o aviso de
    // pagamento para 'dead'. dedupe_key = uma vez por pedido.
    await enqueueOutboxEvent(getDb(), {
      eventType: "order.receipt",
      dedupeKey: `order.receipt:${orderId}`,
      aggregateType: "order",
      aggregateId: orderId,
      payload: { orderId },
    });
  },
  // Cartões da edição desenhados ao pagar. Pedido sumido ou sem peças é
  // "nada a desenhar" (concluído); falha do desenho tem retry curto — a dona
  // pode gerar de novo na tela.
  "order.edition_cards": async (event) => {
    const assets = await loadReceiptAssets();
    await runOrderEditionCards(
      {
        db: getDb(),
        storage: getFileStorage(),
        render: {
          card: (data) => renderEditionCardPng(data, assets),
          letter: (data) => renderDebutLetterPng(data, assets),
        },
      },
      event,
    );
  },
  // Comprovante de pagamento pelo WhatsApp (imagem). Skips (desligado, sem
  // opt-in, já enviado…) não lançam; a duração fica no log para o dono
  // conferir o primeiro pagamento real.
  "order.receipt": async (event) => {
    const orderId = String(event.payload.orderId);
    const startedAt = Date.now();
    const result = await sendReceiptWa(
      getDb(),
      getMessagingProvider(),
      getFileStorage(),
      async (data) => renderReceiptPng(data, await loadReceiptAssets()),
      { orderId },
    );
    console.info(
      `[order.receipt] ${orderId} → ${JSON.stringify(result)} em ${Date.now() - startedAt} ms`,
    );
  },
  // Peça entrou na vitrine (ou mudou o que está no cartão): o post, o story
  // e o carrossel ficam prontos antes de a dona abrir a tela. Falha aqui nunca
  // mexe no status da peça. Sem foto/preço, rascunho ou peça sumida são
  // "nada a desenhar" — concluído, não retry (senão vira "Fila com problemas").
  "product.published": prerenderProductCards,
  "product.card_refresh": prerenderProductCards,
  // Cartão editorial fora do cache: desenha, publica e manda logo depois do
  // texto da vendedora (dedupe por mensagem recebida; retry nunca duplica).
  "wa.card_render": async (event) => {
    const result = await renderAndSendBotCard(
      getDb(),
      getMessagingProvider(),
      getFileStorage(),
      async (data) => renderCardPng(data, await loadReceiptAssets()),
      cardRenderPayloadSchema.parse(event.payload),
    );
    console.info(`[wa.card_render] ${JSON.stringify({ ...result, cardUrl: undefined })}`);
  },
  // Áudio da cliente: baixa, transcreve e só então decide a rota (turno da
  // vendedora ou dono). Falha do vendor relança até a política esgotar; na
  // última tentativa o serviço grava o marcador e a conversa segue.
  "wa.transcribe": async (event) => {
    const { waMessageId } = waTranscribePayloadSchema.parse(event.payload);
    const result = await transcribeInboundAudio(
      getDb(),
      getMessagingProvider(),
      getTranscriber(),
      { waMessageId, attempt: event.attempts },
    );
    console.info(`[wa.transcribe] ${waMessageId} → ${JSON.stringify(result)}`);
  },
  // Ateliê: fotos + recado do dono → rascunho com as fotos → "Rascunho
  // pronto" no WhatsApp dele. Skips não lançam; foto expirada e recado sem
  // fotos viram orientação ao dono; erro real relança até a política esgotar.
  "wa.atelier_intake": async (event) => {
    const payload = atelierIntakePayloadSchema.parse({ ...event.payload, attempt: event.attempts, deadlineAt: event.deadlineAt });
    const result = await processAtelierIntake(getDb(), getMessagingProvider(), getFileStorage(), getSalesAssistant(), payload);
    console.info(`[wa.atelier_intake] ${payload.triggerWaMessageId} → ${JSON.stringify(result)}`);
  },
  "wa.atelier_help": async (event) => {
    await sendAtelierHelp(getDb(), getMessagingProvider(), atelierHelpPayloadSchema.parse(event.payload));
  },
  // Fotos sem recado há 3 min: lembrete à dona (só se continuarem sem recado).
  "wa.atelier_nudge": async (event) => {
    const result = await sendAtelierNudge(getDb(), getMessagingProvider(), atelierNudgePayloadSchema.parse(event.payload));
    console.info(`[wa.atelier_nudge] ${JSON.stringify(result)}`);
  },
  // O cartão do rascunho para a dona: melhor esforço (sem foto na ficha,
  // nada sai; o texto "Rascunho pronto" já foi).
  "wa.atelier_card": async (event) => {
    const result = await renderAndSendAtelierCard(
      getDb(),
      getMessagingProvider(),
      getFileStorage(),
      async (data) => renderCardPng(data, await loadReceiptAssets()),
      atelierCardPayloadSchema.parse(event.payload),
    );
    console.info(`[wa.atelier_card] ${JSON.stringify({ ...result, cardUrl: undefined })}`);
  },
  // "Bom dia da maison": o cron das 8h só enfileira; aqui a imagem é
  // montada, desenhada e enviada ao dono (retry e DLQ da fila). Skips
  // (desligado, sem telefone, já enviado…) não lançam.
  "digest.daily": async (event) => {
    const { date } = digestDailyPayloadSchema.parse(event.payload);
    const startedAt = Date.now();
    const result = await sendDailyDigestWa(
      getDb(),
      getMessagingProvider(),
      getFileStorage(),
      async (data) => renderDailyDigestPng(data, await loadReceiptAssets()),
      { date },
    );
    console.info(
      `[digest.daily] ${date} → ${JSON.stringify(result)} em ${Date.now() - startedAt} ms`,
    );
  },
  // Foto do pacote pelo WhatsApp: enfileirado por packOrder (dedupe por
  // pedido). Skips (desligado, sem opt-in, já enviado…) não lançam.
  "order.packed": async (event) => {
    const orderId = String(event.payload.orderId);
    const result = await sendPackedWa(
      getDb(),
      getMessagingProvider(),
      getFileStorage(),
      { orderId },
    );
    console.info(`[order.packed] ${orderId} → ${JSON.stringify(result)}`);
  },
  // Bilhete do presente: publica a imagem (o admin imprime dela) e manda a
  // prévia à compradora com opt-in; dedupe por pedido.
  "order.gift_note": async (event) => {
    const orderId = String(event.payload.orderId);
    const result = await sendGiftNoteWa(
      getDb(),
      getMessagingProvider(),
      getFileStorage(),
      async (data) => renderGiftNotePng(data, await loadReceiptAssets()),
      { orderId },
    );
    console.info(`[order.gift_note] ${orderId} → ${JSON.stringify(result)}`);
  },
  "order.shipped": async (event) => {
    await sendOrderEmail(getDb(), getEmailProvider(), {
      orderId: String(event.payload.orderId),
      kind: "shipped",
    });
    await sendOrderWa(String(event.payload.orderId), "shipped");
  },
  // Envio avulso pelo WhatsApp (corpo pronto no payload) — sempre via fila,
  // nunca inline: se a sessão Z-API cair, acumula e sai na reconexão.
  "wa.send": async (event) => {
    const parsed = waSendPayloadSchema.parse(event.payload);
    await sendTemplateMessage(getDb(), getMessagingProvider(), {
      bodyOverride: parsed.body,
      phoneE164: parsed.phoneE164,
      customerId: parsed.customerId,
      orderId: parsed.orderId,
      dedupeKey: parsed.dedupeKey ?? `wa.send:${event.id}`,
      requireOptIn: false,
    });
  },
  // Resposta do dono pela caixa de entrada de e-mail. Idempotente pelo
  // dedupe_key UNIQUE da linha: reentrega com a linha já 'sent' não reenvia.
  // A cópia na pasta "Enviados" (IMAP) é melhor esforço lá dentro — falhar em
  // copiar NÃO reprova o envio, que já aconteceu.
  "email.send": async (event) => {
    const parsed = emailSendPayloadSchema.parse(event.payload);
    await sendQueuedEmail(getDb(), getEmailProvider(), getMailboxProvider(), {
      emailMessageId: parsed.emailMessageId,
    });
  },
  // Turno do bot de vendas IA sobre uma conversa. runBotTurn trata os skips
  // (bot desligado, conversa assumida, já respondida) devolvendo { skipped }
  // SEM lançar — o evento fica done. Modelo indisponível de passagem (429,
  // 5xx, rede) relança até a penúltima tentativa do modelo
  // (BOT_TURN_MODEL_ATTEMPTS, dentro da política padrão da fila); na última
  // (ou em chave/crédito/modelo errado) o turno faz o plano B e devolve sem
  // lançar. Qualquer throw residual (banco, provedor) propaga de propósito:
  // retry/backoff/DLQ da fila agem, com idempotência via dedupe.
  // Retorno combinado: o turno PROATIVO da Lia no horário. Fora da janela
  // re-enfileira datado; conversa humana/fechada/SAIR cancela o combinado;
  // modelo fora do ar relança (política própria, 3 tentativas).
  "wa.bot_followup": async (event) => {
    const { followupId } = botFollowupPayloadSchema.parse(event.payload);
    const result = await runScheduledBotTurn(
      getDb(),
      getSalesAssistant(),
      getMessagingProvider(),
      { followupId, attempt: event.attempts, deadlineAt: event.deadlineAt ?? null },
      {
        cards: {
          storage: getFileStorage(),
          render: async (data) => renderCardPng(data, await loadReceiptAssets()),
        },
      },
    );
    console.info(`[wa.bot_followup] ${followupId} → ${JSON.stringify(result)}`);
  },
  // Copiloto: a sugestão que a dona aprovou sai como mensagem da Lia (dedupe
  // por sugestão; reentrada não duplica).
  "wa.suggestion_send": async (event) => {
    const { suggestionId } = suggestionSendPayloadSchema.parse(event.payload);
    const result = await sendApprovedSuggestion(getDb(), getMessagingProvider(), { suggestionId });
    console.info(`[wa.suggestion_send] ${suggestionId} → ${JSON.stringify(result)}`);
  },
  "wa.bot_turn": async (event) => {
    const payload = waBotTurnPayloadSchema.parse(event.payload);
    const result = await runBotTurn(
      getDb(),
      getSalesAssistant(),
      getMessagingProvider(),
      {
        conversationId: payload.conversationId,
        attempt: event.attempts,
        enqueuedAt: event.createdAt,
        ...(event.deadlineAt ? { deadlineAt: event.deadlineAt } : {}),
      },
      {
        cards: {
          storage: getFileStorage(),
          render: async (data) => renderCardPng(data, await loadReceiptAssets()),
        },
      },
    );
    console.info(`[wa.bot_turn] ${payload.conversationId} → ${JSON.stringify(result)}`);
  },
  // Saída do motoboy: geocodifica os endereços das paradas (pino no mapa e
  // distância para a cliente). Best-effort: o que não achar fica sem pino;
  // uma parada por segundo, como o Nominatim pede.
  // Poucas paradas por rodada e olho no prazo da varredura: o que sobrar
  // volta para a fila como evento novo (idempotente: só as sem coordenada).
  "delivery_run.geocode": async (event) => {
    const { runId, round, skipStopIds } = z
      .object({ runId: z.uuid(), round: z.number().int().min(0).default(0), skipStopIds: z.array(z.uuid()).max(200).default([]) })
      .parse(event.payload);
    const result = await geocodeRunStops(getDb(), getGeocoder(), { runId, skipStopIds, deadlineAt: event.deadlineAt ?? null });
    console.info(`[delivery_run.geocode] ${runId} rodada ${round} → ${JSON.stringify({ ...result, attemptedIds: result.attemptedIds.length })}`);
    if (!result.runOpen || result.remaining === 0) return;
    if (result.attempted === 0) {
      // Nem uma parada coube no prazo: devolve para a fila tentar de novo.
      throw new Error(`[delivery_run.geocode] ${runId}: sem prazo para geocodificar (${result.remaining} paradas restantes)`);
    }
    if (round + 1 >= GEOCODE_MAX_ROUNDS) return;
    // A rodada seguinte pula o que JÁ foi tentado (com ou sem pino): a lista
    // encolhe de verdade e endereço sem cobertura não vira loop.
    await enqueueOutboxEvent(getDb(), {
      eventType: "delivery_run.geocode",
      dedupeKey: `delivery_run.geocode:${runId}:${round + 1}`,
      aggregateType: "delivery_run",
      aggregateId: runId,
      payload: { runId, round: round + 1, skipStopIds: [...skipStopIds, ...result.attemptedIds] },
    });
  },
  // Resposta de cliente → encaminha ao dono (humano responde; bot desligado
  // ou conversa assumida).
  "wa.owner_forward": async (event) => {
    const parsed = waOwnerForwardPayloadSchema.parse(event.payload);
    const who =
      parsed.customerName?.trim() || parsed.phoneE164?.trim() || "Cliente";
    await sendToOwner(getDb(), getMessagingProvider(), {
      bodyOverride: parsed.raw
        ? parsed.body
        : `💬 ${who} respondeu: "${parsed.body}"`,
      dedupeKey: parsed.dedupeKey ?? `wa.owner_forward:${event.id}`,
    });
  },
  // Webhook do MP validado → o processador reconsulta a API (nunca confia no
  // payload) e aplica o efeito no pedido. Erros LANÇAM: retry/backoff/DLQ.
  "mp.payment_event": async (event) => {
    const { mpPaymentId } = mpPaymentEventPayloadSchema.parse(event.payload);
    await processPaymentEvent(getDb(), getPaymentGateway(), { mpPaymentId });
  },
  // Reembolso confirmado (transição feita pelo serviço de pagamentos): a
  // cliente recebe o aviso no WhatsApp (só com opt-in; dedupe por pedido).
  "order.refunded": async (event) => {
    const { orderId } = orderNoticePayloadSchema.parse(event.payload);
    const result = await sendOrderRefundedWa(getDb(), getMessagingProvider(), { orderId });
    console.info(`[order.refunded] ${orderId}:`, result);
  },
  // Divergência taxa real × estimada: o dono recebe os dois valores e a
  // diferença no WhatsApp (uma vez por pedido).
  "mp.fee_divergent": async (event) => {
    const payload = feeDivergentPayloadSchema.parse(event.payload);
    const result = await notifyOwnerFeeDivergent(getDb(), getMessagingProvider(), payload);
    console.info(`[mp.fee_divergent] ${payload.orderId}:`, result);
  },
  // Chargeback sinalizado: sem transição automática, mas o dono fica sabendo.
  "payment.chargeback": async (event) => {
    const { orderId } = orderNoticePayloadSchema.parse(event.payload);
    const result = await notifyOwnerChargeback(getDb(), getMessagingProvider(), { orderId });
    console.info(`[payment.chargeback] ${orderId}:`, result);
  },
  // Eventos de ciclo de vida emitidos por transitionOrder/estoque que ainda
  // não têm efeito externo — no-op explícito para não poluir a DLQ.
  // A Fase 4 (WhatsApp) substitui vários deles por notificações reais.
  // Pedido manual/WhatsApp confirmado: o cliente ganha o e-mail e o
  // WhatsApp de confirmação COM O LINK de pagamento. Pedidos da loja não
  // repetem aqui (já foram avisados em order.store_created) — e mesmo que
  // repetissem, a idempotência de cada canal segura (audit / dedupe_key).
  "order.pending_payment": async (event) => {
    const db = getDb();
    const orderId = String(event.payload.orderId ?? event.aggregateId ?? "");
    if (!orderId) return;
    const [row] = await db
      .select({ channel: orders.channel })
      .from(orders)
      .where(eq(orders.id, orderId));
    if (!row || row.channel === "store") return;
    await sendOrderEmail(db, getEmailProvider(), { orderId, kind: "confirmed" });
    await sendOrderWa(orderId, "store_created");
  },
  "order.preparing": async () => {},
  "order.out_for_delivery": async (event) => {
    await sendOrderWa(String(event.payload.orderId), "out_for_delivery");
  },
  // Entregue: a foto da entrega com a legenda (ou só o texto) para a
  // cliente, uma vez; skips não lançam.
  "order.delivered": async (event) => {
    const { orderId } = orderNoticePayloadSchema.parse(event.payload);
    // "Chegou bem?" um dia depois da entrega — agendado ANTES do aviso, para
    // um provedor fora do ar não engolir a pergunta (dedupe por pedido: o
    // retry não agenda duas vezes).
    await scheduleDeliveryFeedback(getDb(), { orderId, now: new Date() });
    const result = await sendDeliveredWa(getDb(), getMessagingProvider(), getFileStorage(), { orderId });
    console.info(`[order.delivered] ${orderId} → ${JSON.stringify(result)}`);
  },
  // A vitrine é ISR: quem tira algo da página (foto retirada, consentimento
  // desfeito) pede a revalidação pela fila — fora do runtime do Next só avisa.
  "store.revalidate": async (event) => {
    const { paths } = storeRevalidatePayloadSchema.parse(event.payload);
    await revalidateQuietly(paths, `store.revalidate (event ${event.id})`);
  },
  // "Quem já vestiu": baixa a foto dela, desenha o cartão "Ana veste …",
  // manda e faz a pergunta de consentimento (dedupe por foto). Foto que a
  // Z-API não entrega mais = skip (a linha fica, nunca pública).
  "wa.customer_look_card": async (event) => {
    const payload = customerLookCardPayloadSchema.parse(event.payload);
    const result = await renderAndSendCustomerLookCard(
      getDb(),
      getMessagingProvider(),
      getFileStorage(),
      async (data) => renderCardPng(data, await loadReceiptAssets()),
      payload,
    );
    console.info(`[wa.customer_look_card] ${payload.lookId} → ${JSON.stringify({ ...result, cardUrl: undefined })}`);
  },
  // "Chegou bem?": a lista tocável, na janela; skips não lançam.
  "wa.feedback_ask": async (event) => {
    const { orderId } = feedbackAskPayloadSchema.parse(event.payload);
    const result = await askDeliveryFeedback(getDb(), getMessagingProvider(), { orderId });
    console.info(`[wa.feedback_ask] ${orderId} → ${JSON.stringify(result)}`);
  },
  // Cancelado (pela dona ou pela expiração da reserva): a cliente recebe o
  // motivo em linguagem humana e o link do pedido (só com opt-in).
  "order.canceled": async (event) => {
    const { orderId } = orderNoticePayloadSchema.parse(event.payload);
    const result = await sendOrderCanceledWa(getDb(), getMessagingProvider(), { orderId });
    console.info(`[order.canceled] ${orderId}:`, result);
  },
  // Estoque cruzou o limiar para baixo → aviso interno ao dono (sem opt-in).
  // Busca nome/SKU/disponível na hora do envio (o payload pode estar velho).
  // Convite VIP de lançamento: um por convidada, na fase VIP e na janela.
  "wa.drop_invite": async (event) => {
    const payload = dropInvitePayloadSchema.parse(event.payload);
    const result = await sendDropInvite(getDb(), getMessagingProvider(), { inviteId: payload.inviteId });
    console.info(`[wa.drop_invite] ${payload.inviteId} → ${JSON.stringify(result)}`);
  },
  // A cortina abriu: /estreia muda de cara agora e quem pediu aviso recebe
  // (um evento por linha, escalonado na janela de envio).
  "drop.published": async (event) => {
    const payload = dropPublishedPayloadSchema.parse(event.payload);
    const result = await fanOutDropWaitlist(getDb(), payload);
    await revalidateQuietly(["/estreia", "/produtos", "/"], `drop.published (event ${event.id})`);
    console.info(`[drop.published] ${payload.dropId} → ${JSON.stringify(result)}`);
  },
  // UMA mensagem para quem pediu o aviso da estreia, dentro da janela.
  "wa.drop_open_notify": async (event) => {
    const payload = dropOpenNotifyPayloadSchema.parse(event.payload);
    const result = await notifyDropOpen(getDb(), getMessagingProvider(), { waitlistId: payload.waitlistId });
    console.info(`[wa.drop_open_notify] ${payload.waitlistId} → ${JSON.stringify(result)}`);
  },
  // O story do lançamento pronto vai para o WhatsApp da dona (uma vez por arquivo).
  "wa.drop_story_send": async (event) => {
    const payload = dropStorySendPayloadSchema.parse(event.payload);
    const result = await sendDropStoryToOwner(getDb(), getFileStorage(), getMessagingProvider(), payload);
    console.info(`[wa.drop_story_send] ${payload.dropId}/${payload.variant} → ${JSON.stringify(result)}`);
  },
  // Peça voltou: um evento por aviso aberto, escalonado na janela de envio.
  "stock.restocked": async (event) => {
    const payload = stockRestockedPayloadSchema.parse(event.payload);
    const result = await fanOutRestockAlerts(getDb(), payload);
    console.info(`[stock.restocked] ${payload.variantId} → ${JSON.stringify(result)}`);
  },
  // UMA mensagem para quem pediu o aviso (foto + texto), dentro da janela.
  "wa.restock_notify": async (event) => {
    const payload = restockNotifyPayloadSchema.parse(event.payload);
    const result = await notifyRestockAlert(getDb(), getMessagingProvider(), payload);
    console.info(`[wa.restock_notify] ${payload.alertId} → ${JSON.stringify(result)}`);
  },
  "stock.low": async (event) => {
    const db = getDb();
    if (!(await isWaEnabled(db))) return;
    const variantId = String(event.payload.variantId);
    const [variant] = await db
      .select({
        name: products.name,
        sku: productVariants.sku,
        onHand: stockLevels.onHand,
        reserved: stockLevels.reserved,
      })
      .from(productVariants)
      .innerJoin(products, eq(products.id, productVariants.productId))
      .leftJoin(
        stockLevels,
        eq(stockLevels.productVariantId, productVariants.id),
      )
      .where(eq(productVariants.id, variantId))
      .limit(1);
    if (!variant) return;
    const available = (variant.onHand ?? 0) - (variant.reserved ?? 0);
    await sendToOwner(db, getMessagingProvider(), {
      templateKey: "owner_low_stock",
      vars: {
        produto: variant.name,
        sku: variant.sku,
        disponivel: String(available),
      },
      dedupeKey: `wa.low:${variantId}`,
    });
  },
};

export class UnknownEventTypeError extends Error {
  constructor(eventType: string) {
    super(
      `Nenhum handler registrado para event_type "${eventType}". ` +
        `Registre-o em src/queue/handlers/index.ts.`,
    );
    this.name = "UnknownEventTypeError";
  }
}

export function resolveOutboxHandler(eventType: string): OutboxHandler {
  const handler = outboxHandlers[eventType];
  if (!handler) throw new UnknownEventTypeError(eventType);
  return handler;
}
