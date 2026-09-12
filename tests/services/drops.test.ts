// Lançamentos: peça escondida até publicar (convidada vê antes), público por
// afinidade materializado ao agendar, janela VIP com um evento por convidada
// escalonado, convite único com opt-in, publicação pelo cron e relatório.
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeMessagingProvider } from "@/adapters/zapi/fake";
import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import {
  cancelDrop,
  createDrop,
  dispatchDueDrops,
  getDrop,
  getDropForToken,
  getDropReport,
  previewDropAudience,
  recordDropVisit,
  scheduleDrop,
  sendDropInvite,
  setDropProducts,
} from "@/services/drops";
import { getPublicProductBySlug, getStoreMap, listPublicProducts } from "@/services/store-catalog";
import { saveStyleProfile } from "@/services/style-profiles";
import { createTestDb, createTestUser, type TestDb } from "../helpers/db";

let db: TestDb;
let sdb: DbOrTx;
let close: () => Promise<void>;
let userId: string;

const NOW = new Date("2026-09-15T15:00:00Z"); // 12:00 SP
const PUBLISH_AT = new Date("2026-09-20T13:00:00Z"); // 10:00 SP
const VIP_AT = new Date("2026-09-19T13:00:00Z"); // 24 h antes, 10:00 SP (na janela)

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  sdb = db as unknown as DbOrTx;
  userId = (await createTestUser(db)).id;
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://x.supabase.co");
  await db.insert(schema.settings).values({ key: "wa_enabled", value: true });
});

afterEach(async () => {
  await close();
  vi.unstubAllEnvs();
});

async function category(name: string, slug: string) {
  const [row] = await db.insert(schema.categories).values({ name, slug }).returning({ id: schema.categories.id });
  return row.id;
}

async function product(
  name: string,
  slug: string,
  opts: { status?: "draft" | "active"; categoryId?: string; variants?: { sku: string; attributes: Record<string, string>; onHand: number }[]; photo?: boolean; price?: boolean } = {},
) {
  const [p] = await db
    .insert(schema.products)
    .values({ name, slug, status: opts.status ?? "draft", attributesSchema: ["cor", "tamanho"], ...(opts.categoryId ? { categoryId: opts.categoryId } : {}) })
    .returning({ id: schema.products.id });
  for (const v of opts.variants ?? [{ sku: `${slug}-M`, attributes: { cor: "Terracota", tamanho: "M" }, onHand: 3 }]) {
    const [variant] = await db
      .insert(schema.productVariants)
      .values({ productId: p.id, sku: v.sku, costCents: 1000, attributes: v.attributes })
      .returning({ id: schema.productVariants.id });
    await db.insert(schema.stockLevels).values({ productVariantId: variant.id, onHand: v.onHand, reserved: 0 });
    if (opts.price !== false) {
      await db.insert(schema.priceVersions).values({
        productVariantId: variant.id,
        versionNumber: 1,
        status: "active",
        priceCents: 28900,
        origin: "initial",
        breakdown: {},
        costSnapshotCents: 1000,
        computedMarginRate: "0.3000",
        activatedAt: new Date(),
      });
    }
  }
  if (opts.photo !== false) {
    await db.insert(schema.productImages).values({ productId: p.id, storagePath: `${slug}/1-full.webp`, sortOrder: 0 });
  }
  return p.id;
}

/** Chaves dos eventos de pré-desenho enfileirados (na ordem de criação). */
async function publishedEvents() {
  return (
    await db
      .select({ dedupeKey: schema.outboxEvents.dedupeKey })
      .from(schema.outboxEvents)
      .where(eq(schema.outboxEvents.eventType, "product.published"))
      .orderBy(schema.outboxEvents.createdAt)
  ).map((row) => row.dedupeKey);
}

async function customer(name: string, phone: string, optIn = true) {
  const [row] = await db
    .insert(schema.customers)
    .values({ fullName: name, phoneE164: phone, marketingOptIn: optIn })
    .returning({ id: schema.customers.id });
  return row.id;
}

async function seedDrop() {
  const vestidos = await category("Vestidos", "vestidos");
  const productId = await product("Vestido Aurora", "vestido-aurora", { categoryId: vestidos });
  const ana = await customer("Ana Souza", "+5511999990001");
  await saveStyleProfile(sdb, { phoneE164: "+5511999990001", patch: { sizes: { vestido: "M" }, colorsLove: ["Terracota"] }, source: "quiz", consent: true });
  const bia = await customer("Bia Lima", "+5511999990002");
  await saveStyleProfile(sdb, { phoneE164: "+5511999990002", patch: { colorsAvoid: ["Terracota"] }, source: "quiz", consent: true });
  const carla = await customer("Carla Reis", "+5511999990003", false);
  await saveStyleProfile(sdb, { phoneE164: "+5511999990003", patch: { sizes: { vestido: "M" } }, source: "quiz", consent: true });
  const { dropId } = await createDrop(sdb, { name: "Edição Primavera", publishAt: PUBLISH_AT, vipWindowHours: 24, audienceLimit: 10, userId });
  await setDropProducts(sdb, { dropId, productIds: [productId], userId });
  return { dropId, productId, ana, bia, carla };
}

describe("agendar e visibilidade", () => {
  it("calcula o público, agenda (peça em rascunho vira ativa e escondida) e só a convidada vê antes", async () => {
    const { dropId, productId, ana } = await seedDrop();
    const preview = await previewDropAudience(sdb, dropId);
    expect(preview.eligible).toBe(1);
    expect(preview.sample[0]).toMatchObject({ customerId: ana, score: 5, reasons: ["tem o M dela", "em Terracota, cor que ela ama"] });

    expect(await scheduleDrop(sdb, { dropId, userId, now: NOW })).toEqual({ invites: 1 });
    const drop = await getDrop(sdb, dropId, NOW);
    expect(drop?.status).toBe("scheduled");
    expect(drop?.phase).toBe("scheduled");
    expect(drop?.products[0]).toMatchObject({ status: "active", hasActivePrice: true, hasStock: true, hasPhoto: true });
    const [row] = await db.select().from(schema.products).where(eq(schema.products.id, productId));
    expect(row.visibleFrom?.toISOString()).toBe(PUBLISH_AT.toISOString());

    // Vitrine pública: escondida. Convidada (por cliente ou token): vê a partir da janela VIP.
    expect((await listPublicProducts(sdb, { limit: 10 })).map((p) => p.slug)).toEqual([]);
    expect(await getPublicProductBySlug(sdb, "vestido-aurora")).toBeNull();
    expect((await getStoreMap(sdb)).totalProducts).toBe(0);
    expect((await listPublicProducts(sdb, { limit: 10, viewer: { customerId: ana } })).map((p) => p.slug)).toEqual([]);
    const [invite] = await db.select().from(schema.dropInvites);
    vi.useFakeTimers({ now: VIP_AT, toFake: ["Date"] });
    try {
      expect((await listPublicProducts(sdb, { limit: 10, viewer: { customerId: ana } })).map((p) => p.slug)).toEqual(["vestido-aurora"]);
      expect((await getPublicProductBySlug(sdb, "vestido-aurora", { inviteToken: invite.token }))?.slug).toBe("vestido-aurora");
      expect(await getPublicProductBySlug(sdb, "vestido-aurora")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
    // Página da convidada
    const forToken = await getDropForToken(sdb, invite.token, VIP_AT);
    expect(forToken?.drop.phase).toBe("vip");
    expect(forToken?.invite.firstName).toBe("Ana");
    expect(forToken?.products.map((p) => p.slug)).toEqual(["vestido-aurora"]);
    expect(await getDropForToken(sdb, "00000000-0000-4000-8000-000000000000", VIP_AT)).toBeNull();
    await recordDropVisit(sdb, invite.token, VIP_AT);
    const [visited] = await db.select().from(schema.dropInvites);
    expect(visited.firstVisitAt?.toISOString()).toBe(VIP_AT.toISOString());
  });

  it("não agenda com problemas; cancelar libera as peças", async () => {
    const productId = await product("Sem Foto", "sem-foto", { photo: false, status: "draft" });
    const { dropId } = await createDrop(sdb, { name: "Teste", publishAt: PUBLISH_AT, userId });
    await setDropProducts(sdb, { dropId, productIds: [productId], userId });
    await expect(scheduleDrop(sdb, { dropId, userId, now: NOW })).rejects.toThrow(/sem foto/);
    await db.insert(schema.productImages).values({ productId, storagePath: "sem-foto/1-full.webp", sortOrder: 0 });
    await scheduleDrop(sdb, { dropId, userId, now: NOW });
    await expect(setDropProducts(sdb, { dropId, productIds: [productId], userId })).rejects.toThrow(/Cancele/);
    // Agendar esconde a peça: nada de pré-desenho ainda (ele sairia como "agendada").
    expect(await publishedEvents()).toEqual([]);
    await cancelDrop(sdb, { dropId, userId });
    const [row] = await db.select().from(schema.products).where(eq(schema.products.id, productId));
    expect(row.visibleFrom).toBeNull();
    expect((await getDrop(sdb, dropId, NOW))?.phase).toBe("canceled");
    // Cancelar libera a peça na loja agora: o post nasce pronto (uma vez).
    expect(await publishedEvents()).toEqual([`product.published:${productId}:drop-cancel:${dropId}`]);
  });
});

describe("janela VIP, convite e publicação", () => {
  it("o cron enfileira um convite por convidada (escalonado), o envio manda foto+texto uma vez, e publica na hora", async () => {
    await db.insert(schema.waTemplates).values({
      key: "drop_vip_invite",
      label: "Convite",
      bodyTemplate: "{{nome}}, {{lancamento}} abre em {{prazo}}: {{link}} ({{pecas}})",
      variables: ["nome", "lancamento", "prazo", "link", "pecas"],
      isActive: true,
    });
    const { dropId, productId, ana } = await seedDrop();
    await scheduleDrop(sdb, { dropId, userId, now: NOW });

    // Antes da janela: nada.
    expect(await dispatchDueDrops(sdb, { now: NOW })).toEqual({ vipQueued: 0, published: 0 });
    // Janela aberta (10:00 SP): um evento por convidada, agendado para já.
    expect(await dispatchDueDrops(sdb, { now: VIP_AT })).toEqual({ vipQueued: 1, published: 0 });
    expect(await dispatchDueDrops(sdb, { now: VIP_AT })).toEqual({ vipQueued: 0, published: 0 });
    const events = await db.select().from(schema.outboxEvents).where(eq(schema.outboxEvents.eventType, "wa.drop_invite"));
    expect(events).toHaveLength(1);
    expect(events[0].dedupeKey).toBe(`wa.drop:${dropId}:${ana}`);
    expect(events[0].nextAttemptAt.toISOString()).toBe(VIP_AT.toISOString());
    expect((await getDrop(sdb, dropId, VIP_AT))?.status).toBe("vip_sent");

    const provider = new FakeMessagingProvider();
    const [invite] = await db.select().from(schema.dropInvites);
    const sent = await sendDropInvite(sdb, provider, { inviteId: invite.id, now: VIP_AT });
    expect("sent" in sent).toBe(true);
    expect(provider.sentImages).toHaveLength(1);
    expect(provider.sentImages[0]?.caption).toContain("Ana, Edição Primavera abre em 20/09 às 10:00");
    expect(provider.sentImages[0]?.caption).toContain(`/lancamento/${invite.token}`);
    expect(provider.sentImages[0]?.caption).toContain("(Vestido Aurora)");
    expect(await sendDropInvite(sdb, provider, { inviteId: invite.id, now: VIP_AT })).toEqual({ skipped: "ja_enviado" });
    expect(provider.sentImages).toHaveLength(1);
    const [afterSend] = await db.select().from(schema.dropInvites);
    expect(afterSend.sentAt).not.toBeNull();

    // Na hora marcada: publica e a peça aparece para todo mundo — e o post,
    // o story e o carrossel dela entram na fila (uma vez por lançamento).
    expect(await publishedEvents()).toEqual([]);
    expect(await dispatchDueDrops(sdb, { now: PUBLISH_AT })).toEqual({ vipQueued: 0, published: 1 });
    expect((await getDrop(sdb, dropId, PUBLISH_AT))?.status).toBe("published");
    expect(await publishedEvents()).toEqual([`product.published:${productId}:drop:${dropId}`]);
    expect(await dispatchDueDrops(sdb, { now: PUBLISH_AT })).toEqual({ vipQueued: 0, published: 0 });
    expect(await publishedEvents()).toHaveLength(1);
    vi.useFakeTimers({ now: PUBLISH_AT, toFake: ["Date"] });
    try {
      expect((await listPublicProducts(sdb, { limit: 10 })).map((p) => p.slug)).toEqual(["vestido-aurora"]);
    } finally {
      vi.useRealTimers();
    }
    expect(await sendDropInvite(sdb, provider, { inviteId: invite.id, now: PUBLISH_AT })).toEqual({ skipped: "ja_enviado" });

    const report = await getDropReport(sdb, dropId);
    expect(report).toMatchObject({ invites: 1, sent: 1, visited: 0, orders: 0, revenueCents: 0 });
    expect(report.rows[0]).toMatchObject({ fullName: "Ana Souza", score: 5 });
  });

  it("fora da janela de envio o convite é adiado; sem opt-in ou fora da fase VIP não sai", async () => {
    await db.insert(schema.waTemplates).values({ key: "drop_vip_invite", label: "Convite", bodyTemplate: "{{link}}", variables: ["link"], isActive: true });
    const { dropId, ana } = await seedDrop();
    await scheduleDrop(sdb, { dropId, userId, now: NOW });
    await dispatchDueDrops(sdb, { now: VIP_AT });
    const provider = new FakeMessagingProvider();
    const [invite] = await db.select().from(schema.dropInvites);

    const night = new Date("2026-09-20T01:00:00Z"); // 22:00 SP de 19/09, ainda VIP
    expect(await sendDropInvite(sdb, provider, { inviteId: invite.id, now: night })).toEqual({ skipped: "fora_da_janela" });
    const deferred = await db
      .select()
      .from(schema.outboxEvents)
      .where(and(eq(schema.outboxEvents.eventType, "wa.drop_invite"), eq(schema.outboxEvents.dedupeKey, `wa.drop:${dropId}:${ana}:2026-09-19`)));
    expect(deferred).toHaveLength(1);
    expect(deferred[0].nextAttemptAt.toISOString()).toBe("2026-09-20T12:00:00.000Z");

    await db.update(schema.customers).set({ marketingOptIn: false }).where(eq(schema.customers.id, ana));
    expect(await sendDropInvite(sdb, provider, { inviteId: invite.id, now: VIP_AT })).toEqual({ skipped: "sem_opt_in" });
    expect(await sendDropInvite(sdb, provider, { inviteId: invite.id, now: NOW })).toEqual({ skipped: "fora_da_fase_vip" });
    expect(provider.sentImages).toHaveLength(0);
  });
});
