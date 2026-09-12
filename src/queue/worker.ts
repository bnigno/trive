import { sql } from "drizzle-orm";

import {
  classifyOutcome,
  getRetryPolicy,
  nextAttemptDelayMs,
} from "@/core/queue/retry-policy";
import type { Db } from "@/db/client";
import { resolveOutboxHandler, type OutboxEvent } from "@/queue/handlers";

const MAX_ERROR_LENGTH = 2000;

type ClaimedRow = {
  id: string;
  event_type: string;
  aggregate_type: string | null;
  aggregate_id: string | null;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
};

export type DrainOutboxOptions = {
  limit?: number;
  now?: Date;
  workerId?: string;
  /**
   * Tempo máximo para o lote. Estourado, o que ainda não começou volta para
   * a fila na hora (em vez de esperar a função morrer e o lease de 5 min
   * vencer). Um handler já em curso não é interrompido.
   */
  budgetMs?: number;
  /** Relógio injetável para o orçamento (testes). */
  clock?: () => number;
};

export type DrainOutboxResult = {
  recovered: number;
  claimed: number;
  done: number;
  failed: number;
  dead: number;
  /** Devolvidos à fila por falta de tempo neste lote. */
  released: number;
};

/** Lease vencido: a função morreu no meio (timeout, deploy). Conta como tentativa. */
const LEASE_EXPIRED_ERROR = "lease expired: worker did not finish within 5 minutes";

/**
 * Processa um lote do outbox. Idempotente e seguro para execução
 * concorrente: o claim usa FOR UPDATE SKIP LOCKED e cada transição
 * posterior exige locked_by = este worker.
 */
export async function drainOutbox(
  db: Db,
  options: DrainOutboxOptions = {},
): Promise<DrainOutboxResult> {
  const limit = options.limit ?? 10;
  const now = options.now ?? new Date();
  const workerId = options.workerId ?? `drain-${crypto.randomUUID()}`;
  const clock = options.clock ?? Date.now;
  const startedAt = clock();
  const result: DrainOutboxResult = {
    recovered: 0,
    claimed: 0,
    done: 0,
    failed: 0,
    dead: 0,
    released: 0,
  };

  // db.execute retorna { rows } no pg/PGlite e array no postgres.js — normalize.
  const rowsOf = <T,>(res: unknown): T[] =>
    Array.isArray(res) ? (res as T[]) : ((res as { rows?: T[] }).rows ?? []);

  // Lease vencido é uma tentativa que falhou: sem contar, um handler que
  // sempre estoura o tempo rodaria para sempre, fora da política do evento.
  const expiredRows = rowsOf<{ id: string; event_type: string; attempts: number }>(await db.execute(sql`
    SELECT id, event_type, attempts
    FROM outbox_events
    WHERE status = 'processing'
      AND locked_at < now() - interval '5 minutes'
    FOR UPDATE SKIP LOCKED
  `));
  for (const row of expiredRows) {
    const attempts = row.attempts + 1;
    const policy = getRetryPolicy(row.event_type);
    if (classifyOutcome(attempts, policy.maxAttempts) === "dead") {
      await db.execute(sql`
        UPDATE outbox_events
        SET status = 'dead',
            attempts = ${attempts},
            last_error = ${LEASE_EXPIRED_ERROR},
            locked_at = NULL,
            locked_by = NULL
        WHERE id = ${row.id}
          AND status = 'processing'
      `);
    } else {
      const nextAttemptAt = new Date(now.getTime() + nextAttemptDelayMs(policy, attempts));
      await db.execute(sql`
        UPDATE outbox_events
        SET status = 'failed',
            attempts = ${attempts},
            last_error = ${LEASE_EXPIRED_ERROR},
            next_attempt_at = ${nextAttemptAt},
            locked_at = NULL,
            locked_by = NULL
        WHERE id = ${row.id}
          AND status = 'processing'
      `);
    }
  }
  result.recovered = expiredRows.length;

  const claimedRows = rowsOf<ClaimedRow>(await db.execute(sql`
    UPDATE outbox_events
    SET status = 'processing',
        locked_at = now(),
        locked_by = ${workerId}
    WHERE id IN (
      SELECT id
      FROM outbox_events
      WHERE status IN ('pending', 'failed')
        AND next_attempt_at <= now()
      ORDER BY next_attempt_at ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, event_type, aggregate_type, aggregate_id, payload,
              attempts, max_attempts
  `));
  result.claimed = claimedRows.length;

  for (const [index, row] of claimedRows.entries()) {
    if (options.budgetMs !== undefined && clock() - startedAt > options.budgetMs) {
      // Sem tempo para este e os seguintes: de volta à fila, sem contar tentativa.
      const remaining = claimedRows.slice(index).map((pending) => pending.id);
      await db.execute(sql`
        UPDATE outbox_events
        SET status = 'pending',
            locked_at = NULL,
            locked_by = NULL
        WHERE id IN (${sql.join(remaining.map((id) => sql`${id}`), sql`, `)})
          AND locked_by = ${workerId}
      `);
      result.released = remaining.length;
      break;
    }
    const event: OutboxEvent = {
      id: row.id,
      eventType: row.event_type,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      payload: row.payload,
      attempts: row.attempts,
    };

    try {
      const handler = resolveOutboxHandler(row.event_type);
      await handler(event);
      await db.execute(sql`
        UPDATE outbox_events
        SET status = 'done',
            processed_at = now(),
            locked_at = NULL,
            locked_by = NULL,
            last_error = NULL
        WHERE id = ${row.id}
          AND locked_by = ${workerId}
      `);
      result.done += 1;
    } catch (error) {
      const message = (
        error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      ).slice(0, MAX_ERROR_LENGTH);
      const attempts = row.attempts + 1;

      // O teto vem da política do evento (core/queue/retry-policy): a coluna
      // max_attempts guarda o padrão antigo e valia para tudo.
      const policy = getRetryPolicy(row.event_type);
      if (classifyOutcome(attempts, policy.maxAttempts) === "dead") {
        await db.execute(sql`
          UPDATE outbox_events
          SET status = 'dead',
              attempts = ${attempts},
              last_error = ${message},
              locked_at = NULL,
              locked_by = NULL
          WHERE id = ${row.id}
            AND locked_by = ${workerId}
        `);
        result.dead += 1;
      } else {
        const delayMs = nextAttemptDelayMs(policy, attempts);
        const nextAttemptAt = new Date(now.getTime() + delayMs);
        await db.execute(sql`
          UPDATE outbox_events
          SET status = 'failed',
              attempts = ${attempts},
              last_error = ${message},
              next_attempt_at = ${nextAttemptAt},
              locked_at = NULL,
              locked_by = NULL
          WHERE id = ${row.id}
            AND locked_by = ${workerId}
        `);
        result.failed += 1;
      }
    }
  }

  return result;
}
