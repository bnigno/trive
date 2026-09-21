// O kick do outbox: quem enfileira dá um kick no Inngest (best-effort), a
// menos que peça `kick: false` — caso de quem está dentro de uma transação
// longa e dá o kick depois do commit com kickOutbox().
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { createTestDb, type TestDb } from "../helpers/db";

const sent: unknown[] = [];
let failSend = false;
let hangSend = false;
vi.mock("@/inngest/client", () => ({
  inngest: {
    send: async (event: unknown) => {
      if (failSend) throw new Error("inngest fora");
      if (hangSend) return new Promise(() => {});
      sent.push(event);
      return { ids: [] };
    },
  },
}));

const { enqueueOutboxEvent, kickOutbox, KICK_TIMEOUT_MS } = await import("@/queue/enqueue");

let db: TestDb;
let sdb: DbOrTx;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  sdb = db as unknown as DbOrTx;
  sent.length = 0;
  failSend = false;
  hangSend = false;
});

afterEach(async () => {
  await close();
});

describe("enqueueOutboxEvent — kick", () => {
  it("por padrão manda o kick com o id da linha", async () => {
    const id = await enqueueOutboxEvent(sdb, { eventType: "order.receipt", payload: { orderId: "x" } });
    expect(id).not.toBeNull();
    expect(sent).toEqual([{ name: "outbox/event.enqueued", data: { outboxEventId: id } }]);
  });

  it("kick: false não manda nada (quem chama dá o kick depois do commit)", async () => {
    const id = await enqueueOutboxEvent(sdb, { eventType: "order.receipt" }, { kick: false });
    expect(id).not.toBeNull();
    expect(sent).toEqual([]);
    const rows = await db.select().from(schema.outboxEvents);
    expect(rows).toHaveLength(1);
  });

  it("evento agendado para o futuro não recebe kick (o cron entrega na hora certa)", async () => {
    await enqueueOutboxEvent(sdb, { eventType: "order.receipt", nextAttemptAt: new Date(Date.now() + 60_000) });
    expect(sent).toEqual([]);
  });

  it("duplicado (dedupe) devolve null e não manda kick", async () => {
    await enqueueOutboxEvent(sdb, { eventType: "order.receipt", dedupeKey: "k" });
    const again = await enqueueOutboxEvent(sdb, { eventType: "order.receipt", dedupeKey: "k" });
    expect(again).toBeNull();
    expect(sent).toHaveLength(1);
  });

  it("Inngest fora do ar não derruba quem enfileira (o cron entrega) — e deixa aviso no log com o evento e a causa", async () => {
    failSend = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const id = await enqueueOutboxEvent(sdb, { eventType: "order.receipt" });
    expect(id).not.toBeNull();
    expect(warn).toHaveBeenCalledWith("[outbox] kick ao Inngest falhou", { outboxEventId: id, eventType: "order.receipt", causa: "inngest fora" });
    await expect(kickOutbox()).resolves.toBeUndefined();
    warn.mockRestore();
  });
});

describe("kickOutbox", () => {
  it("Inngest que não responde: desiste em 3 s (relógio falso) com aviso, sem segurar quem enfileirou", async () => {
    hangSend = true;
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const pending = kickOutbox("00000000-0000-4000-8000-000000000002", { eventType: "wa.bot_turn" });
      await vi.advanceTimersByTimeAsync(KICK_TIMEOUT_MS + 1);
      await expect(pending).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith("[outbox] kick ao Inngest falhou", {
        outboxEventId: "00000000-0000-4000-8000-000000000002",
        eventType: "wa.bot_turn",
        causa: `sem resposta em ${KICK_TIMEOUT_MS} ms`,
      });
    } finally {
      vi.useRealTimers();
      warn.mockRestore();
    }
  });

  it("sem id manda data vazia (drena o que houver); com id manda o id", async () => {
    await kickOutbox();
    await kickOutbox("00000000-0000-4000-8000-000000000001");
    expect(sent).toEqual([
      { name: "outbox/event.enqueued", data: {} },
      { name: "outbox/event.enqueued", data: { outboxEventId: "00000000-0000-4000-8000-000000000001" } },
    ]);
  });
});
