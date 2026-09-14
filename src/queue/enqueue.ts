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
 * "Kick" best-effort no Inngest: o outbox-kick drena a fila agora, sem
 * esperar o cron de 1 min. Com id, o kick espera essa linha aparecer (a
 * transação de quem enfileirou pode não ter commitado); sem id, só drena.
 * Quem enfileira DENTRO de uma transação longa (webhook, turno da Lia)
 * chama isto depois do commit — o kick disparado antes não acha a linha.
 */
export async function kickOutbox(outboxEventId?: string): Promise<void> {
  try {
    await inngest.send({
      name: "outbox/event.enqueued",
      data: outboxEventId ? { outboxEventId } : {},
    });
  } catch {
    // O cron de varredura entrega mesmo sem o kick.
  }
}

/**
 * Insere um evento no outbox. Retorna o id criado, ou null quando o
 * dedupeKey já existe (duplicado ignorado). Após o insert, dá um "kick"
 * best-effort no Inngest (a menos que `kick: false`); a varredura por cron
 * garante a entrega mesmo se o kick falhar.
 */
export async function enqueueOutboxEvent(
  dbOrTx: DbOrTx,
  input: EnqueueOutboxEventInput,
  options: { kick?: boolean } = {},
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
  if (options.kick === false) return id;

  await kickOutbox(id);
  return id;
}
