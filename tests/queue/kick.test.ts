// O outbox-kick com id: espera a linha aparecer (a transação de quem
// enfileirou pode não ter commitado), drena quando ela está vencida, espera
// um retry próximo, e não briga com outro worker. Relógio e sleep injetados:
// nada de esperar de verdade.
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Db } from "@/db/client";
import * as schema from "@/db/schema";
import { KICK_POLL_BUDGET_MS, runOutboxKick } from "@/queue/kick";
import { createTestDb, type TestDb } from "../helpers/db";

const handlers: Record<string, (event: { id: string }) => Promise<void>> = {};
vi.mock("@/queue/handlers", () => ({
  resolveOutboxHandler: (eventType: string) => {
    const handler = handlers[eventType];
    if (!handler) throw new Error(`sem handler para ${eventType}`);
    return handler;
  },
}));

let db: TestDb;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  for (const key of Object.keys(handlers)) delete handlers[key];
});

afterEach(async () => {
  await close();
});

const asDb = () => db as unknown as Db;

/** Relógio de mentira: cada sleep(ms) avança o relógio em ms sem esperar. */
function fakeTime() {
  let now = Date.now();
  const slept: number[] = [];
  return {
    clock: () => now,
    sleep: async (ms: number) => {
      slept.push(ms);
      now += ms;
    },
    slept,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

async function insertEvent(input: { status?: string; nextAttemptInMs?: number; lockedBy?: string } = {}): Promise<string> {
  const [row] = await db
    .insert(schema.outboxEvents)
    .values({
      eventType: "order.receipt",
      payload: {},
      status: input.status ?? "pending",
      nextAttemptAt: new Date(Date.now() + (input.nextAttemptInMs ?? 0)),
      ...(input.lockedBy ? { lockedBy: input.lockedBy, lockedAt: new Date() } : {}),
    })
    .returning({ id: schema.outboxEvents.id });
  return row.id;
}

async function statusOf(id: string): Promise<string> {
  const [row] = await db.select({ status: schema.outboxEvents.status }).from(schema.outboxEvents).where(eq(schema.outboxEvents.id, id));
  return row.status;
}

describe("runOutboxKick", () => {
  it("linha pendente: drena uma vez e o handler roda", async () => {
    const runs: string[] = [];
    handlers["order.receipt"] = async (event) => {
      runs.push(event.id);
    };
    const id = await insertEvent();
    const time = fakeTime();
    const result = await runOutboxKick(asDb(), { outboxEventId: id, ...time });
    expect(runs).toEqual([id]);
    expect(result).toMatchObject({ claimed: 1, done: 1, target: "processada", polls: 0 });
    expect(await statusOf(id)).toBe("done");
  });

  it("linha que ainda não commitou: espera em pequenos passos até aparecer, depois roda", async () => {
    const runs: string[] = [];
    handlers["order.receipt"] = async (event) => {
      runs.push(event.id);
    };
    const id = "00000000-0000-4000-8000-00000000c1c1";
    const time = fakeTime();
    let polls = 0;
    const sleep = async (ms: number) => {
      await time.sleep(ms);
      polls += 1;
      // "Commit" de quem enfileirou acontece no segundo poll.
      if (polls === 2) {
        await db.insert(schema.outboxEvents).values({ id, eventType: "order.receipt", payload: {} });
      }
    };
    const result = await runOutboxKick(asDb(), { outboxEventId: id, clock: time.clock, sleep, pollMs: 500 });
    expect(runs).toEqual([id]);
    expect(result).toMatchObject({ claimed: 1, done: 1, target: "processada", polls: 2 });
  });

  it("linha que nunca aparece: desiste depois do orçamento de espera, drena o que houver e não lança", async () => {
    const runs: string[] = [];
    handlers["order.receipt"] = async (event) => {
      runs.push(event.id);
    };
    const other = await insertEvent();
    const time = fakeTime();
    const result = await runOutboxKick(asDb(), { outboxEventId: "00000000-0000-4000-8000-00000000dead", ...time, pollMs: 1_000 });
    expect(result.target).toBe("nao_apareceu");
    expect(result.polls).toBe(KICK_POLL_BUDGET_MS / 1_000);
    // O kick nunca deixa a fila parada: a outra linha saiu.
    expect(runs).toEqual([other]);
  });

  it("linha com outro worker (processing): não roda nada", async () => {
    handlers["order.receipt"] = async () => {
      throw new Error("não devia rodar");
    };
    const id = await insertEvent({ status: "processing", lockedBy: "outro" });
    const time = fakeTime();
    const result = await runOutboxKick(asDb(), { outboxEventId: id, ...time });
    expect(result).toMatchObject({ claimed: 0, target: "com_outro_worker" });
    expect(await statusOf(id)).toBe("processing");
  });

  it("retry próximo (failed, daqui a 3 s): espera e roda; distante demais fica para o cron", async () => {
    const runs: string[] = [];
    handlers["order.receipt"] = async (event) => {
      runs.push(event.id);
    };
    const soon = await insertEvent({ status: "failed", nextAttemptInMs: 3_000 });
    const time = fakeTime();
    // O claim usa now() do banco: o relógio de mentira não engana o Postgres,
    // então o "sleep" também adianta a linha para o passado.
    const sleep = async (ms: number) => {
      await time.sleep(ms);
      await db.execute(sql`update outbox_events set next_attempt_at = now() - interval '1 second' where id = ${soon}`);
    };
    const result = await runOutboxKick(asDb(), { outboxEventId: soon, clock: time.clock, sleep });
    expect(time.slept.length).toBe(1);
    expect(time.slept[0]).toBeGreaterThan(2_000);
    expect(time.slept[0]).toBeLessThanOrEqual(3_000);
    expect(runs).toEqual([soon]);
    expect(result.target).toBe("processada");

    const far = await insertEvent({ status: "failed", nextAttemptInMs: 120_000 });
    const time2 = fakeTime();
    const result2 = await runOutboxKick(asDb(), { outboxEventId: far, ...time2 });
    expect(result2).toMatchObject({ claimed: 0, target: "agendada" });
    expect(time2.slept).toEqual([]);
  });

  it("sem id: um drain só, como o cron", async () => {
    const runs: string[] = [];
    handlers["order.receipt"] = async (event) => {
      runs.push(event.id);
    };
    const a = await insertEvent();
    const b = await insertEvent();
    const time = fakeTime();
    const result = await runOutboxKick(asDb(), { ...time });
    expect(new Set(runs)).toEqual(new Set([a, b]));
    expect(result).toMatchObject({ claimed: 2, done: 2, target: "sem_id" });
  });
});
