// O "kick": o Inngest recebe outbox/event.enqueued e chama isto para drenar
// a fila agora, sem esperar o cron de 1 min. Quando o evento traz o id da
// linha, espera ela aparecer — quem enfileirou pode ainda estar dentro da
// transação (o webhook da Z-API, por exemplo) e o kick chegava antes do
// commit, não achava nada e a resposta da Lia só saía no cron seguinte.
import { sql } from "drizzle-orm";

import type { Db } from "@/db/client";

import { drainOutbox, type DrainOutboxResult } from "./worker";

/** Orçamento de uma invocação do kick (a rota /api/inngest tem 60 s). */
export const KICK_BUDGET_MS = 50_000;
/** Quanto tempo espera a linha aparecer (transação de quem enfileirou). */
export const KICK_POLL_BUDGET_MS = 10_000;
const KICK_POLL_MS = 500;
/** Retry próximo (429 do modelo, política da fila): vale esperar e drenar de novo. */
const NEAR_RETRY_MS = 15_000;
/** Reserva para o handler mais longo (um turno da Lia) caber no orçamento. */
const HANDLER_RESERVE_MS = 45_000;

export type OutboxKickOptions = {
  outboxEventId?: string;
  budgetMs?: number;
  pollMs?: number;
  pollBudgetMs?: number;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export type OutboxKickResult = DrainOutboxResult & {
  /** O que o kick viu da linha alvo ao terminar. */
  target: "sem_id" | "processada" | "nao_apareceu" | "com_outro_worker" | "agendada";
  polls: number;
};

type TargetRow = { status: string; next_attempt_at: Date | string };

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
  const startedAt = clock();
  const totals: OutboxKickResult = { recovered: 0, claimed: 0, done: 0, failed: 0, dead: 0, released: 0, target: "sem_id", polls: 0 };

  const drain = async (): Promise<DrainOutboxResult> => {
    const result = await drainOutbox(db, {
      limit: 10,
      budgetMs: Math.max(1_000, budgetMs - (clock() - startedAt)),
      clock,
    });
    for (const key of ["recovered", "claimed", "done", "failed", "dead", "released"] as const) totals[key] += result[key];
    return result;
  };

  if (!options.outboxEventId) {
    await drain();
    return totals;
  }

  for (;;) {
    const [row] = rowsOf<TargetRow>(
      await db.execute(sql`SELECT status, next_attempt_at FROM outbox_events WHERE id = ${options.outboxEventId}`),
    );
    const elapsed = clock() - startedAt;

    if (!row) {
      // Ainda não commitou (ou nunca vai): espera um pouco; desistindo,
      // drena mesmo assim — um kick nunca deixa a fila parada.
      if (elapsed < pollBudgetMs) {
        totals.polls += 1;
        await sleep(pollMs);
        continue;
      }
      await drain();
      totals.target = "nao_apareceu";
      return totals;
    }

    if (row.status === "processing" || row.status === "done" || row.status === "dead") {
      totals.target = row.status === "processing" ? "com_outro_worker" : "processada";
      return totals;
    }

    // pending/failed: vencida → drena; agendada para logo → espera e drena,
    // se ainda sobra tempo para o handler; senão fica para o cron.
    const dueInMs = new Date(row.next_attempt_at).getTime() - clock();
    if (dueInMs > 0) {
      if (dueInMs <= NEAR_RETRY_MS && budgetMs - elapsed - dueInMs >= HANDLER_RESERVE_MS) {
        await sleep(dueInMs);
        continue;
      }
      totals.target = "agendada";
      return totals;
    }
    const result = await drain();
    if (result.claimed === 0) {
      // Outro worker levou a linha entre o SELECT e o claim.
      totals.target = "com_outro_worker";
      return totals;
    }
    // O lote pode ter pegado outras linhas mais antigas: confere o alvo de novo.
  }
}
