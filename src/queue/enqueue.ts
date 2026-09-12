import { z } from "zod";

import { getRetryPolicy } from "@/core/queue/retry-policy";
import type { Db } from "@/db/client";
import { outboxEvents } from "@/db/schema";
import { inngest } from "@/inngest/client";

export type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export const enqueueOutboxEventSchema = z.object({
  eventType: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).default({}),
  dedupeKey: z.string().min(1).optional(),
  aggregateType: z.string().min(1).optional(),
  aggregateId: z.uuid().optional(),
  /** Agenda o evento para depois (envios em lote escalonados, janela de envio). */
  nextAttemptAt: z.date().optional(),
});

export type EnqueueOutboxEventInput = z.input<typeof enqueueOutboxEventSchema>;

/**
 * Insere um evento no outbox. Retorna o id criado, ou null quando o
 * dedupeKey já existe (duplicado ignorado). Após o insert, dá um "kick"
 * best-effort no Inngest; a varredura por cron garante a entrega mesmo
 * se o kick falhar.
 */
export async function enqueueOutboxEvent(
  dbOrTx: DbOrTx,
  input: EnqueueOutboxEventInput,
): Promise<string | null> {
  const parsed = enqueueOutboxEventSchema.parse(input);

  const inserted = await dbOrTx
    .insert(outboxEvents)
    .values({
      eventType: parsed.eventType,
      payload: parsed.payload,
      // Espelha a política do evento (o worker decide por ela; a coluna é o
      // que /admin/fila mostra em "tentativas x/y").
      maxAttempts: getRetryPolicy(parsed.eventType).maxAttempts,
      dedupeKey: parsed.dedupeKey ?? null,
      aggregateType: parsed.aggregateType ?? null,
      aggregateId: parsed.aggregateId ?? null,
      ...(parsed.nextAttemptAt ? { nextAttemptAt: parsed.nextAttemptAt } : {}),
    })
    .onConflictDoNothing({ target: outboxEvents.dedupeKey })
    .returning({ id: outboxEvents.id });

  const id = inserted[0]?.id ?? null;
  if (id === null) return null;

  // Evento marcado para depois não precisa de kick (o varredor de 1 min o
  // entrega na hora certa); poupa uma chamada HTTP por linha dentro da
  // transação de quem enfileira em lote.
  if (parsed.nextAttemptAt && parsed.nextAttemptAt.getTime() > Date.now() + 1_000) return id;

  try {
    await inngest.send({
      name: "outbox/event.enqueued",
      data: { outboxEventId: id },
    });
  } catch {
    // Kick é best-effort: o cron de varredura entrega mesmo sem ele.
  }

  return id;
}
