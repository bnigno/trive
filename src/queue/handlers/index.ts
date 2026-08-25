import { z } from "zod";

import { getEmailProvider } from "@/adapters/email";
import { getPaymentGateway } from "@/adapters/mercadopago";
import { getDb } from "@/db/client";
import { sendOrderEmail } from "@/services/notifications";
import { processPaymentEvent } from "@/services/payments";

// Payload mínimo do evento de pagamento (Zod na fronteira da fila).
const mpPaymentEventPayloadSchema = z.object({
  mpPaymentId: z.string().min(1),
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
  // E-mails dos marcos do pedido (Fase 3). Falha do provedor LANÇA de
  // propósito: retry/backoff/DLQ da fila cuidam da reentrega. O payload é
  // validado com Zod dentro de sendOrderEmail.
  "order.store_created": async (event) => {
    await sendOrderEmail(getDb(), getEmailProvider(), {
      orderId: String(event.payload.orderId),
      kind: "confirmed",
    });
  },
  "order.paid": async (event) => {
    await sendOrderEmail(getDb(), getEmailProvider(), {
      orderId: String(event.payload.orderId),
      kind: "paid",
    });
  },
  "order.shipped": async (event) => {
    await sendOrderEmail(getDb(), getEmailProvider(), {
      orderId: String(event.payload.orderId),
      kind: "shipped",
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
  "order.pending_payment": async () => {},
  "order.preparing": async () => {},
  "order.delivered": async () => {},
  "order.canceled": async () => {},
  "stock.low": async () => {},
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
