// O outbox-kick com id: espera a linha aparecer (a transação de quem
// enfileirou pode não ter commitado), reclama o ALVO primeiro quando vence,
// espera um retry próximo pelo relógio do banco, não briga com outro worker
// e, sem tempo para o handler, pede outra invocação em vez de começar e
// morrer nos 60 s da rota. Relógio e sleep injetados onde não há banco no
// meio; onde o now() do Postgres decide, o teste espera de verdade.
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Db } from "@/db/client";
import * as schema from "@/db/schema";
import { KICK_POLL_BUDGET_MS, runOutboxKick } from "@/queue/kick";
import { createTestDb, type TestDb } from "../helpers/db";

const handlers: Record<string, (event: { id: string; deadlineAt?: Date; source?: string }) => Promise<void>> = {};
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
function fakeTime(startMs = Date.now()) {
  let now = startMs;
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

async function insertEvent(input: { eventType?: string; status?: string; nextAttemptInMs?: number; lockedBy?: string } = {}): Promise<string> {
  const [row] = await db
    .insert(schema.outboxEvents)
    .values({
      eventType: input.eventType ?? "order.receipt",
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

function recorder() {
  const runs: string[] = [];
  handlers["order.receipt"] = async (event) => {
    runs.push(event.id);
  };
  handlers["wa.bot_turn"] = async (event) => {
    runs.push(event.id);
  };
  return runs;
}

describe("runOutboxKick", () => {
  it("linha pendente: reclama o alvo primeiro, roda, e aproveita para drenar o resto", async () => {
    const runs = recorder();
    // Dez linhas mais antigas na frente: o alvo ainda sai primeiro.
    const older: string[] = [];
    for (let i = 0; i < 10; i++) older.push(await insertEvent({ nextAttemptInMs: -60_000 }));
    const id = await insertEvent();
    const time = fakeTime();
    const result = await runOutboxKick(asDb(), { outboxEventId: id, ...time });
    expect(runs[0]).toBe(id);
    expect(new Set(runs)).toEqual(new Set([id, ...older]));
    expect(result).toMatchObject({ claimed: 11, done: 11, target: "processada", polls: 0, rekicked: [] });
    expect(await statusOf(id)).toBe("done");
  });

  it("inline (a própria invocação que enfileirou): reclama só o alvo, não drena o resto e a origem chega ao handler", async () => {
    const sources: string[] = [];
    handlers["wa.bot_turn"] = async (event) => {
      sources.push(event.source ?? "?");
    };
    handlers["order.receipt"] = async (event) => {
      sources.push(event.source ?? "?");
    };
    const other = await insertEvent({ nextAttemptInMs: -60_000 });
    const id = await insertEvent({ eventType: "wa.bot_turn" });
    const time = fakeTime();
    const result = await runOutboxKick(asDb(), { outboxEventId: id, source: "inline", ...time });
    expect(result).toMatchObject({ source: "inline", target: "processada", claimed: 1, done: 1, rekicked: [] });
    expect(sources).toEqual(["inline"]);
    expect(await statusOf(id)).toBe("done");
    expect(await statusOf(other)).toBe("pending");
  });

  it("inline cujo alvo falhou (turno sem tempo depois de esperar o lock, provedor fora) pede outra invocação — o kick com id já tinha passado", async () => {
    handlers["wa.bot_turn"] = async () => {
      throw new Error("sem tempo");
    };
    const id = await insertEvent({ eventType: "wa.bot_turn" });
    const requested: string[] = [];
    const time = fakeTime();
    const result = await runOutboxKick(asDb(), {
      outboxEventId: id,
      source: "inline",
      requestKick: async (target) => {
        requested.push(target);
      },
      ...time,
    });
    expect(result).toMatchObject({ target: "processada", failed: 1, rekicked: [id] });
    expect(requested).toEqual([id]);
    expect(await statusOf(id)).toBe("failed");
  });

  it("linha que ainda não commitou: espera em pequenos passos até aparecer, depois roda", async () => {
    const runs = recorder();
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
    const runs = recorder();
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
    expect(result).toMatchObject({ claimed: 0, target: "nao_reclamada" });
    expect(await statusOf(id)).toBe("processing");
  });

  it("retry próximo (failed, daqui a ~0,8 s pelo relógio do banco): espera de verdade, com folga, e roda", async () => {
    const runs = recorder();
    const soon = await insertEvent({ status: "failed", nextAttemptInMs: 800 });
    const startedAt = Date.now();
    const result = await runOutboxKick(asDb(), { outboxEventId: soon });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(800);
    expect(runs).toEqual([soon]);
    expect(result.target).toBe("processada");
  }, 10_000);

  it("retry distante (2 min) fica para o cron", async () => {
    recorder();
    const far = await insertEvent({ status: "failed", nextAttemptInMs: 120_000 });
    const time = fakeTime();
    const result = await runOutboxKick(asDb(), { outboxEventId: far, ...time });
    expect(result).toMatchObject({ claimed: 0, target: "agendada" });
    expect(time.slept).toEqual([]);
  });

  it("sem tempo para o handler nesta invocação: não começa, pede outra invocação (uma vez só)", async () => {
    handlers["wa.bot_turn"] = async () => {
      throw new Error("não devia rodar");
    };
    const id = await insertEvent({ eventType: "wa.bot_turn" });
    const kicked: string[] = [];
    const requestKick = async (eventId: string) => {
      kicked.push(eventId);
    };
    // Orçamento de 20 s < 32 s de reserva de um turno.
    const result = await runOutboxKick(asDb(), { outboxEventId: id, ...fakeTime(), budgetMs: 20_000, requestKick });
    expect(result).toMatchObject({ target: "sem_tempo", claimed: 0, rekicked: [id] });
    expect(kicked).toEqual([id]);
    expect(await statusOf(id)).toBe("pending");

    // A repetição (rekick) não pede de novo: fica para o cron.
    const again = await runOutboxKick(asDb(), { outboxEventId: id, ...fakeTime(), budgetMs: 10_000, rekick: true, requestKick });
    expect(again).toMatchObject({ target: "sem_tempo", rekicked: [] });
    expect(kicked).toHaveLength(1);

    // Com orçamento inteiro, roda.
    const runs = recorder();
    const full = await runOutboxKick(asDb(), { outboxEventId: id, ...fakeTime(), rekick: true, requestKick });
    expect(full.target).toBe("processada");
    expect(runs).toEqual([id]);
  });

  it("sem id: um drain só, como o cron; turno da Lia devolvido por falta de tempo ganha outra invocação", async () => {
    const runs = recorder();
    const a = await insertEvent();
    const b = await insertEvent();
    const time = fakeTime();
    const result = await runOutboxKick(asDb(), { ...time });
    expect(new Set(runs)).toEqual(new Set([a, b]));
    expect(result).toMatchObject({ claimed: 2, done: 2, target: "sem_id" });

    // Orçamento curto (10 s < 32 s de reserva): o turno volta à fila e é re-kickado.
    const turn = await insertEvent({ eventType: "wa.bot_turn" });
    const kicked: string[] = [];
    const short = await runOutboxKick(asDb(), {
      ...fakeTime(),
      budgetMs: 10_000,
      requestKick: async (eventId) => {
        kicked.push(eventId);
      },
    });
    expect(short).toMatchObject({ claimed: 1, released: 1, done: 0, rekicked: [turn] });
    expect(kicked).toEqual([turn]);
    expect(await statusOf(turn)).toBe("pending");
  });
});
