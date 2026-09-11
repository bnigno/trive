// "Me avisa quando voltar": aviso idempotente por peça+telefone; quando o
// disponível sai de zero, o ledger emite stock.restocked UMA vez e o fan-out
// enfileira um evento por aviso, escalonado na janela; o envio manda uma
// mensagem só, respeita a janela, quem deu SAIR e quem não tem estoque.
import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeMessagingProvider } from "@/adapters/zapi/fake";
import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { adjustStock, receiveStock } from "@/services/stock";
import {
  cancelStockAlert,
  fanOutRestockAlerts,
  listOpenAlertsByPhone,
  notifyRestockAlert,
  requestStockAlert,
} from "@/services/stock-alerts";
import { createTestDb, createTestUser, createTestVariant, type TestDb } from "../helpers/db";

let db: TestDb;
let sdb: DbOrTx;
let close: () => Promise<void>;
let userId: string;

const PHONE = "+5511999990000";
const NOON_SP = new Date("2026-09-10T15:00:00Z"); // 12:00 em São Paulo
const NIGHT_SP = new Date("2026-09-11T01:00:00Z"); // 22:00 em São Paulo (10/09)

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  sdb = db as unknown as DbOrTx;
  userId = (await createTestUser(db)).id;
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://x.supabase.co");
});

afterEach(async () => {
  await close();
  vi.unstubAllEnvs();
});

async function soldOutVariant(sku = "DUNAS-PRET-M") {
  const created = await createTestVariant(db, { sku, name: "Vestido Dunas", onHand: 0 });
  await db.insert(schema.productImages).values({ productId: created.productId, storagePath: "dunas/1-full.webp", sortOrder: 0 });
  return created;
}

async function seedTemplate() {
  await db.insert(schema.settings).values({ key: "wa_enabled", value: true });
  await db.insert(schema.waTemplates).values({
    key: "stock_back",
    label: "Voltou",
    bodyTemplate: "{{nome}}, voltou! {{produto}} — tem só {{quantidade}}. {{link}}",
    variables: ["nome", "produto", "quantidade", "link"],
    isActive: true,
  });
}

describe("requestStockAlert / cancelStockAlert", () => {
  it("cria uma vez por peça e telefone, vincula o cliente pelo telefone, cancela e permite pedir de novo", async () => {
    await db.insert(schema.customers).values({ fullName: "Ana Souza", phoneE164: PHONE, marketingOptIn: true });
    const { variantId } = await soldOutVariant();
    const first = await requestStockAlert(sdb, { variantId, phoneE164: PHONE, source: "site" });
    expect(first.created).toBe(true);
    const again = await requestStockAlert(sdb, { variantId, phoneE164: PHONE, source: "lia" });
    expect(again).toEqual({ created: false, alertId: null });
    const open = await listOpenAlertsByPhone(sdb, PHONE);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ productName: "Vestido Dunas", source: "site" });
    expect(open[0].customerId).not.toBeNull();

    expect(await cancelStockAlert(sdb, { alertId: first.alertId as string })).toEqual({ canceled: true });
    expect(await cancelStockAlert(sdb, { alertId: first.alertId as string })).toEqual({ canceled: false });
    expect(await listOpenAlertsByPhone(sdb, PHONE)).toEqual([]);
    expect((await requestStockAlert(sdb, { variantId, phoneE164: PHONE, source: "lia" })).created).toBe(true);
  });
});

describe("stock.restocked → fan-out escalonado", () => {
  it("o ledger emite stock.restocked uma vez quando o disponível sai de zero; o fan-out agenda um evento por aviso", async () => {
    await db.insert(schema.settings).values([
      { key: "wa_bulk_interval_seconds", value: 30 },
      { key: "wa_send_window_start", value: 9 },
      { key: "wa_send_window_end", value: 21 },
    ]);
    const { variantId } = await soldOutVariant();
    await requestStockAlert(sdb, { variantId, phoneE164: PHONE, source: "site" });
    await requestStockAlert(sdb, { variantId, phoneE164: "+5511999990001", source: "lia" });

    const received = await receiveStock(sdb, { variantId, quantity: 3, userId });
    // Mais uma entrada com estoque já positivo NÃO emite de novo.
    await receiveStock(sdb, { variantId, quantity: 1, userId });
    const restocked = await db.select().from(schema.outboxEvents).where(eq(schema.outboxEvents.eventType, "stock.restocked"));
    expect(restocked).toHaveLength(1);
    expect(restocked[0]).toMatchObject({
      dedupeKey: `stock.restocked:${received.movementId}`,
      payload: { variantId, movementId: received.movementId, available: 3 },
    });

    const result = await fanOutRestockAlerts(sdb, { variantId, movementId: received.movementId, now: NOON_SP });
    expect(result).toEqual({ queued: 2 });
    const events = await db
      .select()
      .from(schema.outboxEvents)
      .where(eq(schema.outboxEvents.eventType, "wa.restock_notify"))
      .orderBy(asc(schema.outboxEvents.nextAttemptAt));
    expect(events).toHaveLength(2);
    expect(events[0].nextAttemptAt.toISOString()).toBe(NOON_SP.toISOString());
    expect(events[1].nextAttemptAt.toISOString()).toBe(new Date(NOON_SP.getTime() + 30_000).toISOString());
    expect(events[0].dedupeKey).toMatch(new RegExp(`^wa\\.restock_notify:.+:${received.movementId}$`));

    // Reprocessar o mesmo movimento não duplica.
    expect(await fanOutRestockAlerts(sdb, { variantId, movementId: received.movementId, now: NOON_SP })).toEqual({ queued: 0 });
  });

  it("fora da janela, o primeiro envio cai na abertura de amanhã às 9h", async () => {
    const { variantId } = await soldOutVariant();
    await requestStockAlert(sdb, { variantId, phoneE164: PHONE, source: "site" });
    const adjusted = await adjustStock(sdb, { variantId, quantityDelta: 1, note: "achei uma", userId });
    await fanOutRestockAlerts(sdb, { variantId, movementId: adjusted.movementId, now: NIGHT_SP });
    const [event] = await db.select().from(schema.outboxEvents).where(eq(schema.outboxEvents.eventType, "wa.restock_notify"));
    expect(event.nextAttemptAt.toISOString()).toBe("2026-09-11T12:00:00.000Z");
  });
});

describe("notifyRestockAlert", () => {
  it("manda a foto com a legenda do template uma vez, marca o aviso e nunca repete", async () => {
    await seedTemplate();
    await db.insert(schema.customers).values({ fullName: "Ana Souza", phoneE164: PHONE, marketingOptIn: false });
    const { variantId } = await soldOutVariant();
    const { alertId } = await requestStockAlert(sdb, { variantId, phoneE164: PHONE, source: "site" });
    const received = await receiveStock(sdb, { variantId, quantity: 2, userId });
    const provider = new FakeMessagingProvider();

    const result = await notifyRestockAlert(sdb, provider, { alertId: alertId as string, movementId: received.movementId, now: NOON_SP });
    expect("sent" in result).toBe(true);
    expect(provider.sentImages).toHaveLength(1);
    expect(provider.sentImages[0]).toMatchObject({
      toE164: PHONE,
      imageUrl: "https://x.supabase.co/storage/v1/object/public/product-images/dunas/1-full.webp",
    });
    expect(provider.sentImages[0]?.caption).toContain("Ana, voltou! Vestido Dunas — tem só 2.");
    expect(provider.sentImages[0]?.caption).toContain("/produto/dunas-pret-m");
    const [alert] = await db.select().from(schema.stockAlerts);
    expect(alert.notifiedAt).not.toBeNull();
    expect(alert.notifiedWaMessageId).not.toBeNull();

    const again = await notifyRestockAlert(sdb, provider, { alertId: alertId as string, movementId: received.movementId, now: NOON_SP });
    expect(again).toEqual({ skipped: "ja_avisado" });
    expect(provider.sentImages).toHaveLength(1);
  });

  it("fora da janela adia (evento datado); sem estoque de novo pula; quem deu SAIR é cancelada", async () => {
    await seedTemplate();
    const { variantId } = await soldOutVariant();
    const { alertId } = await requestStockAlert(sdb, { variantId, phoneE164: PHONE, source: "site" });
    const provider = new FakeMessagingProvider();
    const received = await receiveStock(sdb, { variantId, quantity: 1, userId });

    expect(await notifyRestockAlert(sdb, provider, { alertId: alertId as string, movementId: received.movementId, now: NIGHT_SP })).toEqual({
      skipped: "fora_da_janela",
    });
    const deferred = await db.select().from(schema.outboxEvents).where(eq(schema.outboxEvents.eventType, "wa.restock_notify"));
    expect(deferred).toHaveLength(1);
    expect(deferred[0].dedupeKey).toBe(`wa.restock_notify:${alertId}:${received.movementId}:2026-09-10`);
    expect(deferred[0].nextAttemptAt.toISOString()).toBe("2026-09-11T12:00:00.000Z");

    // Vendeu de novo antes do horário: sem estoque, o aviso fica aberto.
    await adjustStock(sdb, { variantId, quantityDelta: -1, note: "vendida no balcão", userId });
    expect(await notifyRestockAlert(sdb, provider, { alertId: alertId as string, movementId: received.movementId, now: NOON_SP })).toEqual({
      skipped: "sem_estoque",
    });
    expect((await listOpenAlertsByPhone(sdb, PHONE))).toHaveLength(1);

    // Cliente que deu SAIR: cancela em silêncio.
    await adjustStock(sdb, { variantId, quantityDelta: 2, note: "voltou", userId });
    const [customer] = await db
      .insert(schema.customers)
      .values({ fullName: "Ana Souza", phoneE164: PHONE, marketingOptIn: false })
      .returning({ id: schema.customers.id });
    await db.insert(schema.auditLog).values({
      actorType: "customer",
      actorId: customer.id,
      action: "wa.opt_out",
      entityType: "customer",
      entityId: customer.id,
      after: { marketingOptIn: false },
    });
    expect(await notifyRestockAlert(sdb, provider, { alertId: alertId as string, movementId: received.movementId, now: NOON_SP })).toEqual({
      skipped: "sem_opt_in",
    });
    expect(await listOpenAlertsByPhone(sdb, PHONE)).toEqual([]);
    expect(provider.sentImages).toHaveLength(0);
    expect(provider.sentMessages).toHaveLength(0);
  });
});
