import { eq } from "drizzle-orm";
import { z } from "zod";

import { getSalesAssistant } from "@/adapters/assistant";
import { getEmailProvider } from "@/adapters/email";
import { getMailboxProvider } from "@/adapters/mailbox";
import { getPaymentGateway } from "@/adapters/mercadopago";
import { getMessagingProvider } from "@/adapters/zapi";
import { getDb } from "@/db/client";
import { orders, products, productVariants, stockLevels } from "@/db/schema";
import { sendQueuedEmail } from "@/services/email-inbox";
import { sendOrderEmail } from "@/services/notifications";
import { processPaymentEvent } from "@/services/payments";
import { runBotTurn } from "@/services/wa-bot";
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
  const clientTemplate =
    milestone === "store_created" && ctx.paymentMethod === "cash"
      ? "order_confirmed_cash"
      : spec.clientTemplate;
  // Cliente sem telefone não é erro: o e-mail (quando houver) já cobriu.
  if (ctx.customer.phoneE164) {
    await sendTemplateMessage(db, provider, {
      templateKey: clientTemplate,
      phoneE164: ctx.customer.phoneE164,
      vars: ctx.vars,
      customerId: ctx.customer.id,
      orderId,
      dedupeKey: `${spec.clientDedupePrefix}${orderId}`,
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
  phoneE164: z
    .string()
    .regex(/^\+[1-9]\d{7,14}$/, "Telefone deve estar em E.164."),
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
};

export type OutboxHandler = (event: OutboxEvent) => Promise<void>;

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
    await sendOrderEmail(getDb(), getEmailProvider(), {
      orderId: String(event.payload.orderId),
      kind: "confirmed",
    });
    await sendOrderWa(String(event.payload.orderId), "store_created");
  },
  "order.paid": async (event) => {
    await sendOrderEmail(getDb(), getEmailProvider(), {
      orderId: String(event.payload.orderId),
      kind: "paid",
    });
    await sendOrderWa(String(event.payload.orderId), "paid");
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
  // (bot desligado, conversa assumida, AssistantUnavailableError) devolvendo
  // { skipped } SEM lançar — o evento fica done e não entra em retry-loop.
  // Qualquer throw residual (banco, provedor) propaga de propósito:
  // retry/backoff/DLQ da fila agem, com idempotência via dedupe do enqueue.
  "wa.bot_turn": async (event) => {
    const payload = waBotTurnPayloadSchema.parse(event.payload);
    await runBotTurn(getDb(), getSalesAssistant(), getMessagingProvider(), {
      conversationId: payload.conversationId,
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
  // Reembolso confirmado (transição feita pelo serviço de pagamentos).
  // Notificação ao cliente entra depois — no-op registrado de propósito.
  "order.refunded": async () => {},
  // Divergência taxa real × estimada: registrada em audit/outbox pelo serviço
  // de pagamentos; notificação ao dono entra na Fase 4 (WhatsApp). No-op de
  // propósito para o evento não cair na DLQ por falta de handler.
  "mp.fee_divergent": async () => {},
  // Chargeback sinalizado: o dono decide no admin (sem transição automática).
  // Notificação ativa entra na Fase 4 — no-op registrado de propósito.
  "payment.chargeback": async () => {},
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
  "order.delivered": async () => {},
  "order.canceled": async () => {},
  // Estoque cruzou o limiar para baixo → aviso interno ao dono (sem opt-in).
  // Busca nome/SKU/disponível na hora do envio (o payload pode estar velho).
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
