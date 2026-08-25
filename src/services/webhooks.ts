// Serviço de WEBHOOKS inbound do Mercado Pago: valida assinatura, persiste em
// inbound_events (idempotência por source+external_event_id) e enfileira o
// processamento assíncrono via outbox NA MESMA transação. O payload do webhook
// NUNCA é confiado: o handler do outbox reconsulta GET /v1/payments/{id}.
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { z } from "zod";

import { inboundEvents } from "@/db/schema";
import { validateMpSignature } from "@/lib/mp-signature";
import { enqueueOutboxEvent, type DbOrTx } from "@/queue/enqueue";

// Corpo tolerante: MP envia webhooks { data: { id }, type, action } e o
// formato IPN legado usa { topic, resource } (+ ids na query string).
const mpWebhookBodySchema = z
  .object({
    type: z.string().optional(),
    topic: z.string().optional(),
    action: z.string().optional(),
    data: z
      .object({ id: z.union([z.string(), z.number()]).optional() })
      .optional(),
  })
  .or(z.unknown().transform(() => ({}) as Record<string, never>));

export type ProcessInboundMpWebhookInput = {
  xSignature: string | null | undefined;
  xRequestId: string | null | undefined;
  /** Body JSON já parseado (qualquer formato — validado aqui com tolerância). */
  body: unknown;
  /** data.id vindo da query string ("data.id"), quando presente. */
  rawDataId?: string | null;
};

export type ProcessInboundMpWebhookResult = {
  duplicate: boolean;
  enqueued: boolean;
  signatureValid: boolean | null;
};

export async function processInboundMpWebhook(
  db: DbOrTx,
  input: ProcessInboundMpWebhookInput,
): Promise<ProcessInboundMpWebhookResult> {
  const body = mpWebhookBodySchema.parse(input.body ?? {});

  const bodyDataId = body.data?.id;
  const dataId =
    input.rawDataId ??
    (bodyDataId !== undefined ? String(bodyDataId) : undefined);

  // type/topic: "payment" no formato novo e no IPN; action "payment.updated"
  // também identifica o tópico quando type falta.
  const eventType =
    body.type ?? body.topic ?? body.action?.split(".")[0] ?? null;
  const isPaymentEvent = eventType === "payment";

  const secret = process.env.MP_WEBHOOK_SECRET;
  let signatureValid: boolean | null;
  if (!secret) {
    // Produção ainda sem credenciais do MP: aceitamos com aviso em vez de
    // quebrar. O processador reconsulta a API, então payload forjado não
    // consegue marcar pedido como pago.
    signatureValid = null;
    console.warn(
      "[webhook mp] MP_WEBHOOK_SECRET ausente — evento aceito SEM validação de assinatura.",
    );
  } else {
    signatureValid = validateMpSignature({
      xSignature: input.xSignature,
      xRequestId: input.xRequestId,
      dataId: dataId ?? null,
      secret,
    });
  }

  const externalEventId =
    dataId !== undefined
      ? `${eventType ?? "unknown"}:${dataId}`
      : (input.xRequestId ?? `unknown:${randomUUID()}`);

  const shouldEnqueue =
    signatureValid !== false && isPaymentEvent && dataId !== undefined;

  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(inboundEvents)
      .values({
        source: "mercadopago",
        externalEventId,
        eventType,
        payload: (input.body ?? {}) as Record<string, unknown>,
        signatureValid,
        status: shouldEnqueue ? "received" : "ignored",
      })
      .onConflictDoNothing({
        target: [inboundEvents.source, inboundEvents.externalEventId],
      })
      .returning({ id: inboundEvents.id });

    const inboundId = inserted[0]?.id;
    if (!inboundId) {
      // Duplicata (MP reenvia a mesma notificação): já registrada e, se era
      // processável, já enfileirada — nada a fazer.
      return { duplicate: true, enqueued: false, signatureValid };
    }

    if (!shouldEnqueue) {
      return { duplicate: false, enqueued: false, signatureValid };
    }

    await enqueueOutboxEvent(tx, {
      eventType: "mp.payment_event",
      dedupeKey: `mp.payment_event:${dataId}`,
      payload: { mpPaymentId: dataId },
    });

    await tx
      .update(inboundEvents)
      .set({ status: "done", processedAt: new Date() })
      .where(eq(inboundEvents.id, inboundId));

    return { duplicate: false, enqueued: true, signatureValid };
  });
}
