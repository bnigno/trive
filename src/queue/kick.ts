// O "kick": o Inngest recebe outbox/event.enqueued e chama isto para drenar
// a fila agora, sem esperar o cron de 1 min. Com o id da linha, o alvo vem
// primeiro: espera a linha aparecer (quem enfileirou pode ainda estar na
// transação — o webhook da Z-API, por exemplo; o kick chegava antes do
// commit, não achava nada e a resposta da Lia só saía no cron seguinte),
// reclama SÓ ela quando vence e, se não há tempo para o handler dela nesta
// invocação, pede outra invocação inteira em vez de começar e morrer.
import { sql } from "drizzle-orm";

import type { OutboxSource } from "@/core/queue/outbox-source";
import { handlerReserveMs } from "@/core/queue/retry-policy";
import type { Db } from "@/db/client";

import { kickOutbox } from "./enqueue";
import { drainOutbox, type DrainOutboxResult } from "./worker";

/** Orçamento de uma invocação do kick (a rota /api/inngest tem 60 s). */
export const KICK_BUDGET_MS = 50_000;
/** Orçamento do turno inline (a rota do webhook tem 60 s; a resposta 200 já saiu). */
export const INLINE_KICK_BUDGET_MS = 45_000;
/**
 * Quanto da vida da lambda do webhook o inline pode usar, contado do INÍCIO da
 * requisição — o webhook pode ter esperado o lock da conversa; o que já passou
 * não está mais disponível para o turno.
 */
export const WEBHOOK_INLINE_MAX_MS = 55_000;
/** Quanto tempo espera a linha aparecer (transação de quem enfileirou). */
export const KICK_POLL_BUDGET_MS = 10_000;
const KICK_POLL_MS = 500;
/** Retry próximo (429 do modelo, política da fila): vale esperar e drenar de novo. */
const NEAR_RETRY_MS = 15_000;
/** Folga ao esperar um retry: o claim compara com o now() do banco, não com o daqui. */
const RETRY_SLACK_MS = 250;
/** Depois do alvo, drena o resto só se sobra tempo de verdade para um lote. */
const GENERAL_DRAIN_MIN_MS = 20_000;

export type OutboxKickOptions = {
  outboxEventId?: string;
  /** Esta invocação já é uma repetição pedida por outro kick: não pede de novo. */
  rekick?: boolean;
  budgetMs?: number;
  pollMs?: number;
  pollBudgetMs?: number;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Pede outra invocação (best-effort). Injetável nos testes. */
  requestKick?: (outboxEventId: string) => Promise<void>;
  /** Rótulo da origem, gravado no evento e nos tempos do turno (padrão: kick). */
  source?: OutboxSource;
  /**
   * Cuida SÓ do alvo (e dos turnos seguintes da MESMA conversa, se couberem)
   * e não aproveita para drenar o resto da fila: a lambda do webhook e o
   * handler da transcrição não são lugar de lote. Padrão: verdadeiro quando
   * a origem é inline.
   */
  targetOnly?: boolean;
};

export type OutboxKickResult = DrainOutboxResult & {
  source: OutboxSource;
  /** O que o kick viu da linha alvo ao terminar. */
  target: "sem_id" | "processada" | "nao_apareceu" | "nao_reclamada" | "agendada" | "sem_tempo";
  polls: number;
  /** Ids para os quais este kick pediu outra invocação (alvo ou liberados por falta de tempo). */
  rekicked: string[];
};

type TargetRow = { status: string; due_in_ms: number | string };

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function runOutboxKick(db: Db, options: OutboxKickOptions = {}): Promise<OutboxKickResult> {
  const budgetMs = options.budgetMs ?? KICK_BUDGET_MS;
  const pollMs = options.pollMs ?? KICK_POLL_MS;
  const pollBudgetMs = options.pollBudgetMs ?? KICK_POLL_BUDGET_MS;
  const clock = options.clock ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const requestKick = options.requestKick ?? ((id: string) => kickOutbox(id, { rekick: true }));
  const source: OutboxSource = options.source ?? "kick";
  const targetOnly = options.targetOnly ?? source === "inline";
  const startedAt = clock();
  const totals: OutboxKickResult = {
    source,
    recovered: 0,
    claimed: 0,
    done: 0,
    failed: 0,
    dead: 0,
    released: 0,
    releasedIds: [],
    target: "sem_id",
    polls: 0,
    rekicked: [],
  };
  const remaining = () => budgetMs - (clock() - startedAt);

  const drain = async (scope: { onlyId?: string; aggregateId?: string } = {}): Promise<DrainOutboxResult> => {
    const result = await drainOutbox(db, {
      limit: 10,
      budgetMs: Math.max(1_000, remaining()),
      clock,
      source,
      ...scope,
    });
    for (const key of ["recovered", "claimed", "done", "failed", "dead", "released"] as const) totals[key] += result[key];
    totals.releasedIds.push(...result.releasedIds);
    return result;
  };
  // Linha devolvida por falta de tempo (um turno da Lia que não cabia):
  // outra invocação, com orçamento inteiro, em vez de esperar o cron.
  const rekickReleased = async (result: DrainOutboxResult): Promise<void> => {
    if (options.rekick) return;
    for (const id of result.releasedIds) {
      await requestKick(id);
      totals.rekicked.push(id);
    }
  };

  if (!options.outboxEventId) {
    await rekickReleased(await drain());
    return totals;
  }

  for (;;) {
    // O prazo vem do relógio do banco: é ele que decide o claim (next_attempt_at <= now()).
    const [row] = rowsOf<TargetRow>(
      await db.execute(sql`
        SELECT status,
               greatest(0, extract(epoch from (next_attempt_at - now())) * 1000) AS due_in_ms
        FROM outbox_events
        WHERE id = ${options.outboxEventId}
      `),
    );

    if (!row) {
      // Ainda não commitou (ou nunca vai): espera um pouco; desistindo,
      // drena mesmo assim — um kick nunca deixa a fila parada.
      if (clock() - startedAt < pollBudgetMs) {
        totals.polls += 1;
        await sleep(pollMs);
        continue;
      }
      await rekickReleased(await drain());
      totals.target = "nao_apareceu";
      return totals;
    }

    if (row.status === "processing" || row.status === "done" || row.status === "dead") {
      totals.target = row.status === "processing" ? "nao_reclamada" : "processada";
      return totals;
    }

    // pending/failed. Agendada para logo → espera (com folga) e tenta de novo;
    // longe demais → fica para o cron.
    const dueInMs = Math.ceil(Number(row.due_in_ms));
    const reserveMs = Math.max(handlerReserveMs("wa.bot_turn"), 1_000);
    if (dueInMs > 0) {
      if (dueInMs <= NEAR_RETRY_MS && remaining() - dueInMs >= reserveMs) {
        await sleep(dueInMs + RETRY_SLACK_MS);
        continue;
      }
      totals.target = "agendada";
      return totals;
    }

    // Vencida. Sem tempo para o handler dela nesta invocação: outra invocação.
    if (remaining() < reserveMs) {
      totals.target = "sem_tempo";
      if (!options.rekick) {
        await requestKick(options.outboxEventId);
        totals.rekicked.push(options.outboxEventId);
      }
      return totals;
    }
    const targetDrain = await drain({ onlyId: options.outboxEventId });
    if (targetDrain.claimed === 0) {
      // Outro worker levou a linha entre o SELECT e o claim (ou o relógio do banco ainda não a venceu).
      totals.target = "nao_reclamada";
      return totals;
    }
    totals.target = "processada";
    // Alvo devolvido sem tempo (esperou o lock da conversa) ou que falhou
    // numa invocação só do alvo: o kick com id pode já ter passado enquanto a
    // linha estava "processing" e não voltaria — pede outro, para não sobrar
    // só o cron.
    await rekickReleased(targetDrain);
    if (targetOnly && targetDrain.failed > 0 && !options.rekick) {
      await requestKick(options.outboxEventId);
      totals.rekicked.push(options.outboxEventId);
    }
    if (targetOnly) {
      // Rajada: a mensagem seguinte da MESMA conversa já pode ter enfileirado o
      // turno dela enquanto este rodava. Roda aqui, na mesma lambda, enquanto
      // couber — senão a cliente esperaria o Inngest começar outra função.
      const aggregateId = await aggregateOf(db, options.outboxEventId);
      while (aggregateId && targetDrain.done > 0 && remaining() >= handlerReserveMs("wa.bot_turn")) {
        const next = await drain({ aggregateId });
        await rekickReleased(next);
        if (next.claimed === 0 || next.released > 0) break;
      }
      return totals;
    }
    // Com o alvo entregue, aproveita a invocação para o resto da fila — só se
    // sobra tempo de verdade; senão o cron termina.
    if (remaining() >= GENERAL_DRAIN_MIN_MS) await rekickReleased(await drain());
    return totals;
  }
}

async function aggregateOf(db: Db, outboxEventId: string): Promise<string | null> {
  const [row] = rowsOf<{ aggregate_id: string | null }>(
    await db.execute(sql`SELECT aggregate_id FROM outbox_events WHERE id = ${outboxEventId}`),
  );
  return row?.aggregate_id ?? null;
}
