// O painel das chegadas: a lista (mais recente primeiro, com rascunho,
// fornecedor, conta e a permissão de refazer) e o "Refazer" (arquiva o
// rascunho, cancela a conta pendente, volta para a fila) — nunca para
// chegada que já lançou estoque.
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { countAtelierIntakesFailed, listAtelierIntakes, redoAtelierIntake } from "@/services/atelier";
import { createTestDb, createTestSupplier, FIXED_USER_ID, type TestDb } from "../helpers/db";

const OWNER = "+5591981037536";

let db: TestDb;
let sdb: DbOrTx;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  sdb = db as unknown as DbOrTx;
  vi.stubEnv("ADAPTER_MODE", "fake");
});

afterEach(async () => {
  await close();
  vi.unstubAllEnvs();
});

async function seedIntake(input: {
  status: "queued" | "done" | "failed";
  withProduct?: boolean;
  productStatus?: "draft" | "active";
  withPayable?: boolean;
  movements?: number;
  at?: Date;
}): Promise<{ intakeId: string; productId: string | null; entryId: string | null }> {
  const [conversation] = await db
    .insert(schema.waConversations)
    .values({ phoneE164: OWNER, status: "closed" })
    .returning({ id: schema.waConversations.id });
  const [message] = await db
    .insert(schema.waMessages)
    .values({ conversationId: conversation.id, direction: "inbound", kind: "text", zapiMessageId: `MSG-${Math.random()}`, body: "chegou o Longo Dunas", status: "delivered" })
    .returning({ id: schema.waMessages.id });
  let productId: string | null = null;
  if (input.withProduct) {
    const [product] = await db
      .insert(schema.products)
      .values({ name: "Longo Dunas", slug: `longo-dunas-${Math.random().toString(36).slice(2, 6)}`, status: input.productStatus ?? "draft" })
      .returning({ id: schema.products.id });
    productId = product.id;
  }
  let entryId: string | null = null;
  let supplierId: string | null = null;
  if (input.withPayable) {
    supplierId = await createTestSupplier(db, { name: "Aurora" });
    const [entry] = await db
      .insert(schema.financialEntries)
      .values({ direction: "payable", category: "supplier", description: "Compra", amountCents: 288000, status: "pending", supplierId, createdBy: FIXED_USER_ID })
      .returning({ id: schema.financialEntries.id });
    entryId = entry.id;
  }
  const [intake] = await db
    .insert(schema.atelierIntakes)
    .values({
      conversationId: conversation.id,
      triggerWaMessageId: message.id,
      note: "chegou o Longo Dunas",
      status: input.status,
      productId,
      supplierId,
      financialEntryId: entryId,
      photosCount: 2,
      ...(input.at ? { createdAt: input.at } : {}),
      parsed: {
        proposal: null,
        suggestedPriceCents: null,
        model: "m",
        usage: null,
        estimatedCostUsdCents: 0,
        ms: 1,
        failed: null,
        purchase: { movements: input.movements ?? 0, totalQuantity: null, skipped: null, supplierError: null, purchaseError: null },
      },
    })
    .returning({ id: schema.atelierIntakes.id });
  return { intakeId: intake.id, productId, entryId };
}

describe("listAtelierIntakes / countAtelierIntakesFailed", () => {
  it("mais recente primeiro, com rascunho, fornecedor, conta e a permissão de refazer", async () => {
    const old = await seedIntake({ status: "done", withProduct: true, withPayable: true, movements: 8, at: new Date("2026-09-10T12:00:00Z") });
    const recent = await seedIntake({ status: "failed", at: new Date("2026-09-13T12:00:00Z") });
    const rows = await listAtelierIntakes(sdb);
    expect(rows.map((row) => row.id)).toEqual([recent.intakeId, old.intakeId]);
    expect(rows[1]).toMatchObject({
      product: { id: old.productId, name: "Longo Dunas", status: "draft" },
      supplier: { name: "Aurora" },
      payable: { id: old.entryId, amountCents: 288000, status: "pending" },
      redo: { ok: false, reason: "estoque_lancado" },
    });
    expect(rows[0]).toMatchObject({ product: null, redo: { ok: true } });
    expect(await countAtelierIntakesFailed(sdb)).toBe(1);
  });
});

describe("redoAtelierIntake", () => {
  it("arquiva o rascunho, cancela a conta pendente, limpa a chegada e volta para a fila", async () => {
    const { intakeId, productId, entryId } = await seedIntake({ status: "done", withProduct: true, withPayable: true, movements: 0 });
    const result = await redoAtelierIntake(sdb, { intakeId, userId: FIXED_USER_ID });
    expect(result).toEqual({ ok: true, archivedProductId: productId, canceledEntryId: entryId });

    const [product] = await db.select().from(schema.products).where(eq(schema.products.id, productId as string));
    expect(product.status).toBe("archived");
    const [entry] = await db.select().from(schema.financialEntries).where(eq(schema.financialEntries.id, entryId as string));
    expect(entry.status).toBe("canceled");
    const [intake] = await db.select().from(schema.atelierIntakes).where(eq(schema.atelierIntakes.id, intakeId));
    expect(intake).toMatchObject({ status: "queued", productId: null, supplierId: null, financialEntryId: null, cardPath: null, errorDetail: null, uploadedWaMessageIds: [] });
    expect(intake.parsed).toEqual({ redoCount: 1 });
    const events = await db.select().from(schema.outboxEvents);
    expect(events.map((event) => event.eventType)).toEqual(["wa.atelier_intake"]);
    expect(events[0].dedupeKey).toBe(`wa.atelier:redo:${intakeId}:1`);
    expect(events[0].payload).toEqual({ conversationId: intake.conversationId, triggerWaMessageId: intake.triggerWaMessageId });
    const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "atelier.redo"));
    expect(audits).toHaveLength(1);
  });

  it("rascunho já ativo fica como está (não arquiva); segunda vez ganha chave nova", async () => {
    const { intakeId, productId } = await seedIntake({ status: "failed", withProduct: true, productStatus: "active" });
    const first = await redoAtelierIntake(sdb, { intakeId, userId: FIXED_USER_ID });
    expect(first).toEqual({ ok: true, archivedProductId: null, canceledEntryId: null });
    const [product] = await db.select().from(schema.products).where(eq(schema.products.id, productId as string));
    expect(product.status).toBe("active");
    // A fila está montando: não dá para refazer de novo agora.
    expect(await redoAtelierIntake(sdb, { intakeId, userId: FIXED_USER_ID })).toEqual({ ok: false, reason: "em_andamento" });
    await db.update(schema.atelierIntakes).set({ status: "failed" }).where(eq(schema.atelierIntakes.id, intakeId));
    await redoAtelierIntake(sdb, { intakeId, userId: FIXED_USER_ID });
    const events = await db.select().from(schema.outboxEvents);
    expect(events.map((event) => event.dedupeKey)).toEqual([`wa.atelier:redo:${intakeId}:1`, `wa.atelier:redo:${intakeId}:2`]);
  });

  it("chegada que já lançou estoque não se refaz; chegada inexistente idem", async () => {
    const { intakeId } = await seedIntake({ status: "done", withProduct: true, movements: 8 });
    expect(await redoAtelierIntake(sdb, { intakeId, userId: FIXED_USER_ID })).toEqual({ ok: false, reason: "estoque_lancado" });
    expect(await redoAtelierIntake(sdb, { intakeId: "00000000-0000-4000-8000-000000000009", userId: FIXED_USER_ID })).toEqual({ ok: false, reason: "chegada_inexistente" });
  });
});
