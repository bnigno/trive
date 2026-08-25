import { z } from "zod";

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
      dedupeKey: parsed.dedupeKey ?? null,
      aggregateType: parsed.aggregateType ?? null,
      aggregateId: parsed.aggregateId ?? null,
    })
    .onConflictDoNothing({ target: outboxEvents.dedupeKey })
    .returning({ id: outboxEvents.id });

  const id = inserted[0]?.id ?? null;
  if (id === null) return null;

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
