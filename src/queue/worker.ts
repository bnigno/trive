import { sql } from "drizzle-orm";

import {
  classifyOutcome,
  getRetryPolicy,
  handlerReserveMs,
  nextAttemptDelayMs,
} from "@/core/queue/retry-policy";
import type { Db } from "@/db/client";
import { HandlerOutOfTimeError } from "@/core/queue/handler-errors";
import type { OutboxSource } from "@/core/queue/outbox-source";
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
  created_at: Date | string;
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
  /** Só esta linha (o kick com id reclama o alvo antes de qualquer outra). */
  onlyId?: string;
  /** Só as linhas deste agregado (os turnos seguintes da MESMA conversa, depois do alvo inline). */
  aggregateId?: string;
  /** Quem está drenando — vai no evento para o handler registrar a origem. Padrão: o cron. */
  source?: OutboxSource;
};

export type DrainOutboxResult = {
  recovered: number;
  claimed: number;
  done: number;
  failed: number;
  dead: number;
  /** Devolvidos à fila por falta de tempo neste lote. */
  released: number;
  /** Ids devolvidos por falta de tempo — o kick pode pedir outra invocação para eles. */
  releasedIds: string[];
};

/**
 * Lease: passado esse tempo sem terminar, a função morreu no meio (timeout de
 * 60 s da rota, deploy) e a linha volta para a fila. Dois minutos cobrem o
 * pior handler com folga; era 5 e uma resposta da Lia ficava presa isso tudo.
 */
const LEASE_MINUTES = 2;
const LEASE_EXPIRED_ERROR = `lease expired: worker did not finish within ${LEASE_MINUTES} minutes`;
const LEASE_INTERVAL = sql.raw(`interval '${LEASE_MINUTES} minutes'`);

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
    releasedIds: [],
  };

  // db.execute retorna { rows } no pg/PGlite e array no postgres.js — normalize.
  const rowsOf = <T,>(res: unknown): T[] =>
    Array.isArray(res) ? (res as T[]) : ((res as { rows?: T[] }).rows ?? []);

  // Lease vencido é uma tentativa que falhou: sem contar, um handler que
  // sempre estoura o tempo rodaria para sempre, fora da política do evento.
  // Cada UPDATE repete a condição do lease: se outro worker reclamou a linha
  // entre o SELECT e aqui, ela não é mais nossa.
  const expiredRows = rowsOf<{ id: string; event_type: string; attempts: number }>(await db.execute(sql`
    SELECT id, event_type, attempts
    FROM outbox_events
    WHERE status = 'processing'
      AND locked_at < now() - ${LEASE_INTERVAL}
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
          AND locked_at < now() - ${LEASE_INTERVAL}
          AND attempts = ${row.attempts}
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
          AND locked_at < now() - ${LEASE_INTERVAL}
          AND attempts = ${row.attempts}
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
        ${options.onlyId ? sql`AND id = ${options.onlyId}` : sql``}
        ${options.aggregateId ? sql`AND aggregate_id = ${options.aggregateId}` : sql``}
      ORDER BY next_attempt_at ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, event_type, aggregate_type, aggregate_id, payload,
              attempts, max_attempts, created_at
  `));
  result.claimed = claimedRows.length;

  const release = async (ids: string[]): Promise<void> => {
    await db.execute(sql`
      UPDATE outbox_events
      SET status = 'pending',
          locked_at = NULL,
          locked_by = NULL
      WHERE id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
        AND locked_by = ${workerId}
    `);
    result.released += ids.length;
    result.releasedIds.push(...ids);
  };

  for (const [index, row] of claimedRows.entries()) {
    const elapsed = clock() - startedAt;
    if (options.budgetMs !== undefined && elapsed > options.budgetMs) {
      // Sem tempo para este e os seguintes: de volta à fila, sem contar tentativa.
      await release(claimedRows.slice(index).map((pending) => pending.id));
      break;
    }
    if (options.budgetMs !== undefined && elapsed + handlerReserveMs(row.event_type) > options.budgetMs) {
      // Este não cabe no que sobra (um turno da Lia precisa de ~32 s): volta
      // à fila sem contar tentativa; os seguintes, mais curtos, ainda rodam.
      await release([row.id]);
      continue;
    }
    const event: OutboxEvent = {
      id: row.id,
      eventType: row.event_type,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      payload: row.payload,
      attempts: row.attempts,
      createdAt: new Date(row.created_at),
      source: options.source ?? "cron",
      // O handler pode se encolher para caber no que sobra da varredura.
      ...(options.budgetMs !== undefined ? { deadlineAt: new Date(startedAt + options.budgetMs) } : {}),
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
      if (error instanceof HandlerOutOfTimeError) {
        // Esperou e não sobrou tempo, antes de qualquer efeito: volta à fila
        // sem contar tentativa; o kick pede outra invocação para ela.
        await release([row.id]);
        continue;
      }
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
        // Da hora da FALHA (o handler pode ter esperado dezenas de segundos), não do início do lote.
        const nextAttemptAt = new Date((options.now ?? new Date()).getTime() + delayMs);
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
