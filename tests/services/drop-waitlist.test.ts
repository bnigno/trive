// A lista "me avisa quando a cortina abrir" (PGlite + FakeMessagingProvider):
// entrar é idempotente e só vale para estreia agendada; publicar vira um
// evento por linha, escalonado dentro da janela; o aviso sai uma vez, adia
// fora da janela, respeita SAIR e só depois de a cortina abrir. E /estreia
// sabe qual estreia mostrar (teaser → open → nada).
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeMessagingProvider } from "@/adapters/zapi/fake";
import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { countDropWaitlist, fanOutDropWaitlist, joinDropWaitlist, notifyDropOpen } from "@/services/drop-waitlist";
import { createDrop, getUpcomingDropTeaser, publishDrop, scheduleDrop, setDropProducts } from "@/services/drops";
import { createTestDb, createTestUser, type TestDb } from "../helpers/db";

let db: TestDb;
let sdb: DbOrTx;
let close: () => Promise<void>;
let userId: string;

const NOW = new Date("2026-09-15T15:00:00Z"); // 12:00 SP (na janela)
const NIGHT = new Date("2026-09-20T02:00:00Z"); // 23:00 SP do dia 19 (fora da janela)
const PUBLISH_AT = new Date("2026-09-20T13:00:00Z"); // 10:00 SP
const AFTER = new Date("2026-09-20T13:05:00Z");
const ANA = "+5511999990001";

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  sdb = db as unknown as DbOrTx;
  userId = (await createTestUser(db)).id;
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://x.supabase.co");
  await db.insert(schema.settings).values([
    { key: "wa_enabled", value: true },
    { key: "wa_bulk_interval_seconds", value: 30 },
  ]);
  await db.insert(schema.waTemplates).values({
    key: "drop_open",
    label: "A cortina abriu",
    bodyTemplate: "{{nome}}, {{lancamento}} abriu: {{pecas}} — {{link}}",
    variables: ["nome", "lancamento", "pecas", "link"],
    isActive: true,
  });
});

afterEach(async () => {
  await close();
  vi.unstubAllEnvs();
});

async function product(name: string, slug: string) {
  const [p] = await db.insert(schema.products).values({ name, slug, status: "draft", attributesSchema: ["cor", "tamanho"] }).returning({ id: schema.products.id });
  const [variant] = await db.insert(schema.productVariants).values({ productId: p.id, sku: `${slug}-M`, costCents: 1000, attributes: { cor: "Areia", tamanho: "M" } }).returning({ id: schema.productVariants.id });
  await db.insert(schema.stockLevels).values({ productVariantId: variant.id, onHand: 3, reserved: 0 });
  await db.insert(schema.priceVersions).values({ productVariantId: variant.id, versionNumber: 1, status: "active", priceCents: 28900, origin: "initial", breakdown: {}, costSnapshotCents: 1000, computedMarginRate: "0.3000", activatedAt: new Date() });
  await db.insert(schema.productImages).values({ productId: p.id, storagePath: `${slug}/1-full.webp`, sortOrder: 0 });
  return p.id;
}

async function scheduledDrop(name = "Edição Círio") {
  const productId = await product("Longo Dunas", "longo-dunas");
  const { dropId } = await createDrop(sdb, { name, publishAt: PUBLISH_AT, vipWindowHours: 24, audienceLimit: 10, userId });
  await setDropProducts(sdb, { dropId, productIds: [productId], userId });
  await scheduleDrop(sdb, { dropId, userId, now: NOW });
  return { dropId, productId };
}

async function openEvents() {
  return db.select().from(schema.outboxEvents).where(eq(schema.outboxEvents.eventType, "wa.drop_open_notify")).orderBy(schema.outboxEvents.createdAt);
}

describe("joinDropWaitlist", () => {
  it("entra uma vez por telefone; a segunda vez não duplica; audita só quando cria", async () => {
    const { dropId } = await scheduledDrop();
    const first = await joinDropWaitlist(sdb, { dropId, phoneE164: ANA, source: "site" }, NOW);
    expect(first.created).toBe(true);
    const again = await joinDropWaitlist(sdb, { dropId, phoneE164: ANA, source: "site" }, NOW);
    expect(again).toEqual({ created: false, waitlistId: null });
    expect(await countDropWaitlist(sdb, dropId)).toEqual({ total: 1, notified: 0, open: 1 });
    const audit = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "drop.waitlist_join"));
    expect(audit).toHaveLength(1);
  });

  it("cliente cadastrada com esse telefone fica ligada à linha; estreia que já abriu (ou não existe) não aceita", async () => {
    const { dropId } = await scheduledDrop();
    const [customer] = await db.insert(schema.customers).values({ fullName: "Ana Souza", phoneE164: ANA }).returning({ id: schema.customers.id });
    const joined = await joinDropWaitlist(sdb, { dropId, phoneE164: ANA }, NOW);
    expect(joined.created).toBe(true);
    const [row] = await db.select().from(schema.dropWaitlist);
    expect(row.customerId).toBe(customer.id);
    expect(row.source).toBe("site");
    // Depois da hora marcada não há o que avisar.
    expect(await joinDropWaitlist(sdb, { dropId, phoneE164: "+5511999990002" }, AFTER)).toEqual({ created: false, waitlistId: null, reason: "sem_estreia" });
    expect(await joinDropWaitlist(sdb, { dropId: "00000000-0000-4000-8000-000000000000", phoneE164: ANA }, NOW)).toMatchObject({ reason: "sem_estreia" });
  });
});

describe("publicar → fan-out → aviso", () => {
  it("drop.published vira um evento por linha aberta, escalonado pelo intervalo; repetir não duplica", async () => {
    const { dropId } = await scheduledDrop();
    await joinDropWaitlist(sdb, { dropId, phoneE164: ANA }, NOW);
    await joinDropWaitlist(sdb, { dropId, phoneE164: "+5511999990002" }, NOW);
    await publishDrop(sdb, { dropId, now: PUBLISH_AT });

    expect(await fanOutDropWaitlist(sdb, { dropId, now: PUBLISH_AT })).toEqual({ queued: 2 });
    const events = await openEvents();
    expect(events.map((e) => e.nextAttemptAt.getTime() - PUBLISH_AT.getTime())).toEqual([0, 30_000]);
    expect(events[0].dedupeKey).toBe(`wa.drop_open_notify:${events[0].aggregateId}`);
    expect(await fanOutDropWaitlist(sdb, { dropId, now: PUBLISH_AT })).toEqual({ queued: 0 });
    expect(await openEvents()).toHaveLength(2);
  });

  it("estreia às 20h59 com 3 na lista: 1 cabe hoje, as outras continuam amanhã às 9h no mesmo passo (sem rajada)", async () => {
    const { dropId } = await scheduledDrop();
    for (const phone of [ANA, "+5511999990002", "+5511999990003"]) await joinDropWaitlist(sdb, { dropId, phoneE164: phone }, NOW);
    const late = new Date("2026-09-19T23:59:50Z"); // 20:59:50 SP
    await publishDrop(sdb, { dropId, now: late });
    await fanOutDropWaitlist(sdb, { dropId, now: late });
    expect((await openEvents()).map((e) => e.nextAttemptAt.toISOString())).toEqual([
      "2026-09-19T23:59:50.000Z",
      "2026-09-20T12:00:00.000Z",
      "2026-09-20T12:00:30.000Z",
    ]);
  });

  it("estreia de madrugada: o fan-out agenda para a abertura da janela (9h SP)", async () => {
    const { dropId } = await scheduledDrop();
    await joinDropWaitlist(sdb, { dropId, phoneE164: ANA }, NOW);
    await publishDrop(sdb, { dropId, now: NIGHT });
    await fanOutDropWaitlist(sdb, { dropId, now: NIGHT });
    const [event] = await openEvents();
    expect(event.nextAttemptAt.toISOString()).toBe("2026-09-20T12:00:00.000Z");
  });

  it("o aviso sai uma vez com nome, lançamento, peças e link; a linha fica avisada; repetir é ja_enviado", async () => {
    const { dropId } = await scheduledDrop();
    await db.insert(schema.customers).values({ fullName: "Ana Souza", phoneE164: ANA, marketingOptIn: true });
    const joined = await joinDropWaitlist(sdb, { dropId, phoneE164: ANA }, NOW);
    await publishDrop(sdb, { dropId, now: PUBLISH_AT });
    const provider = new FakeMessagingProvider();

    const result = await notifyDropOpen(sdb, provider, { waitlistId: joined.waitlistId!, now: AFTER });
    expect("sent" in result).toBe(true);
    expect(provider.sentMessages).toHaveLength(1);
    expect(provider.sentMessages[0].toE164).toBe(ANA);
    expect(provider.sentMessages[0].body).toContain("Ana, Edição Círio abriu: Longo Dunas — ");
    expect(provider.sentMessages[0].body).toContain("/estreia");
    const [row] = await db.select().from(schema.dropWaitlist);
    expect(row.notifiedAt).not.toBeNull();
    expect(await notifyDropOpen(sdb, provider, { waitlistId: joined.waitlistId!, now: AFTER })).toEqual({ skipped: "ja_avisado" });
    expect(provider.sentMessages).toHaveLength(1);
    expect(await countDropWaitlist(sdb, dropId)).toEqual({ total: 1, notified: 1, open: 0 });
  });

  it("antes da cortina abrir não manda; fora da janela adia com dedupe datado; quem deu SAIR é cancelada em silêncio", async () => {
    const { dropId } = await scheduledDrop();
    const joined = await joinDropWaitlist(sdb, { dropId, phoneE164: ANA }, NOW);
    const provider = new FakeMessagingProvider();
    expect(await notifyDropOpen(sdb, provider, { waitlistId: joined.waitlistId!, now: NOW })).toEqual({ skipped: "nao_publicado" });

    await publishDrop(sdb, { dropId, now: NIGHT });
    expect(await notifyDropOpen(sdb, provider, { waitlistId: joined.waitlistId!, now: NIGHT })).toEqual({ skipped: "fora_da_janela" });
    const deferred = await openEvents();
    expect(deferred).toHaveLength(1);
    expect(deferred[0].dedupeKey).toBe(`wa.drop_open_notify:${joined.waitlistId}:2026-09-19`);
    expect(deferred[0].nextAttemptAt.toISOString()).toBe("2026-09-20T12:00:00.000Z");

    // SAIR registrado DEPOIS de pedir o aviso: cancela e não manda.
    const [customer] = await db.insert(schema.customers).values({ fullName: "Ana", phoneE164: ANA, marketingOptIn: false }).returning({ id: schema.customers.id });
    await db.insert(schema.auditLog).values({ actorType: "customer", actorId: customer.id, action: "wa.opt_out", entityType: "customer", entityId: customer.id, createdAt: new Date(NOW.getTime() + 3_600_000) });
    expect(await notifyDropOpen(sdb, provider, { waitlistId: joined.waitlistId!, now: AFTER })).toEqual({ skipped: "sem_opt_in" });
    expect(provider.sentMessages).toHaveLength(0);
    expect((await db.select().from(schema.dropWaitlist))[0].canceledAt).not.toBeNull();
  });
});

describe("SAIR e consentimento", () => {
  it("SAIR pelo WhatsApp SEM cadastro cancela a linha (a /estreia é sem login) e o aviso não sai", async () => {
    const { dropId } = await scheduledDrop();
    const joined = await joinDropWaitlist(sdb, { dropId, phoneE164: ANA }, NOW);
    vi.stubEnv("ZAPI_WEBHOOK_SECRET", "segredo");
    const { processZapiInbound } = await import("@/services/wa-inbound");
    const result = await processZapiInbound(sdb, {
      providedSecret: "segredo",
      body: { type: "ReceivedCallback", instanceId: "i", messageId: "MSG-SAIR", phone: ANA.slice(1), fromMe: false, isGroup: false, senderName: "Ana", momment: Date.now(), status: "RECEIVED", text: { message: "SAIR" } },
    });
    expect(result.action).toBe("opt_out");
    const [row] = await db.select().from(schema.dropWaitlist);
    expect(row.canceledAt).not.toBeNull();
    await publishDrop(sdb, { dropId, now: PUBLISH_AT });
    expect(await fanOutDropWaitlist(sdb, { dropId, now: PUBLISH_AT })).toEqual({ queued: 0 });
    expect(await notifyDropOpen(sdb, new FakeMessagingProvider(), { waitlistId: joined.waitlistId!, now: AFTER })).toEqual({ skipped: "ja_avisado" });
  });

  it("caixinha marcada DEPOIS de um SAIR antigo é consentimento novo: o aviso sai", async () => {
    const { dropId } = await scheduledDrop();
    const [customer] = await db.insert(schema.customers).values({ fullName: "Ana", phoneE164: ANA, marketingOptIn: false }).returning({ id: schema.customers.id });
    await db.insert(schema.auditLog).values({ actorType: "customer", actorId: customer.id, action: "wa.opt_out", entityType: "customer", entityId: customer.id, createdAt: new Date(NOW.getTime() - 86_400_000) });
    const joined = await joinDropWaitlist(sdb, { dropId, phoneE164: ANA }, NOW);
    await publishDrop(sdb, { dropId, now: PUBLISH_AT });
    const provider = new FakeMessagingProvider();
    const result = await notifyDropOpen(sdb, provider, { waitlistId: joined.waitlistId!, now: AFTER });
    expect("sent" in result).toBe(true);
    expect(provider.sentMessages).toHaveLength(1);
  });
});

describe("getUpcomingDropTeaser", () => {
  it("agendada → teaser com as peças e a contagem da lista; na hora → open por um dia; depois nada", async () => {
    expect(await getUpcomingDropTeaser(sdb, NOW)).toBeNull();
    const { dropId, productId } = await scheduledDrop();
    await joinDropWaitlist(sdb, { dropId, phoneE164: ANA }, NOW);
    const teaser = (await getUpcomingDropTeaser(sdb, NOW))!;
    expect(teaser).toMatchObject({ dropId, name: "Edição Círio", state: "teaser", waitlist: { total: 1 } });
    expect(teaser.products).toEqual([{ id: productId, name: "Longo Dunas", slug: "longo-dunas", imagePath: "longo-dunas/1-full.webp" }]);
    // Pelo relógio, mesmo antes de o cron publicar.
    expect((await getUpcomingDropTeaser(sdb, AFTER))?.state).toBe("open");
    await publishDrop(sdb, { dropId, now: PUBLISH_AT });
    expect((await getUpcomingDropTeaser(sdb, new Date(PUBLISH_AT.getTime() + 23 * 3_600_000)))?.state).toBe("open");
    expect(await getUpcomingDropTeaser(sdb, new Date(PUBLISH_AT.getTime() + 25 * 3_600_000))).toBeNull();
  });

  it("com outra estreia já agendada, a que acabou de abrir tem prioridade por um dia (é para lá que o aviso manda)", async () => {
    const { dropId } = await scheduledDrop();
    const other = await createDrop(sdb, { name: "Edição Seguinte", publishAt: new Date(PUBLISH_AT.getTime() + 7 * 86_400_000), vipWindowHours: 24, audienceLimit: 10, userId });
    await db.update(schema.drops).set({ status: "scheduled" }).where(eq(schema.drops.id, other.dropId));
    expect((await getUpcomingDropTeaser(sdb, NOW))?.dropId).toBe(dropId);
    await publishDrop(sdb, { dropId, now: PUBLISH_AT });
    const opened = (await getUpcomingDropTeaser(sdb, AFTER))!;
    expect(opened).toMatchObject({ dropId, state: "open" });
    const nextDay = (await getUpcomingDropTeaser(sdb, new Date(PUBLISH_AT.getTime() + 25 * 3_600_000)))!;
    expect(nextDay).toMatchObject({ dropId: other.dropId, state: "teaser" });
  });
});
