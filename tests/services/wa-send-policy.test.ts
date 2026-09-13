// A política de envio num lugar só: janela e intervalo dos settings (com os
// padrões quando faltam) e o adiamento datado de quem chegou fora da hora.
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { deferOutsideSendWindow, loadSendPolicy } from "@/services/wa-send-policy";
import { createTestDb, type TestDb } from "../helpers/db";

let db: TestDb;
let sdb: DbOrTx;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  sdb = db as unknown as DbOrTx;
});
afterEach(async () => {
  await close();
});

describe("loadSendPolicy", () => {
  it("padrões 9–21 e 20 s; settings válidos vencem; lixo cai no padrão", async () => {
    expect(await loadSendPolicy(sdb)).toEqual({ window: { startHour: 9, endHour: 21 }, intervalSeconds: 20 });
    await db.insert(schema.settings).values([
      { key: "wa_send_window_start", value: 10 },
      { key: "wa_send_window_end", value: 20 },
      { key: "wa_bulk_interval_seconds", value: 0 },
    ]);
    expect(await loadSendPolicy(sdb)).toEqual({ window: { startHour: 10, endHour: 20 }, intervalSeconds: 20 });
  });
});

describe("deferOutsideSendWindow", () => {
  it("fora da janela re-enfileira para a abertura com dedupe datado (um por dia); dentro, não faz nada", async () => {
    const policy = await loadSendPolicy(sdb);
    const night = new Date("2026-09-20T02:00:00Z"); // 23:00 SP do dia 19
    const base = { eventType: "wa.drop_open_notify", dedupeBase: "wa.drop_open_notify:x", aggregateType: "drop_waitlist", aggregateId: "00000000-0000-4000-8000-000000000001", payload: { waitlistId: "x" } };
    expect(await deferOutsideSendWindow(sdb, policy, { ...base, now: night })).toBe(true);
    expect(await deferOutsideSendWindow(sdb, policy, { ...base, now: new Date(night.getTime() + 60_000) })).toBe(true);
    const rows = await db.select().from(schema.outboxEvents).where(eq(schema.outboxEvents.eventType, "wa.drop_open_notify"));
    expect(rows).toHaveLength(1);
    expect(rows[0].dedupeKey).toBe("wa.drop_open_notify:x:2026-09-19");
    expect(rows[0].nextAttemptAt.toISOString()).toBe("2026-09-20T12:00:00.000Z");
    expect(await deferOutsideSendWindow(sdb, policy, { ...base, now: new Date("2026-09-20T15:00:00Z") })).toBe(false);
    expect(await db.select().from(schema.outboxEvents)).toHaveLength(1);
  });
});
