// A fila de (re)desenho dos cartões: só peça ativa, uma rajada vira um evento,
// os refreshes se encadeiam 20 s um após o outro (mesmo vindos de chamadas
// separadas, como um lote de preços) e evento agendado não dá kick no Inngest.
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import {
  CARD_REFRESH_DELAY_MS,
  CARD_REFRESH_STAGGER_MS,
  enqueueProductCardRefresh,
  enqueueProductPublished,
} from "@/services/product-cards-queue";
import { createTestDb, createTestVariant, type TestDb } from "../helpers/db";

const send = vi.fn(async (_event: unknown) => ({ ids: [] as string[] }));
vi.mock("@/inngest/client", () => ({ inngest: { send: (event: unknown) => send(event) } }));

let db: TestDb;
let sdb: DbOrTx;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  sdb = db as unknown as DbOrTx;
  send.mockClear();
});

afterEach(async () => {
  await close();
});

async function refreshes() {
  return db
    .select({
      aggregateId: schema.outboxEvents.aggregateId,
      dedupeKey: schema.outboxEvents.dedupeKey,
      nextAttemptAt: schema.outboxEvents.nextAttemptAt,
      status: schema.outboxEvents.status,
    })
    .from(schema.outboxEvents)
    .where(eq(schema.outboxEvents.eventType, "product.card_refresh"))
    .orderBy(schema.outboxEvents.nextAttemptAt);
}

describe("enqueueProductCardRefresh", () => {
  it("só peça ativa; a mesma peça numa rajada (lote de preços) vira um evento só", async () => {
    const { productId } = await createTestVariant(db, { sku: "RAJ-1" });
    const rascunho = await createTestVariant(db, { sku: "RAJ-2" });
    await db.update(schema.products).set({ status: "draft" }).where(eq(schema.products.id, rascunho.productId));
    const now = new Date("2026-09-12T12:00:00Z");

    expect(await enqueueProductCardRefresh(sdb, { productIds: [rascunho.productId], reason: "x", now })).toBe(0);
    expect(await enqueueProductCardRefresh(sdb, { productIds: [productId, productId], reason: "price:v1", now })).toBe(1);
    // Três variações da mesma peça, três chamadas: o refresh já marcado cobre todas.
    expect(await enqueueProductCardRefresh(sdb, { productIds: [productId], reason: "price:v2", now })).toBe(0);
    expect(await enqueueProductCardRefresh(sdb, { productIds: [productId], reason: "price:v3", now })).toBe(0);
    const rows = await refreshes();
    expect(rows).toHaveLength(1);
    expect(rows[0].nextAttemptAt.getTime()).toBe(now.getTime() + CARD_REFRESH_DELAY_MS);
  });

  it("peças diferentes em chamadas separadas se encadeiam 20 s uma após a outra", async () => {
    const a = await createTestVariant(db, { sku: "ENC-A" });
    const b = await createTestVariant(db, { sku: "ENC-B" });
    const c = await createTestVariant(db, { sku: "ENC-C" });
    const now = new Date("2026-09-12T12:00:00Z");
    for (const { productId } of [a, b, c]) {
      await enqueueProductCardRefresh(sdb, { productIds: [productId], reason: "price", now });
    }
    const rows = await refreshes();
    expect(rows.map((row) => row.aggregateId)).toEqual([a.productId, b.productId, c.productId]);
    const base = now.getTime() + CARD_REFRESH_DELAY_MS;
    expect(rows.map((row) => row.nextAttemptAt.getTime() - base)).toEqual([
      0,
      CARD_REFRESH_STAGGER_MS,
      2 * CARD_REFRESH_STAGGER_MS,
    ]);
    // Uma chamada com várias peças continua escalonando, atrás do último marcado.
    const d = await createTestVariant(db, { sku: "ENC-D" });
    const e = await createTestVariant(db, { sku: "ENC-E" });
    await enqueueProductCardRefresh(sdb, { productIds: [d.productId, e.productId], reason: "edition_name", now });
    const after = await refreshes();
    expect(after.map((row) => row.nextAttemptAt.getTime() - base)).toEqual([0, 20_000, 40_000, 60_000, 80_000]);
  });

  it("depois que o refresh marcado roda (ou está prestes a rodar), uma mudança nova gera outro evento", async () => {
    const { productId } = await createTestVariant(db, { sku: "DEP-1" });
    const now = new Date("2026-09-12T12:00:00Z");
    await enqueueProductCardRefresh(sdb, { productIds: [productId], reason: "name", now });
    const [first] = await refreshes();

    // Já rodou: não protege mais.
    await db.update(schema.outboxEvents).set({ status: "done" }).where(eq(schema.outboxEvents.dedupeKey, first.dedupeKey!));
    const later = new Date(now.getTime() + 60_000);
    expect(await enqueueProductCardRefresh(sdb, { productIds: [productId], reason: "image", now: later })).toBe(1);

    // Prestes a vencer (menos de 5 s): pode já estar sendo reclamado — entra outro.
    const almost = new Date(later.getTime() + CARD_REFRESH_DELAY_MS - 2_000);
    expect(await enqueueProductCardRefresh(sdb, { productIds: [productId], reason: "price", now: almost })).toBe(1);
    expect(await refreshes()).toHaveLength(3);
  });

  it("evento agendado para depois não dá kick no Inngest; o imediato dá", async () => {
    const { productId } = await createTestVariant(db, { sku: "KICK-1" });
    await enqueueProductCardRefresh(sdb, { productIds: [productId], reason: "name" });
    expect(send).not.toHaveBeenCalled();
    await enqueueProductPublished(sdb, { productId, dedupeSuffix: "agora" });
    expect(send).toHaveBeenCalledTimes(1);
    await enqueueProductPublished(sdb, { productId, dedupeSuffix: "depois", nextAttemptAt: new Date(Date.now() + 3_600_000) });
    expect(send).toHaveBeenCalledTimes(1);
  });
});
