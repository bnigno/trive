import { sql } from "drizzle-orm";

import {
  classifyOutcome,
  getRetryPolicy,
  nextAttemptDelayMs,
} from "@/core/queue/retry-policy";
import type { Db } from "@/db/client";
import { resolveOutboxHandler, type OutboxEvent } from "@/queue/handlers";

const LEASE_TIMEOUT_MS = 5 * 60 * 1000;
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
};

export type DrainOutboxResult = {
  recovered: number;
  claimed: number;
  done: number;
  failed: number;
  dead: number;
};

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
  const result: DrainOutboxResult = {
    recovered: 0,
    claimed: 0,
    done: 0,
    failed: 0,
    dead: 0,
  };

  const leaseCutoff = new Date(now.getTime() - LEASE_TIMEOUT_MS);
  const recoveredRows = (await db.execute(sql`
    UPDATE outbox_events
    SET status = 'failed',
        locked_at = NULL,
        locked_by = NULL,
        last_error = 'lease expired: worker did not finish within 5 minutes'
    WHERE status = 'processing'
      AND locked_at < ${leaseCutoff}
    RETURNING id
  `)) as unknown as { id: string }[];
  result.recovered = recoveredRows.length;

  const claimedRows = (await db.execute(sql`
    UPDATE outbox_events
    SET status = 'processing',
        locked_at = ${now},
        locked_by = ${workerId}
    WHERE id IN (
      SELECT id
      FROM outbox_events
      WHERE status IN ('pending', 'failed')
        AND next_attempt_at <= ${now}
      ORDER BY next_attempt_at ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, event_type, aggregate_type, aggregate_id, payload,
              attempts, max_attempts
  `)) as unknown as ClaimedRow[];
  result.claimed = claimedRows.length;

  for (const row of claimedRows) {
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

      if (classifyOutcome(attempts, row.max_attempts) === "dead") {
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
        const delayMs = nextAttemptDelayMs(getRetryPolicy(row.event_type), attempts);
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
