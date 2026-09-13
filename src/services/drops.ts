// Lançamentos com janela VIP: as peças ficam escondidas até publish_at
// (products.visible_from) e, vip_window_hours antes, as clientes cuja cartela
// e histórico conversam com as peças recebem o convite — uma por cliente,
// escalonado na janela de envio, só com opt-in. O público é materializado
// ao agendar (drop_invites) para o relatório fechar com o que foi enviado.
import { and, asc, desc, eq, gt, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";

import type { MessagingProvider } from "@/adapters/zapi";
import {
  canSchedule,
  DROP_MAX_PRODUCTS,
  dropPhase,
  rankAudience,
  TEASER_OPEN_GRACE_MS,
  teaserState,
  vipStartsAt,
  type AudienceCandidate,
  type DropAffinityProduct,
  type DropPhase,
  type DropProductFacts,
  type RankedInvite,
  type TeaserState,
} from "@/core/drops";
import { styleProfileSchema } from "@/core/style/profile";
import { renderTemplate } from "@/core/whatsapp/render";
import { isWithinSendWindow, nextSendWindowStart, staggerWithinWindow } from "@/core/whatsapp/send-window";
import {
  auditLog,
  customerProfiles,
  customers,
  dropInvites,
  dropProducts,
  drops,
  dropWaitlist,
  orderItems,
  orders,
  products,
  productVariants,
  stockLevels,
  waTemplates,
} from "@/db/schema";
import { siteUrl } from "@/lib/site-url";
import { spDayKey } from "@/lib/sp-day";
import { enqueueOutboxEvent, type DbOrTx } from "@/queue/enqueue";
import { enqueueProductPublished } from "@/services/product-cards-queue";
import { getSettingsMap } from "@/services/settings";
import { loadSendPolicy } from "@/services/wa-send-policy";
import {
  listPublicProducts,
  publicImageUrl,
  type PublicProductListItem,
} from "@/services/store-catalog";
import {
  isWaEnabled,
  sendMediaMessage,
  sendTemplateMessage,
  type SendWaMessageResult,
} from "@/services/wa-messaging";

export class ServiceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ServiceError";
    this.code = code;
  }
}

export const DROP_INVITE_TEMPLATE_KEY = "drop_vip_invite";
/** Compras de convidadas contam até 7 dias depois da publicação. */
const REPORT_WINDOW_MS = 7 * 86_400_000;
const PAID_STATUSES = ["paid", "preparing", "shipped", "delivered"] as const;

const dateTimeFmt = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

export function formatDropMoment(date: Date): string {
  return dateTimeFmt.format(date).replace(",", " às");
}

// ---------------------------------------------------------------------------
// Visões
// ---------------------------------------------------------------------------

export interface DropProductView extends DropProductFacts {
  slug: string;
  imagePath: string | null;
}

export interface DropView {
  id: string;
  name: string;
  status: string;
  phase: DropPhase;
  publishAt: Date;
  vipStartsAt: Date;
  vipWindowHours: number;
  audienceLimit: number;
  messageOverride: string | null;
  vipSentAt: Date | null;
  publishedAt: Date | null;
  canceledAt: Date | null;
  createdAt: Date;
  products: DropProductView[];
  invites: { total: number; sent: number; visited: number };
  /** "Quero ser avisada" em /estreia: quantas pediram e quantas já receberam. */
  waitlist: { total: number; notified: number };
}

async function loadDropProducts(db: DbOrTx, dropId: string): Promise<DropProductView[]> {
  const rows = await db
    .select({
      id: products.id,
      name: products.name,
      slug: products.slug,
      status: products.status,
      hasActivePrice: sql<boolean>`exists (
        select 1 from product_variants pv join price_versions pr on pr.product_variant_id = pv.id
        where pv.product_id = ${products.id} and pv.deleted_at is null and pv.is_active = true and pr.status = 'active'
      )`,
      hasStock: sql<boolean>`exists (
        select 1 from product_variants pv join stock_levels sl on sl.product_variant_id = pv.id
        where pv.product_id = ${products.id} and pv.deleted_at is null and pv.is_active = true and sl.on_hand - sl.reserved > 0
      )`,
      imagePath: sql<string | null>`(
        select pi.storage_path from product_images pi where pi.product_id = ${products.id}
        order by pi.sort_order asc, pi.created_at asc limit 1
      )`,
    })
    .from(dropProducts)
    .innerJoin(products, eq(products.id, dropProducts.productId))
    .where(eq(dropProducts.dropId, dropId))
    .orderBy(asc(products.name));
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    hasActivePrice: Boolean(row.hasActivePrice),
    hasStock: Boolean(row.hasStock),
    hasPhoto: row.imagePath !== null,
    imagePath: row.imagePath,
  }));
}

async function inviteCounts(db: DbOrTx, dropId: string): Promise<DropView["invites"]> {
  const [row] = await db
    .select({
      total: sql<string>`count(*)`,
      sent: sql<string>`count(${dropInvites.sentAt})`,
      visited: sql<string>`count(${dropInvites.firstVisitAt})`,
    })
    .from(dropInvites)
    .where(eq(dropInvites.dropId, dropId));
  return { total: Number(row?.total ?? 0), sent: Number(row?.sent ?? 0), visited: Number(row?.visited ?? 0) };
}

async function waitlistCounts(db: DbOrTx, dropId: string): Promise<DropView["waitlist"]> {
  const [row] = await db
    .select({ total: sql<string>`count(*)`, notified: sql<string>`count(${dropWaitlist.notifiedAt})` })
    .from(dropWaitlist)
    .where(eq(dropWaitlist.dropId, dropId));
  return { total: Number(row?.total ?? 0), notified: Number(row?.notified ?? 0) };
}

function toView(
  row: typeof drops.$inferSelect,
  productsView: DropProductView[],
  invites: DropView["invites"],
  waitlist: DropView["waitlist"],
  now: Date,
): DropView {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    phase: dropPhase(row, now),
    publishAt: row.publishAt,
    vipStartsAt: vipStartsAt(row.publishAt, row.vipWindowHours),
    vipWindowHours: row.vipWindowHours,
    audienceLimit: row.audienceLimit,
    messageOverride: row.messageOverride,
    vipSentAt: row.vipSentAt,
    publishedAt: row.publishedAt,
    canceledAt: row.canceledAt,
    createdAt: row.createdAt,
    products: productsView,
    invites,
    waitlist,
  };
}

export async function getDrop(db: DbOrTx, dropId: string, now = new Date()): Promise<DropView | null> {
  const [row] = await db.select().from(drops).where(eq(drops.id, dropId)).limit(1);
  if (!row) return null;
  const [productsView, invites, waitlist] = await Promise.all([loadDropProducts(db, dropId), inviteCounts(db, dropId), waitlistCounts(db, dropId)]);
  return toView(row, productsView, invites, waitlist, now);
}

export async function listDrops(db: DbOrTx, now = new Date()): Promise<DropView[]> {
  const rows = await db.select().from(drops).orderBy(desc(drops.publishAt)).limit(50);
  const views: DropView[] = [];
  for (const row of rows) {
    const [productsView, invites, waitlist] = await Promise.all([loadDropProducts(db, row.id), inviteCounts(db, row.id), waitlistCounts(db, row.id)]);
    views.push(toView(row, productsView, invites, waitlist, now));
  }
  return views;
}

// ---------------------------------------------------------------------------
// /estreia — a próxima estreia pública (ou a que acabou de abrir)
// ---------------------------------------------------------------------------

export interface DropTeaser {
  dropId: string;
  name: string;
  publishAt: Date;
  state: Exclude<TeaserState, "hidden">;
  /** Peças do lançamento com a primeira foto (silhuetas no teaser; fotos na abertura). */
  products: { id: string; name: string; slug: string; imagePath: string | null }[];
  waitlist: { total: number };
}

/**
 * O que /estreia mostra agora: a estreia que abriu há menos de um dia (open)
 * tem prioridade — é para lá que o aviso "a cortina abriu" manda; senão a
 * agendada mais próxima (teaser). null = nada em cartaz.
 */
export async function getUpcomingDropTeaser(db: DbOrTx, now = new Date()): Promise<DropTeaser | null> {
  const since = new Date(now.getTime() - TEASER_OPEN_GRACE_MS);
  const [justOpened] = await db
    .select()
    .from(drops)
    .where(and(inArray(drops.status, ["scheduled", "vip_sent", "published"]), gt(drops.publishAt, since), lte(drops.publishAt, now)))
    .orderBy(desc(drops.publishAt))
    .limit(1);
  const [upcoming] = justOpened
    ? []
    : await db
        .select()
        .from(drops)
        .where(and(inArray(drops.status, ["scheduled", "vip_sent"]), gt(drops.publishAt, now)))
        .orderBy(asc(drops.publishAt))
        .limit(1);
  const row = justOpened ?? upcoming;
  if (!row) return null;
  const state = teaserState(row, now);
  if (state === "hidden") return null;
  const [productsView, waitlist] = await Promise.all([loadDropProducts(db, row.id), waitlistCounts(db, row.id)]);
  return {
    dropId: row.id,
    name: row.name,
    publishAt: row.publishAt,
    state,
    products: productsView.map((p) => ({ id: p.id, name: p.name, slug: p.slug, imagePath: p.imagePath })),
    waitlist: { total: waitlist.total },
  };
}

// ---------------------------------------------------------------------------
// createDrop / updateDrop / setDropProducts / cancelDrop
// ---------------------------------------------------------------------------

async function audienceLimitDefault(db: DbOrTx): Promise<number> {
  const map = await getSettingsMap(db, ["drop_audience_limit"]);
  const value = Number(map["drop_audience_limit"]);
  return Number.isFinite(value) && value >= 1 ? Math.min(value, 500) : 60;
}

const createSchema = z.object({
  name: z.string().trim().min(2, "Dê um nome ao lançamento.").max(80),
  publishAt: z.date(),
  vipWindowHours: z.number().int().min(1).max(168).default(24),
  audienceLimit: z.number().int().min(1).max(500).optional(),
  messageOverride: z.string().trim().max(600).optional(),
  userId: z.uuid(),
});

export type CreateDropInput = z.input<typeof createSchema>;

export async function createDrop(db: DbOrTx, input: CreateDropInput): Promise<{ dropId: string }> {
  const parsed = createSchema.parse(input);
  const [row] = await db
    .insert(drops)
    .values({
      name: parsed.name,
      publishAt: parsed.publishAt,
      vipWindowHours: parsed.vipWindowHours,
      audienceLimit: parsed.audienceLimit ?? (await audienceLimitDefault(db)),
      messageOverride: parsed.messageOverride || null,
      createdBy: parsed.userId,
    })
    .returning({ id: drops.id });
  await db.insert(auditLog).values({
    actorType: "user",
    actorId: parsed.userId,
    action: "drop.create",
    entityType: "drop",
    entityId: row.id,
    after: { name: parsed.name, publishAt: parsed.publishAt.toISOString(), vipWindowHours: parsed.vipWindowHours },
  });
  return { dropId: row.id };
}

const updateSchema = z.object({
  dropId: z.uuid(),
  name: z.string().trim().min(2).max(80).optional(),
  publishAt: z.date().optional(),
  vipWindowHours: z.number().int().min(1).max(168).optional(),
  audienceLimit: z.number().int().min(1).max(500).optional(),
  messageOverride: z.string().trim().max(600).nullable().optional(),
  userId: z.uuid(),
});

export type UpdateDropInput = z.input<typeof updateSchema>;

/** Rascunho aceita tudo; agendado só nome e mensagem (o resto já virou convite). */
export async function updateDrop(db: DbOrTx, input: UpdateDropInput): Promise<void> {
  const parsed = updateSchema.parse(input);
  const [row] = await db.select({ status: drops.status }).from(drops).where(eq(drops.id, parsed.dropId)).limit(1);
  if (!row) throw new ServiceError("lancamento_inexistente", "Lançamento não encontrado.");
  const editable = row.status === "draft";
  if (!editable && row.status !== "scheduled") {
    throw new ServiceError("lancamento_fechado", "Este lançamento já saiu — não dá mais para editar.");
  }
  if (!editable && (parsed.publishAt || parsed.vipWindowHours || parsed.audienceLimit)) {
    throw new ServiceError("lancamento_agendado", "Lançamento agendado: cancele para mudar data, janela ou público.");
  }
  await db
    .update(drops)
    .set({
      ...(parsed.name !== undefined ? { name: parsed.name } : {}),
      ...(parsed.publishAt !== undefined ? { publishAt: parsed.publishAt } : {}),
      ...(parsed.vipWindowHours !== undefined ? { vipWindowHours: parsed.vipWindowHours } : {}),
      ...(parsed.audienceLimit !== undefined ? { audienceLimit: parsed.audienceLimit } : {}),
      ...(parsed.messageOverride !== undefined ? { messageOverride: parsed.messageOverride || null } : {}),
      updatedAt: new Date(),
    })
    .where(eq(drops.id, parsed.dropId));
}

export async function setDropProducts(
  db: DbOrTx,
  input: { dropId: string; productIds: string[]; userId: string },
): Promise<void> {
  const productIds = [...new Set(input.productIds)];
  if (productIds.length > DROP_MAX_PRODUCTS) {
    throw new ServiceError("muitas_pecas", `No máximo ${DROP_MAX_PRODUCTS} peças por lançamento.`);
  }
  const [row] = await db.select({ status: drops.status }).from(drops).where(eq(drops.id, input.dropId)).limit(1);
  if (!row) throw new ServiceError("lancamento_inexistente", "Lançamento não encontrado.");
  if (row.status !== "draft") throw new ServiceError("lancamento_agendado", "Cancele o agendamento para mudar as peças.");
  await db.transaction(async (tx) => {
    await tx.delete(dropProducts).where(eq(dropProducts.dropId, input.dropId));
    if (productIds.length > 0) {
      await tx.insert(dropProducts).values(productIds.map((productId) => ({ dropId: input.dropId, productId })));
    }
    await tx.update(drops).set({ updatedAt: new Date() }).where(eq(drops.id, input.dropId));
  });
}

export async function cancelDrop(db: DbOrTx, input: { dropId: string; userId: string }): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx.select().from(drops).where(eq(drops.id, input.dropId)).for("update").limit(1);
    if (!row) throw new ServiceError("lancamento_inexistente", "Lançamento não encontrado.");
    if (row.status === "published" || row.status === "canceled") {
      throw new ServiceError("lancamento_fechado", "Este lançamento já foi publicado ou cancelado.");
    }
    const now = new Date();
    await tx.update(drops).set({ status: "canceled", canceledAt: now, updatedAt: now }).where(eq(drops.id, row.id));
    // As peças deixam de ficar escondidas (o dono decide arquivar ou não).
    const ids = (await tx.select({ id: dropProducts.productId }).from(dropProducts).where(eq(dropProducts.dropId, row.id))).map((p) => p.id);
    if (ids.length > 0) {
      await tx.update(products).set({ visibleFrom: null, updatedAt: now }).where(inArray(products.id, ids));
      // Sem a data, a peça ativa aparece na loja agora: o post nasce pronto.
      for (const productId of ids) {
        await enqueueProductPublished(tx, { productId, dedupeSuffix: `drop-cancel:${row.id}` });
      }
    }
    await tx.insert(auditLog).values({
      actorType: "user",
      actorId: input.userId,
      action: "drop.cancel",
      entityType: "drop",
      entityId: row.id,
      before: { status: row.status },
      after: { status: "canceled" },
    });
  });
}

// ---------------------------------------------------------------------------
// Público
// ---------------------------------------------------------------------------

async function loadAffinityProducts(db: DbOrTx, dropId: string): Promise<DropAffinityProduct[]> {
  const rows = await db
    .select({
      id: products.id,
      name: products.name,
      categoryId: products.categoryId,
      categoryName: sql<string | null>`(select c.name from categories c where c.id = ${products.categoryId})`,
      color: sql<string | null>`${productVariants.attributes} ->> 'cor'`,
      size: sql<string | null>`${productVariants.attributes} ->> 'tamanho'`,
      available: sql<string>`coalesce(${stockLevels.onHand}, 0) - coalesce(${stockLevels.reserved}, 0)`,
    })
    .from(dropProducts)
    .innerJoin(products, eq(products.id, dropProducts.productId))
    .leftJoin(productVariants, and(eq(productVariants.productId, products.id), isNull(productVariants.deletedAt), eq(productVariants.isActive, true)))
    .leftJoin(stockLevels, eq(stockLevels.productVariantId, productVariants.id))
    .where(eq(dropProducts.dropId, dropId));
  const map = new Map<string, DropAffinityProduct & { sizes: Set<string>; colors: Set<string> }>();
  for (const row of rows) {
    const entry =
      map.get(row.id) ??
      map.set(row.id, { id: row.id, name: row.name, categoryId: row.categoryId, categoryName: row.categoryName, sizesAvailable: [], colorsAvailable: [], sizes: new Set(), colors: new Set() }).get(row.id)!;
    if (Number(row.available) > 0) {
      if (row.size) entry.sizes.add(row.size);
      if (row.color) entry.colors.add(row.color);
    }
  }
  return [...map.values()].map(({ sizes, colors, ...rest }) => ({ ...rest, sizesAvailable: [...sizes], colorsAvailable: [...colors] }));
}

async function loadAudienceCandidates(db: DbOrTx): Promise<AudienceCandidate[]> {
  const people = await db
    .select({ id: customers.id, fullName: customers.fullName, phoneE164: customers.phoneE164 })
    .from(customers)
    .where(and(eq(customers.marketingOptIn, true), isNull(customers.deletedAt), sql`${customers.phoneE164} is not null`));
  if (people.length === 0) return [];
  const ids = people.map((p) => p.id);
  const phones = people.map((p) => p.phoneE164).filter((p): p is string => Boolean(p));

  const profiles = await db
    .select({ customerId: customerProfiles.customerId, phoneE164: customerProfiles.phoneE164, profile: customerProfiles.profile })
    .from(customerProfiles)
    .where(
      and(
        isNull(customerProfiles.forgottenAt),
        phones.length > 0
          ? or(inArray(customerProfiles.customerId, ids), inArray(customerProfiles.phoneE164, phones))
          : inArray(customerProfiles.customerId, ids),
      ),
    );
  const profileByCustomer = new Map<string, unknown>();
  const profileByPhone = new Map<string, unknown>();
  for (const row of profiles) {
    if (row.customerId) profileByCustomer.set(row.customerId, row.profile);
    profileByPhone.set(row.phoneE164, row.profile);
  }

  const purchases = await db
    .select({ customerId: orders.customerId, categoryId: products.categoryId })
    .from(orders)
    .innerJoin(orderItems, eq(orderItems.orderId, orders.id))
    .innerJoin(productVariants, eq(productVariants.id, orderItems.productVariantId))
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(and(inArray(orders.customerId, ids), inArray(orders.status, [...PAID_STATUSES])));
  const categoriesByCustomer = new Map<string, Set<string>>();
  for (const row of purchases) {
    if (!row.categoryId) continue;
    (categoriesByCustomer.get(row.customerId) ?? categoriesByCustomer.set(row.customerId, new Set()).get(row.customerId))!.add(row.categoryId);
  }

  return people.map((person) => {
    const raw = profileByCustomer.get(person.id) ?? (person.phoneE164 ? profileByPhone.get(person.phoneE164) : undefined);
    const parsed = raw ? styleProfileSchema.safeParse(raw) : null;
    return {
      customerId: person.id,
      phoneE164: person.phoneE164 as string,
      fullName: person.fullName,
      profile: parsed?.success ? parsed.data : null,
      purchasedCategoryIds: [...(categoriesByCustomer.get(person.id) ?? [])],
    };
  });
}

export interface AudiencePreview {
  eligible: number;
  limit: number;
  sample: RankedInvite[];
}

export async function previewDropAudience(db: DbOrTx, dropId: string): Promise<AudiencePreview> {
  const [row] = await db.select({ audienceLimit: drops.audienceLimit }).from(drops).where(eq(drops.id, dropId)).limit(1);
  if (!row) throw new ServiceError("lancamento_inexistente", "Lançamento não encontrado.");
  const [productsFacts, candidates] = await Promise.all([loadAffinityProducts(db, dropId), loadAudienceCandidates(db)]);
  const all = rankAudience(candidates, productsFacts, Number.MAX_SAFE_INTEGER);
  return { eligible: all.length, limit: row.audienceLimit, sample: all.slice(0, 10) };
}

// ---------------------------------------------------------------------------
// scheduleDrop
// ---------------------------------------------------------------------------

export async function scheduleDrop(
  db: DbOrTx,
  input: { dropId: string; userId: string; now?: Date },
): Promise<{ invites: number }> {
  const now = input.now ?? new Date();
  const view = await getDrop(db, input.dropId, now);
  if (!view) throw new ServiceError("lancamento_inexistente", "Lançamento não encontrado.");
  if (view.status !== "draft") throw new ServiceError("lancamento_agendado", "Este lançamento já foi agendado.");
  const check = canSchedule({ publishAt: view.publishAt, vipWindowHours: view.vipWindowHours, products: view.products }, now);
  if (!check.ok) throw new ServiceError("nao_pode_agendar", check.problems.join(" "));

  const [productsFacts, candidates] = await Promise.all([loadAffinityProducts(db, input.dropId), loadAudienceCandidates(db)]);
  const ranked = rankAudience(candidates, productsFacts, view.audienceLimit);

  return db.transaction(async (tx) => {
    const ids = view.products.map((p) => p.id);
    // Peça em rascunho vira ativa, mas escondida até a publicação.
    await tx
      .update(products)
      .set({ status: "active", visibleFrom: view.publishAt, updatedAt: now })
      .where(and(inArray(products.id, ids), inArray(products.status, ["draft", "active"])));
    // O desenho do post fica marcado para a hora da estreia (mesma chave que
    // o handler usa ao reagendar: os dois caminhos se deduplicam).
    for (const productId of ids) {
      await enqueueProductPublished(tx, {
        productId,
        dedupeSuffix: `visible:${view.publishAt.getTime()}`,
        nextAttemptAt: view.publishAt,
      });
    }
    await tx.delete(dropInvites).where(eq(dropInvites.dropId, input.dropId));
    if (ranked.length > 0) {
      await tx.insert(dropInvites).values(
        ranked.map((invite) => ({
          dropId: input.dropId,
          customerId: invite.customerId,
          phoneE164: invite.phoneE164,
          score: invite.score,
          reasons: invite.reasons,
        })),
      );
    }
    await tx.update(drops).set({ status: "scheduled", updatedAt: now }).where(eq(drops.id, input.dropId));
    await tx.insert(auditLog).values({
      actorType: "user",
      actorId: input.userId,
      action: "drop.schedule",
      entityType: "drop",
      entityId: input.dropId,
      after: { publishAt: view.publishAt.toISOString(), vipWindowHours: view.vipWindowHours, invites: ranked.length, products: ids },
    });
    return { invites: ranked.length };
  });
}

// ---------------------------------------------------------------------------
// Cron: dispatchDueDrops → dispatchDropVip / publishDrop
// ---------------------------------------------------------------------------

/** Um evento por convidada, escalonado a partir da abertura da janela. */
export async function dispatchDropVip(db: DbOrTx, input: { dropId: string; now?: Date }): Promise<{ queued: number }> {
  const now = input.now ?? new Date();
  const pending = await db
    .select({ id: dropInvites.id, customerId: dropInvites.customerId })
    .from(dropInvites)
    .where(and(eq(dropInvites.dropId, input.dropId), isNull(dropInvites.sentAt)))
    .orderBy(desc(dropInvites.score), asc(dropInvites.createdAt));
  const policy = await loadSendPolicy(db);
  // A fila não atravessa o fim da janela (a cauda segue amanhã às 9h no mesmo passo).
  const schedule = staggerWithinWindow(pending.length, { from: now, intervalSeconds: policy.intervalSeconds, window: policy.window });
  let queued = 0;
  for (const [index, invite] of pending.entries()) {
    const id = await enqueueOutboxEvent(db, {
      eventType: "wa.drop_invite",
      dedupeKey: `wa.drop:${input.dropId}:${invite.customerId}`,
      aggregateType: "drop",
      aggregateId: input.dropId,
      payload: { inviteId: invite.id, dropId: input.dropId },
      nextAttemptAt: schedule[index],
    });
    if (id) queued += 1;
  }
  await db.update(drops).set({ status: "vip_sent", vipSentAt: now, updatedAt: now }).where(eq(drops.id, input.dropId));
  return { queued };
}

export async function publishDrop(db: DbOrTx, input: { dropId: string; now?: Date }): Promise<void> {
  const now = input.now ?? new Date();
  await db.transaction(async (tx) => {
    const published = await tx
      .update(drops)
      .set({ status: "published", publishedAt: now, updatedAt: now })
      .where(and(eq(drops.id, input.dropId), inArray(drops.status, ["scheduled", "vip_sent"])))
      .returning({ id: drops.id });
    if (published.length === 0) return;
    // As peças acabam de aparecer na loja: post, story e carrossel prontos
    // para a estreia (uma vez por lançamento; retry nunca duplica).
    const ids = (await tx.select({ id: dropProducts.productId }).from(dropProducts).where(eq(dropProducts.dropId, input.dropId))).map((p) => p.id);
    for (const productId of ids) {
      await enqueueProductPublished(tx, { productId, dedupeSuffix: `drop:${input.dropId}` });
    }
    // A cortina abriu: quem pediu aviso em /estreia recebe (fan-out no handler,
    // dentro da janela de envio). Na MESMA transação — regra 5.
    await enqueueOutboxEvent(tx, {
      eventType: "drop.published",
      dedupeKey: `drop.published:${input.dropId}`,
      aggregateType: "drop",
      aggregateId: input.dropId,
      payload: { dropId: input.dropId },
    });
  });
}

export async function dispatchDueDrops(db: DbOrTx, input: { now?: Date } = {}): Promise<{ vipQueued: number; published: number }> {
  const now = input.now ?? new Date();
  let vipQueued = 0;
  let published = 0;
  const due = await db
    .select()
    .from(drops)
    .where(and(inArray(drops.status, ["scheduled", "vip_sent"]), lte(sql`${drops.publishAt} - make_interval(hours => ${drops.vipWindowHours})`, now)))
    .orderBy(asc(drops.publishAt));
  for (const row of due) {
    if (row.publishAt.getTime() <= now.getTime()) {
      await publishDrop(db, { dropId: row.id, now });
      published += 1;
      continue;
    }
    if (row.status === "scheduled" && row.vipSentAt === null) {
      const result = await dispatchDropVip(db, { dropId: row.id, now });
      vipQueued += result.queued;
    }
  }
  return { vipQueued, published };
}

// ---------------------------------------------------------------------------
// sendDropInvite — handler de wa.drop_invite
// ---------------------------------------------------------------------------

export type SendDropInviteResult =
  | SendWaMessageResult
  | { skipped: "inexistente" | "fora_da_fase_vip" | "fora_da_janela" | "sem_template" };

function firstName(fullName: string | null | undefined): string {
  return (fullName ?? "").trim().split(/\s+/)[0] ?? "";
}

export async function sendDropInvite(
  db: DbOrTx,
  provider: MessagingProvider,
  input: { inviteId: string; now?: Date },
): Promise<SendDropInviteResult> {
  const now = input.now ?? new Date();
  const [row] = await db
    .select({
      invite: dropInvites,
      drop: drops,
      customerName: customers.fullName,
      marketingOptIn: customers.marketingOptIn,
    })
    .from(dropInvites)
    .innerJoin(drops, eq(drops.id, dropInvites.dropId))
    .innerJoin(customers, eq(customers.id, dropInvites.customerId))
    .where(eq(dropInvites.id, input.inviteId))
    .limit(1);
  if (!row) return { skipped: "inexistente" };
  if (row.invite.sentAt) return { skipped: "ja_enviado" };
  if (dropPhase(row.drop, now) !== "vip") return { skipped: "fora_da_fase_vip" };
  if (!(await isWaEnabled(db))) return { skipped: "desabilitado" };
  if (!row.marketingOptIn) return { skipped: "sem_opt_in" };

  const policy = await loadSendPolicy(db);
  if (!isWithinSendWindow(now, policy.window)) {
    await enqueueOutboxEvent(db, {
      eventType: "wa.drop_invite",
      dedupeKey: `wa.drop:${row.drop.id}:${row.invite.customerId}:${spDayKey(now)}`,
      aggregateType: "drop",
      aggregateId: row.drop.id,
      payload: { inviteId: row.invite.id, dropId: row.drop.id },
      nextAttemptAt: nextSendWindowStart(now, policy.window),
    });
    return { skipped: "fora_da_janela" };
  }

  const productsView = await loadDropProducts(db, row.drop.id);
  const vars = {
    nome: firstName(row.customerName),
    lancamento: row.drop.name,
    pecas: productsView.map((p) => p.name).join(", "),
    prazo: formatDropMoment(row.drop.publishAt),
    link: `${siteUrl()}/lancamento/${row.invite.token}`,
  };
  let body: string;
  if (row.drop.messageOverride) {
    body = renderTemplate(row.drop.messageOverride, vars);
  } else {
    const [template] = await db
      .select({ bodyTemplate: waTemplates.bodyTemplate, isActive: waTemplates.isActive })
      .from(waTemplates)
      .where(eq(waTemplates.key, DROP_INVITE_TEMPLATE_KEY))
      .limit(1);
    if (!template || !template.isActive) return { skipped: "sem_template" };
    body = renderTemplate(template.bodyTemplate, vars);
  }

  let imageUrl: string | null = null;
  const withPhoto = productsView.find((p) => p.imagePath);
  if (withPhoto?.imagePath) {
    try {
      imageUrl = publicImageUrl(withPhoto.imagePath);
    } catch {
      imageUrl = null;
    }
  }
  const common = {
    phoneE164: row.invite.phoneE164,
    customerId: row.invite.customerId,
    dedupeKey: `wa.drop_invite:${row.invite.id}`,
    requireOptIn: true,
  };
  const result: SendWaMessageResult = imageUrl
    ? await sendMediaMessage(db, provider, { kind: "image", imageUrl, body, ...common })
    : await sendTemplateMessage(db, provider, { bodyOverride: body, vars: {}, ...common });
  if ("sent" in result) {
    await db.update(dropInvites).set({ sentAt: now, waMessageId: result.waMessageId }).where(eq(dropInvites.id, row.invite.id));
  } else if (result.skipped === "ja_enviado") {
    await db.update(dropInvites).set({ sentAt: now }).where(and(eq(dropInvites.id, row.invite.id), isNull(dropInvites.sentAt)));
  }
  return result;
}

// ---------------------------------------------------------------------------
// Vitrine: token da convidada
// ---------------------------------------------------------------------------

export interface DropForToken {
  drop: { id: string; name: string; publishAt: Date; phase: DropPhase; vipStartsAt: Date };
  invite: { id: string; firstName: string };
  products: PublicProductListItem[];
}

export async function getDropForToken(db: DbOrTx, token: string, now = new Date()): Promise<DropForToken | null> {
  if (!z.uuid().safeParse(token).success) return null;
  const [row] = await db
    .select({ invite: dropInvites, drop: drops, customerName: customers.fullName })
    .from(dropInvites)
    .innerJoin(drops, eq(drops.id, dropInvites.dropId))
    .innerJoin(customers, eq(customers.id, dropInvites.customerId))
    .where(eq(dropInvites.token, token))
    .limit(1);
  if (!row) return null;
  const phase = dropPhase(row.drop, now);
  const ids = (await db.select({ id: dropProducts.productId }).from(dropProducts).where(eq(dropProducts.dropId, row.drop.id))).map((p) => p.id);
  const productsList = ids.length > 0 ? await listPublicProducts(db, { productIds: ids, includeHidden: true, limit: DROP_MAX_PRODUCTS }) : [];
  return {
    drop: { id: row.drop.id, name: row.drop.name, publishAt: row.drop.publishAt, phase, vipStartsAt: vipStartsAt(row.drop.publishAt, row.drop.vipWindowHours) },
    invite: { id: row.invite.id, firstName: firstName(row.customerName) },
    products: productsList,
  };
}

export async function recordDropVisit(db: DbOrTx, token: string, now = new Date()): Promise<void> {
  if (!z.uuid().safeParse(token).success) return;
  await db
    .update(dropInvites)
    .set({ firstVisitAt: now })
    .where(and(eq(dropInvites.token, token), isNull(dropInvites.firstVisitAt)));
}

// ---------------------------------------------------------------------------
// Relatório
// ---------------------------------------------------------------------------

export interface DropReport {
  invites: number;
  sent: number;
  visited: number;
  orders: number;
  revenueCents: number;
  rows: { customerId: string; fullName: string; score: number; reasons: string[]; sentAt: Date | null; firstVisitAt: Date | null }[];
}

export async function getDropReport(db: DbOrTx, dropId: string): Promise<DropReport> {
  const [drop] = await db.select().from(drops).where(eq(drops.id, dropId)).limit(1);
  if (!drop) throw new ServiceError("lancamento_inexistente", "Lançamento não encontrado.");
  const rows = await db
    .select({
      customerId: dropInvites.customerId,
      fullName: customers.fullName,
      score: dropInvites.score,
      reasons: dropInvites.reasons,
      sentAt: dropInvites.sentAt,
      firstVisitAt: dropInvites.firstVisitAt,
    })
    .from(dropInvites)
    .innerJoin(customers, eq(customers.id, dropInvites.customerId))
    .where(eq(dropInvites.dropId, dropId))
    .orderBy(desc(dropInvites.score), asc(customers.fullName));
  const from = vipStartsAt(drop.publishAt, drop.vipWindowHours);
  const to = new Date(drop.publishAt.getTime() + REPORT_WINDOW_MS);
  const customerIds = rows.map((r) => r.customerId);
  let ordersCount = 0;
  let revenueCents = 0;
  if (customerIds.length > 0) {
    const [agg] = await db
      .select({ count: sql<string>`count(*)`, total: sql<string>`coalesce(sum(${orders.totalCents}), 0)` })
      .from(orders)
      .where(
        and(
          inArray(orders.customerId, customerIds),
          gte(orders.createdAt, from),
          lte(orders.createdAt, to),
          inArray(orders.status, ["pending_payment", ...PAID_STATUSES]),
        ),
      );
    ordersCount = Number(agg?.count ?? 0);
    revenueCents = Number(agg?.total ?? 0);
  }
  return {
    invites: rows.length,
    sent: rows.filter((r) => r.sentAt).length,
    visited: rows.filter((r) => r.firstVisitAt).length,
    orders: ordersCount,
    revenueCents,
    rows: rows.map((r) => ({ ...r, reasons: Array.isArray(r.reasons) ? (r.reasons as string[]) : [] })),
  };
}
