// O varredor do outbox: o teto de tentativas vem da política do evento,
// lease vencido conta como tentativa, e um lote sem tempo devolve o resto à
// fila em vez de deixar a função morrer no meio.
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Db } from "@/db/client";
import * as schema from "@/db/schema";
import { drainOutbox } from "@/queue/worker";
import { createTestDb, type TestDb } from "../helpers/db";

// Handlers injetados: o teste decide quem falha e quem demora. O módulo real
// puxa todos os adapters; aqui só interessa o comportamento do varredor.
const handlers: Record<string, (event: { id: string; eventType: string }) => Promise<void>> = {};
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

async function insertEvent(input: {
  eventType: string;
  attempts?: number;
  status?: "pending" | "failed" | "processing";
  lockedMinutesAgo?: number;
  dedupeKey?: string;
}) {
  const [row] = await db
    .insert(schema.outboxEvents)
    .values({
      eventType: input.eventType,
      payload: {},
      attempts: input.attempts ?? 0,
      status: input.status ?? "pending",
      dedupeKey: input.dedupeKey ?? `${input.eventType}:${Math.random()}`,
      ...(input.lockedMinutesAgo !== undefined
        ? {
            lockedAt: new Date(Date.now() - input.lockedMinutesAgo * 60_000),
            lockedBy: "worker-que-morreu",
          }
        : {}),
    })
    .returning({ id: schema.outboxEvents.id });
  return row.id;
}

async function eventRow(id: string) {
  const [row] = await db.select().from(schema.outboxEvents).where(eq(schema.outboxEvents.id, id));
  return row;
}

const asDb = () => db as unknown as Db;

describe("drainOutbox — teto pela política", () => {
  it("wa.card_render morre na 2ª tentativa; o padrão (8) ainda tem retry — a coluna max_attempts não manda", async () => {
    handlers["wa.card_render"] = async () => {
      throw new Error("foto não abre");
    };
    handlers["order.receipt"] = async () => {
      throw new Error("provedor fora");
    };
    const card = await insertEvent({ eventType: "wa.card_render", attempts: 1 });
    const receipt = await insertEvent({ eventType: "order.receipt", attempts: 1 });
    // A coluna diz 8 para os dois (padrão antigo): o worker ignora e segue a política.
    expect((await eventRow(card)).maxAttempts).toBe(8);

    const now = new Date();
    const result = await drainOutbox(asDb(), { now, limit: 10 });
    expect(result).toMatchObject({ claimed: 2, done: 0, failed: 1, dead: 1, released: 0 });

    const deadCard = await eventRow(card);
    expect(deadCard.status).toBe("dead");
    expect(deadCard.attempts).toBe(2);
    expect(deadCard.lastError).toContain("foto não abre");
    expect(deadCard.lockedBy).toBeNull();

    const retried = await eventRow(receipt);
    expect(retried.status).toBe("failed");
    expect(retried.attempts).toBe(2);
    expect(retried.nextAttemptAt.getTime()).toBeGreaterThan(now.getTime());
  });

  it("handler que resolve marca done e limpa o lock", async () => {
    handlers["order.receipt"] = async () => {};
    const id = await insertEvent({ eventType: "order.receipt" });
    const result = await drainOutbox(asDb(), { limit: 10 });
    expect(result).toMatchObject({ claimed: 1, done: 1, failed: 0, dead: 0 });
    const row = await eventRow(id);
    expect(row.status).toBe("done");
    expect(row.processedAt).not.toBeNull();
    expect(row.lockedBy).toBeNull();
  });
});

describe("drainOutbox — lease vencido", () => {
  it("conta como tentativa pela política: product.published na 2ª vira dead; o padrão volta a failed com backoff", async () => {
    handlers["product.published"] = async () => {};
    handlers["order.receipt"] = async () => {};
    const stuckCard = await insertEvent({
      eventType: "product.published",
      status: "processing",
      attempts: 1,
      lockedMinutesAgo: 6,
    });
    const stuckReceipt = await insertEvent({
      eventType: "order.receipt",
      status: "processing",
      attempts: 0,
      lockedMinutesAgo: 6,
    });
    const fresh = await insertEvent({
      eventType: "order.receipt",
      status: "processing",
      attempts: 0,
      lockedMinutesAgo: 1,
    });

    const now = new Date();
    const result = await drainOutbox(asDb(), { now, limit: 10 });
    expect(result.recovered).toBe(2);

    const dead = await eventRow(stuckCard);
    expect(dead.status).toBe("dead");
    expect(dead.attempts).toBe(2);
    expect(dead.lastError).toContain("lease expired");
    expect(dead.lockedBy).toBeNull();

    // Recuperado como failed com next_attempt_at no futuro: não é reprocessado neste lote.
    const failed = await eventRow(stuckReceipt);
    expect(failed.status).toBe("failed");
    expect(failed.attempts).toBe(1);
    expect(failed.nextAttemptAt.getTime()).toBeGreaterThan(now.getTime());
    expect(result.claimed).toBe(0);

    // Lease ainda válido: ninguém mexe.
    const untouched = await eventRow(fresh);
    expect(untouched.status).toBe("processing");
    expect(untouched.lockedBy).toBe("worker-que-morreu");
  });
});

describe("drainOutbox — orçamento de tempo do lote", () => {
  it("estourado o orçamento, o que não começou volta a pending sem contar tentativa; o que começou termina", async () => {
    const order: string[] = [];
    handlers["order.receipt"] = async (event) => {
      order.push(event.id);
    };
    const first = await insertEvent({ eventType: "order.receipt" });
    const second = await insertEvent({ eventType: "order.receipt" });
    const third = await insertEvent({ eventType: "order.receipt" });

    // Relógio injetado: início e primeira checagem em 0; depois do primeiro
    // handler, já passou do orçamento.
    let ticks = 0;
    const clock = () => (ticks++ < 2 ? 0 : 10_000);
    const result = await drainOutbox(asDb(), { limit: 10, budgetMs: 5_000, clock });
    expect(result).toMatchObject({ claimed: 3, done: 1, released: 2, failed: 0, dead: 0 });
    expect(order).toHaveLength(1);

    // Quem rodou está done; os outros dois voltaram a pending, sem lock nem tentativa.
    const rows = await Promise.all([first, second, third].map((id) => eventRow(id)));
    const ran = rows.find((row) => row.id === order[0])!;
    expect(ran.status).toBe("done");
    for (const row of rows.filter((candidate) => candidate.id !== order[0])) {
      expect(row.status).toBe("pending");
      expect(row.attempts).toBe(0);
      expect(row.lockedBy).toBeNull();
    }

    // O lote seguinte pega os dois na hora.
    const next = await drainOutbox(asDb(), { limit: 10 });
    expect(next).toMatchObject({ claimed: 2, done: 2, released: 0 });
  });

  it("sem orçamento, o lote inteiro roda", async () => {
    handlers["order.receipt"] = async () => {};
    await insertEvent({ eventType: "order.receipt" });
    await insertEvent({ eventType: "order.receipt" });
    const result = await drainOutbox(asDb(), { limit: 10 });
    expect(result).toMatchObject({ claimed: 2, done: 2, released: 0 });
  });
});
