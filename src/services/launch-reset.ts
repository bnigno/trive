// Limpeza pré-inauguração: apaga de produção conversas, clientes e pedidos
// de teste (com tudo que pendura neles), recalcula o estoque só a partir do
// livro que sobra e reinicia a numeração — numa única transação, ou tudo
// ou nada. As regras (ordem, gatilhos, o que da fila/auditoria fica, baldes
// do estoque, peças de teste, arquivos) moram em core/maintenance/launch-reset.
// Nada de rede dentro da transação: os arquivos do bucket saem depois do
// commit (o script cuida), e a vitrine é avisada pela fila.
import { and, count, desc, eq, gt, inArray, isNotNull, isNull, like, lt, ne, notInArray, or, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";

import {
  FIRST_REAL_ORDER_NUMBER,
  GUARD_TRIGGERS,
  INBOUND_ZAPI_KEEP_HOURS,
  KEPT_AUDIT_ACTIONS,
  LEDGER_REFERENCE_TYPES_TO_DROP,
  LOCKED_TABLES,
  ON_HAND_MOVEMENT_TYPES,
  ORDER_NUMBER_SEQUENCE,
  OUTBOX_FINISHED_STATUSES,
  RESERVED_MOVEMENT_TYPES,
  WIPED_AUDIT_ACTIONS,
  WIPED_AUDIT_ENTITY_TYPES,
  WIPED_OUTBOX_AGGREGATES,
  WIPE_STEPS,
  LaunchResetInvariantError,
  assertLevelInvariants,
  intakeStoragePaths,
  isTestProduct,
  isTestShippingRate,
  lookStoragePaths,
  orderStoragePaths,
  recomputeLevels,
  triggerToggleSql,
  watchdogSilenceRows,
  type LedgerSum,
  type WipeStep,
} from "@/core/maintenance/launch-reset";
import type { MovementType } from "@/core/stock/ledger";
import type { Db } from "@/db/client";
import * as schema from "@/db/schema";
import { maskPhone } from "@/lib/phone";
import { enqueueOutboxEvent, kickOutbox, type DbOrTx } from "@/queue/enqueue";
import { debutLetterStoragePath, editionCardStoragePath } from "@/services/edition-cards";
import { ServiceError } from "@/services/settings";

const NAMING = { card: editionCardStoragePath, letter: debutLetterStoragePath };
const REVALIDATE_PATHS_PER_EVENT = 10;

export interface SkuLevelChange {
  sku: string;
  productName: string;
  before: { onHand: number; reserved: number };
  after: { onHand: number; reserved: number };
}

export interface LaunchResetPlan {
  counts: Record<WipeStep, number>;
  conversations: {
    name: string | null;
    phone: string;
    status: string;
    lastInboundAt: Date | null;
  }[];
  customers: {
    name: string;
    phone: string | null;
    marketingOptIn: boolean;
    createdAt: Date;
  }[];
  outbox: {
    total: number;
    toDelete: number;
    toKeep: number;
    processing: number;
  };
  inbound: {
    zapiToDelete: number;
    zapiToKeep: number;
    mercadopago: number;
    email: number;
  };
  audit: { toDelete: number; toKeep: number };
  stock: {
    movementsToDelete: number;
    /** Só as variantes cujo saldo muda. */
    levels: SkuLevelChange[];
    /** stock_levels que já não batia com o livro inteiro ANTES da limpeza. */
    preDivergences: {
      sku: string;
      level: { onHand: number; reserved: number };
      ledger: { onHand: number; reserved: number };
    }[];
    /** Ajustes e perdas lançados à mão — se algum "consertou" uma baixa de teste, o saldo recalculado fica errado. */
    manualMovements: {
      sku: string;
      type: MovementType;
      quantityDelta: number;
      note: string | null;
      createdAt: Date;
    }[];
    /** Saldos que o recálculo produziria inválidos (reservado ≠ 0 ou em mãos < 0): o apply vai recusar. */
    invalid: { sku: string; onHand: number; reserved: number }[];
  };
  coupons: { code: string; usedCount: number }[];
  products: {
    id: string;
    name: string;
    slug: string;
    status: string;
    skus: string[];
    linkedTo: string[];
  }[];
  shippingRates: {
    id: string;
    name: string;
    priceCents: number;
    isActive: boolean;
  }[];
  /** Compras (contas a pagar de fornecedor) não têm pedido e FICAM — só para a dona conferir se são de teste. */
  supplierEntries: {
    description: string;
    amountCents: number;
    status: string;
    createdAt: Date;
  }[];
  scheduledDropsWithInvites: {
    name: string;
    publishAt: Date;
    invites: number;
  }[];
  storagePaths: string[];
  orderNumbers: { maxOrderNumber: number | null; nextAfterReset: number };
}

export interface LaunchResetReport {
  plan: LaunchResetPlan;
  deleted: Record<WipeStep, number>;
  levelsWritten: number;
  productsArchived: string[];
  variantsDeactivated: number;
  ratesDeleted: string[];
  couponsReset: number;
  watchdogSilenced: number;
  auditLogId: number;
  /** Pedidos de revalidação da vitrine enfileirados depois do commit; null = a fila falhou (o banco já está limpo). */
  revalidateEvents: number | null;
}

export const LAUNCH_RESET_AUDIT_ACTION = "maintenance.launch_reset";

// db.execute devolve { rows } no pg/PGlite e array no postgres.js.
const rowsOf = <T>(res: unknown): T[] => (Array.isArray(res) ? (res as T[]) : ((res as { rows?: T[] }).rows ?? []));

function emptyCounts(): Record<WipeStep, number> {
  return Object.fromEntries(WIPE_STEPS.map((step) => [step, 0])) as Record<WipeStep, number>;
}

function outboxDeleteWhere() {
  return or(
    inArray(schema.outboxEvents.status, [...OUTBOX_FINISHED_STATUSES]),
    inArray(schema.outboxEvents.aggregateType, [...WIPED_OUTBOX_AGGREGATES]),
    eq(schema.outboxEvents.eventType, "mp.payment_event"),
    and(like(schema.outboxEvents.eventType, "wa.%"), eq(schema.outboxEvents.aggregateType, "drop")),
  );
}

function inboundDeleteWhere(now: Date) {
  const cutoff = new Date(now.getTime() - INBOUND_ZAPI_KEEP_HOURS * 60 * 60_000);
  return and(eq(schema.inboundEvents.source, "zapi"), lt(schema.inboundEvents.receivedAt, cutoff));
}

function auditDeleteWhere(deletedEntryIds: readonly string[]) {
  const wipedEntity = inArray(schema.auditLog.entityType, [...WIPED_AUDIT_ENTITY_TYPES]);
  const wipedEntries =
    deletedEntryIds.length > 0 ? and(eq(schema.auditLog.entityType, "financial_entry"), inArray(schema.auditLog.entityId, [...deletedEntryIds])) : undefined;
  const wipedAction = inArray(schema.auditLog.action, [...WIPED_AUDIT_ACTIONS]);
  return and(or(wipedEntity, wipedAction, wipedEntries), notInArray(schema.auditLog.action, [...KEPT_AUDIT_ACTIONS]));
}

async function countRows(db: DbOrTx, table: PgTable, where?: SQL): Promise<number> {
  const [row] = await db.select({ n: count() }).from(table).where(where);
  return Number(row?.n ?? 0);
}

async function ledgerSums(db: DbOrTx, excludeDropped: boolean): Promise<LedgerSum[]> {
  const rows = await db
    .select({
      productVariantId: schema.stockMovements.productVariantId,
      type: schema.stockMovements.type,
      total: sql<number>`sum(${schema.stockMovements.quantityDelta})::int`,
    })
    .from(schema.stockMovements)
    .where(
      excludeDropped
        ? or(isNull(schema.stockMovements.referenceType), notInArray(schema.stockMovements.referenceType, [...LEDGER_REFERENCE_TYPES_TO_DROP]))
        : undefined,
    )
    .groupBy(schema.stockMovements.productVariantId, schema.stockMovements.type);
  return rows.map((row) => ({
    productVariantId: row.productVariantId,
    type: row.type as MovementType,
    total: Number(row.total),
  }));
}

async function variantLevels(db: DbOrTx) {
  return db
    .select({
      variantId: schema.stockLevels.productVariantId,
      onHand: schema.stockLevels.onHand,
      reserved: schema.stockLevels.reserved,
      sku: schema.productVariants.sku,
      productName: schema.products.name,
    })
    .from(schema.stockLevels)
    .innerJoin(schema.productVariants, eq(schema.productVariants.id, schema.stockLevels.productVariantId))
    .innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId));
}

async function testProducts(db: DbOrTx) {
  const rows = await db
    .select({
      id: schema.products.id,
      name: schema.products.name,
      slug: schema.products.slug,
      status: schema.products.status,
      sku: schema.productVariants.sku,
    })
    .from(schema.products)
    .leftJoin(schema.productVariants, eq(schema.productVariants.productId, schema.products.id))
    .where(and(ne(schema.products.status, "archived"), isNull(schema.products.deletedAt)));
  const byId = new Map<string, { id: string; name: string; slug: string; status: string; skus: string[] }>();
  for (const row of rows) {
    const entry = byId.get(row.id) ?? {
      id: row.id,
      name: row.name,
      slug: row.slug,
      status: row.status,
      skus: [],
    };
    if (row.sku) entry.skus.push(row.sku);
    byId.set(row.id, entry);
  }
  return [...byId.values()].filter(isTestProduct);
}

async function linkedTo(db: DbOrTx, productIds: readonly string[]): Promise<Map<string, string[]>> {
  const links = new Map<string, string[]>();
  if (productIds.length === 0) return links;
  const add = (id: string, label: string) => links.set(id, [...(links.get(id) ?? []), label]);
  // Uma consulta por vez: dentro da transação todas usam a mesma conexão.
  const inDrops = await db
    .select({
      productId: schema.dropProducts.productId,
      name: schema.drops.name,
    })
    .from(schema.dropProducts)
    .innerJoin(schema.drops, eq(schema.drops.id, schema.dropProducts.dropId))
    .where(inArray(schema.dropProducts.productId, [...productIds]));
  const inEditions = await db
    .select({
      productId: schema.cityEditionProducts.productId,
      name: schema.cityEditions.name,
    })
    .from(schema.cityEditionProducts)
    .innerJoin(schema.cityEditions, eq(schema.cityEditions.id, schema.cityEditionProducts.cityEditionId))
    .where(inArray(schema.cityEditionProducts.productId, [...productIds]));
  const inCampaigns = await db
    .select({
      productId: schema.campaignLinks.productId,
      slug: schema.campaignLinks.slug,
    })
    .from(schema.campaignLinks)
    .where(inArray(schema.campaignLinks.productId, [...productIds]));
  for (const row of inDrops) add(row.productId, `lançamento "${row.name}"`);
  for (const row of inEditions) add(row.productId, `edição "${row.name}"`);
  for (const row of inCampaigns) if (row.productId) add(row.productId, `link de story /${row.slug}`);
  return links;
}

async function collectStoragePaths(db: DbOrTx): Promise<string[]> {
  const orders = await db
    .select({
      id: schema.orders.id,
      receiptPath: schema.orders.receiptPath,
      packagePhotoPath: schema.orders.packagePhotoPath,
      deliveredPhotoPath: schema.orders.deliveredPhotoPath,
      giftNotePath: schema.orders.giftNotePath,
      editionCardsFingerprint: schema.orders.editionCardsFingerprint,
    })
    .from(schema.orders);
  const looks = await db
    .select({
      photoPath: schema.customerLooks.photoPath,
      cardPath: schema.customerLooks.cardPath,
    })
    .from(schema.customerLooks);
  const intakes = await db.select({ cardPath: schema.atelierIntakes.cardPath }).from(schema.atelierIntakes);
  const paths = new Set<string>();
  for (const order of orders) for (const path of orderStoragePaths(order, NAMING)) paths.add(path);
  for (const look of looks) for (const path of lookStoragePaths(look)) paths.add(path);
  for (const intake of intakes) for (const path of intakeStoragePaths(intake)) paths.add(path);
  return [...paths].sort();
}

async function collectPlan(db: DbOrTx, now: Date): Promise<LaunchResetPlan> {
  const total = (table: PgTable, where?: SQL) => countRows(db, table, where);
  const deletedEntryIds = await db.select({ id: schema.financialEntries.id }).from(schema.financialEntries).where(isNotNull(schema.financialEntries.orderId));
  const counts = await (async () => {
    const c = emptyCounts();
    c.atelier_intakes = await total(schema.atelierIntakes);
    c.wa_suggestions = await total(schema.waSuggestions);
    c.wa_followups = await total(schema.waFollowups);
    c.delivery_feedback = await total(schema.deliveryFeedback);
    c.customer_looks = await total(schema.customerLooks);
    c.stock_alerts = await total(schema.stockAlerts);
    c.stock_holds = await total(schema.stockHolds);
    c.site_carts = await total(schema.siteCarts);
    c.drop_waitlist = await total(schema.dropWaitlist);
    c.drop_invites = await total(schema.dropInvites);
    c.customer_profiles = await total(schema.customerProfiles);
    c.wa_messages = await total(schema.waMessages);
    c.wa_conversations = await total(schema.waConversations);
    c.delivery_positions = await total(schema.deliveryPositions);
    c.delivery_stops = await total(schema.deliveryStops);
    c.delivery_runs = await total(schema.deliveryRuns);
    c.financial_entries = await total(schema.financialEntries, isNotNull(schema.financialEntries.orderId));
    c.order_status_history = await total(schema.orderStatusHistory);
    c.order_items = await total(schema.orderItems);
    c.orders = await total(schema.orders);
    c.customer_addresses = await total(schema.customerAddresses);
    c.customers = await total(schema.customers);
    c.stock_movements = await total(schema.stockMovements, inArray(schema.stockMovements.referenceType, [...LEDGER_REFERENCE_TYPES_TO_DROP]));
    c.outbox_events = await total(schema.outboxEvents, outboxDeleteWhere());
    c.inbound_events = await total(schema.inboundEvents, inboundDeleteWhere(now));
    return c;
  })();
  counts.audit_log = await total(schema.auditLog, auditDeleteWhere(deletedEntryIds.map((r) => r.id)));

  const conversations = await db
    .select({
      phoneE164: schema.waConversations.phoneE164,
      status: schema.waConversations.status,
      botState: schema.waConversations.botState,
      lastInboundAt: schema.waConversations.lastInboundAt,
    })
    .from(schema.waConversations)
    .orderBy(desc(schema.waConversations.updatedAt));
  const customers = await db
    .select({
      name: schema.customers.fullName,
      phoneE164: schema.customers.phoneE164,
      marketingOptIn: schema.customers.marketingOptIn,
      createdAt: schema.customers.createdAt,
    })
    .from(schema.customers)
    .orderBy(desc(schema.customers.createdAt));

  const outboxTotal = await total(schema.outboxEvents);
  const outboxProcessing = await total(schema.outboxEvents, eq(schema.outboxEvents.status, "processing"));
  const zapiTotal = await total(schema.inboundEvents, eq(schema.inboundEvents.source, "zapi"));
  const auditTotal = await total(schema.auditLog);

  const levels = await variantLevels(db);
  const fullSums = await ledgerSums(db, false);
  const keptSums = await ledgerSums(db, true);
  const skuOf = new Map(levels.map((l) => [l.variantId, { sku: l.sku, productName: l.productName }]));
  const label = (variantId: string) => skuOf.get(variantId) ?? { sku: variantId, productName: "?" };
  const ledgerNow = new Map(
    recomputeLevels(
      fullSums,
      levels.map((l) => l.variantId),
    ).map((l) => [l.productVariantId, l]),
  );
  const ledgerAfter = new Map(
    recomputeLevels(
      keptSums,
      levels.map((l) => l.variantId),
    ).map((l) => [l.productVariantId, l]),
  );
  const preDivergences = levels
    .filter((l) => {
      const ledger = ledgerNow.get(l.variantId)!;
      return ledger.onHand !== l.onHand || ledger.reserved !== l.reserved;
    })
    .map((l) => ({
      sku: l.sku,
      level: { onHand: l.onHand, reserved: l.reserved },
      ledger: {
        onHand: ledgerNow.get(l.variantId)!.onHand,
        reserved: ledgerNow.get(l.variantId)!.reserved,
      },
    }));
  const levelChanges: SkuLevelChange[] = [...ledgerAfter.values()]
    .map((after) => {
      const current = levels.find((l) => l.variantId === after.productVariantId);
      const before = current ? { onHand: current.onHand, reserved: current.reserved } : { onHand: 0, reserved: 0 };
      return {
        ...label(after.productVariantId),
        before,
        after: { onHand: after.onHand, reserved: after.reserved },
      };
    })
    .filter((change) => change.before.onHand !== change.after.onHand || change.before.reserved !== change.after.reserved)
    .sort((a, b) => a.sku.localeCompare(b.sku));
  let invalid: LaunchResetPlan["stock"]["invalid"] = [];
  try {
    assertLevelInvariants([...ledgerAfter.values()], (id) => label(id).sku);
  } catch (error) {
    if (!(error instanceof LaunchResetInvariantError)) throw error;
    invalid = [...error.violations];
  }
  const manual = await db
    .select({
      variantId: schema.stockMovements.productVariantId,
      type: schema.stockMovements.type,
      quantityDelta: schema.stockMovements.quantityDelta,
      note: schema.stockMovements.note,
      createdAt: schema.stockMovements.createdAt,
    })
    .from(schema.stockMovements)
    .where(inArray(schema.stockMovements.type, ["adjustment", "loss"]))
    .orderBy(desc(schema.stockMovements.createdAt));

  const coupons = await db
    .select({ code: schema.coupons.code, usedCount: schema.coupons.usedCount })
    .from(schema.coupons)
    .where(gt(schema.coupons.usedCount, 0));
  const products = await testProducts(db);
  const links = await linkedTo(
    db,
    products.map((p) => p.id),
  );
  const rates = (await db.select().from(schema.shippingRates)).filter(isTestShippingRate);
  const supplierEntries = await db
    .select({
      description: schema.financialEntries.description,
      amountCents: schema.financialEntries.amountCents,
      status: schema.financialEntries.status,
      createdAt: schema.financialEntries.createdAt,
    })
    .from(schema.financialEntries)
    .where(isNull(schema.financialEntries.orderId))
    .orderBy(desc(schema.financialEntries.createdAt));
  const scheduledDrops = await db
    .select({
      name: schema.drops.name,
      publishAt: schema.drops.publishAt,
      invites: count(schema.dropInvites.id),
    })
    .from(schema.drops)
    .innerJoin(schema.dropInvites, eq(schema.dropInvites.dropId, schema.drops.id))
    .where(inArray(schema.drops.status, ["scheduled", "vip_sent"]))
    .groupBy(schema.drops.id, schema.drops.name, schema.drops.publishAt);
  const [maxOrder] = await db.select({ max: sql<number | null>`max(${schema.orders.orderNumber})::int` }).from(schema.orders);

  return {
    counts,
    conversations: conversations.map((c) => ({
      name: ((c.botState as { displayName?: string } | null)?.displayName ?? "").trim() || null,
      phone: maskPhone(c.phoneE164),
      status: c.status,
      lastInboundAt: c.lastInboundAt,
    })),
    customers: customers.map((c) => ({
      name: c.name,
      phone: c.phoneE164 ? maskPhone(c.phoneE164) : null,
      marketingOptIn: c.marketingOptIn,
      createdAt: c.createdAt,
    })),
    outbox: {
      total: outboxTotal,
      toDelete: counts.outbox_events,
      toKeep: outboxTotal - counts.outbox_events,
      processing: outboxProcessing,
    },
    inbound: {
      zapiToDelete: counts.inbound_events,
      zapiToKeep: zapiTotal - counts.inbound_events,
      mercadopago: await total(schema.inboundEvents, eq(schema.inboundEvents.source, "mercadopago")),
      email: await total(schema.inboundEvents, eq(schema.inboundEvents.source, "email")),
    },
    audit: {
      toDelete: counts.audit_log,
      toKeep: auditTotal - counts.audit_log,
    },
    stock: {
      movementsToDelete: counts.stock_movements,
      levels: levelChanges,
      preDivergences,
      manualMovements: manual.map((m) => ({
        sku: label(m.variantId).sku,
        type: m.type as MovementType,
        quantityDelta: m.quantityDelta,
        note: m.note,
        createdAt: m.createdAt,
      })),
      invalid,
    },
    coupons,
    products: products.map((p) => ({ ...p, linkedTo: links.get(p.id) ?? [] })),
    shippingRates: rates.map((r) => ({
      id: r.id,
      name: r.name,
      priceCents: r.priceCents,
      isActive: r.isActive,
    })),
    supplierEntries,
    scheduledDropsWithInvites: scheduledDrops.map((d) => ({
      name: d.name,
      publishAt: d.publishAt,
      invites: Number(d.invites),
    })),
    storagePaths: await collectStoragePaths(db),
    orderNumbers: {
      maxOrderNumber: maxOrder?.max == null ? null : Number(maxOrder.max),
      nextAfterReset: FIRST_REAL_ORDER_NUMBER,
    },
  };
}

/** Simulação: o que a limpeza faria, sem gravar nada. */
export async function planLaunchReset(db: DbOrTx, options: { now?: Date } = {}): Promise<LaunchResetPlan> {
  return collectPlan(db, options.now ?? new Date());
}

/** A fila não pode estar no meio de um handler: a linha some debaixo dele. */
export async function assertQueueIdle(db: DbOrTx): Promise<void> {
  const [row] = await db.select({ n: count() }).from(schema.outboxEvents).where(eq(schema.outboxEvents.status, "processing"));
  if (Number(row?.n ?? 0) > 0) {
    throw new ServiceError("QUEUE_BUSY", `A fila está processando ${row.n} evento(s) agora — espere um minuto e tente de novo.`);
  }
}

async function deleteAll(tx: DbOrTx, table: PgTable & { id: AnyPgColumn }, where?: SQL): Promise<number> {
  const rows = await tx.delete(table).where(where).returning({ id: table.id });
  return rows.length;
}

const LEVEL_UPSERT_BATCH = 200;

async function recomputeStockLevels(tx: DbOrTx): Promise<number> {
  const levels = await variantLevels(tx);
  const sums = await ledgerSums(tx, false);
  const recomputed = recomputeLevels(
    sums,
    levels.map((l) => l.variantId),
  );
  const skuOf = new Map(levels.map((l) => [l.variantId, l.sku]));
  assertLevelInvariants(recomputed, (id) => skuOf.get(id) ?? id);
  // Em lotes: pelo pooler cada ida e volta custa dezenas de ms e a transação segura as travas.
  for (let i = 0; i < recomputed.length; i += LEVEL_UPSERT_BATCH) {
    await tx
      .insert(schema.stockLevels)
      .values(
        recomputed
          .slice(i, i + LEVEL_UPSERT_BATCH)
          .map((level) => ({ productVariantId: level.productVariantId, onHand: level.onHand, reserved: level.reserved })),
      )
      .onConflictDoUpdate({
        target: schema.stockLevels.productVariantId,
        set: { onHand: sql`excluded.on_hand`, reserved: sql`excluded.reserved`, updatedAt: sql`now()` },
      });
  }
  return recomputed.length;
}

/** Conferência independente do fold em JS: níveis = somas do livro por balde, e reservado zero. */
async function assertLevelsMatchLedger(tx: DbOrTx): Promise<void> {
  const onHandTypes = sql.join(
    ON_HAND_MOVEMENT_TYPES.map((t) => sql`${t}`),
    sql`, `,
  );
  const reservedTypes = sql.join(
    RESERVED_MOVEMENT_TYPES.map((t) => sql`${t}`),
    sql`, `,
  );
  const rows = rowsOf<{ product_variant_id: string }>(
    await tx.execute(sql`
      SELECT l.product_variant_id
      FROM stock_levels l
      LEFT JOIN stock_movements m ON m.product_variant_id = l.product_variant_id
      GROUP BY l.product_variant_id, l.on_hand, l.reserved
      HAVING l.on_hand <> COALESCE(SUM(CASE WHEN m.type IN (${onHandTypes}) THEN m.quantity_delta END), 0)
          OR l.reserved <> COALESCE(SUM(CASE WHEN m.type IN (${reservedTypes}) THEN m.quantity_delta END), 0)
          OR l.reserved <> 0
    `),
  );
  if (rows.length > 0) {
    throw new ServiceError("LEDGER_MISMATCH", `Saldo e livro não batem em ${rows.length} variante(s) depois do recálculo. Nada foi gravado.`);
  }
}

async function assertGuardsEnabled(tx: DbOrTx): Promise<void> {
  const names = sql.join(
    GUARD_TRIGGERS.map((g) => sql`${g.trigger}`),
    sql`, `,
  );
  const rows = rowsOf<{ tgname: string; tgenabled: string }>(await tx.execute(sql`SELECT tgname, tgenabled FROM pg_trigger WHERE tgname IN (${names})`));
  const off = GUARD_TRIGGERS.filter((g) => rows.find((r) => r.tgname === g.trigger)?.tgenabled !== "O").map((g) => g.trigger);
  if (off.length > 0) throw new ServiceError("GUARDS_NOT_RESTORED", `Gatilhos de proteção não religados: ${off.join(", ")}. Nada foi gravado.`);
}

/**
 * Aplica a limpeza. Uma transação: travas, gatilhos desligados pelo nome,
 * exclusões em ordem, estoque recalculado e conferido, fila/auditoria
 * podadas, silêncio do vigia, cupons zerados, peças de teste arquivadas,
 * faixas de teste apagadas, numeração reiniciada, auditoria, gatilhos
 * religados e conferidos. Qualquer erro desfaz tudo (gatilhos incluídos).
 */
export async function applyLaunchReset(db: Db, options: { userId: string; now?: Date }): Promise<LaunchResetReport> {
  const now = options.now ?? new Date();
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL lock_timeout = '10s'`);
    await tx.execute(sql`SET LOCAL statement_timeout = '60s'`);
    await tx.execute(sql.raw(`LOCK TABLE ${LOCKED_TABLES.map((t) => `"${t}"`).join(", ")} IN EXCLUSIVE MODE`));

    const plan = await collectPlan(tx, now);
    if (plan.outbox.processing > 0) {
      throw new ServiceError(
        "QUEUE_BUSY",
        `A fila está processando ${plan.outbox.processing} evento(s) agora — espere um minuto e tente de novo. Nada foi gravado.`,
      );
    }
    const activeConversations = await tx
      .select({
        phoneE164: schema.waConversations.phoneE164,
        lid: schema.waConversations.lid,
        customerPhoneE164: schema.customers.phoneE164,
        lastInboundAt: schema.waConversations.lastInboundAt,
        lastOutboundAt: schema.waConversations.lastOutboundAt,
        updatedAt: schema.waConversations.updatedAt,
      })
      .from(schema.waConversations)
      .leftJoin(schema.customers, eq(schema.customers.id, schema.waConversations.customerId));
    const deletedEntryIds = (
      await tx.select({ id: schema.financialEntries.id }).from(schema.financialEntries).where(isNotNull(schema.financialEntries.orderId))
    ).map((r) => r.id);

    for (const guard of GUARD_TRIGGERS) await tx.execute(sql.raw(triggerToggleSql(guard, false)));

    const deleted = emptyCounts();
    deleted.atelier_intakes = await deleteAll(tx, schema.atelierIntakes);
    deleted.wa_suggestions = await deleteAll(tx, schema.waSuggestions);
    deleted.wa_followups = await deleteAll(tx, schema.waFollowups);
    deleted.delivery_feedback = await deleteAll(tx, schema.deliveryFeedback);
    deleted.customer_looks = await deleteAll(tx, schema.customerLooks);
    deleted.stock_alerts = await deleteAll(tx, schema.stockAlerts);
    deleted.stock_holds = await deleteAll(tx, schema.stockHolds);
    deleted.site_carts = await deleteAll(tx, schema.siteCarts);
    deleted.drop_waitlist = await deleteAll(tx, schema.dropWaitlist);
    deleted.drop_invites = await deleteAll(tx, schema.dropInvites);
    deleted.customer_profiles = await deleteAll(tx, schema.customerProfiles);
    deleted.wa_messages = await deleteAll(tx, schema.waMessages);
    deleted.wa_conversations = await deleteAll(tx, schema.waConversations);
    deleted.delivery_positions = await deleteAll(tx, schema.deliveryPositions);
    deleted.delivery_stops = await deleteAll(tx, schema.deliveryStops);
    deleted.delivery_runs = await deleteAll(tx, schema.deliveryRuns);
    deleted.financial_entries = await deleteAll(tx, schema.financialEntries, isNotNull(schema.financialEntries.orderId));
    deleted.order_status_history = await deleteAll(tx, schema.orderStatusHistory);
    deleted.order_items = await deleteAll(tx, schema.orderItems);
    deleted.orders = await deleteAll(tx, schema.orders);
    deleted.customer_addresses = await deleteAll(tx, schema.customerAddresses);
    deleted.customers = await deleteAll(tx, schema.customers);
    deleted.stock_movements = await deleteAll(tx, schema.stockMovements, inArray(schema.stockMovements.referenceType, [...LEDGER_REFERENCE_TYPES_TO_DROP]));

    const levelsWritten = await recomputeStockLevels(tx);
    await assertLevelsMatchLedger(tx);

    deleted.outbox_events = await deleteAll(tx, schema.outboxEvents, outboxDeleteWhere());
    deleted.inbound_events = await deleteAll(tx, schema.inboundEvents, inboundDeleteWhere(now));
    deleted.audit_log = await deleteAll(tx, schema.auditLog, auditDeleteWhere(deletedEntryIds));

    const silence = watchdogSilenceRows(activeConversations, now);
    if (silence.length > 0) {
      await tx.insert(schema.auditLog).values(
        silence.map((row) => ({
          actorType: "system",
          actorId: null,
          action: "wa.watchdog_alert",
          entityType: "wa_conversation",
          entityId: row.address,
          after: {
            name: null,
            lastMessageAt: row.lastMessageAt.toISOString(),
            knownAt: null,
            reason: LAUNCH_RESET_AUDIT_ACTION,
          },
          createdAt: now,
        })),
      );
    }

    const couponsReset = (
      await tx.update(schema.coupons).set({ usedCount: 0, updatedAt: now }).where(gt(schema.coupons.usedCount, 0)).returning({ id: schema.coupons.id })
    ).length;
    const productIds = plan.products.map((p) => p.id);
    let variantsDeactivated = 0;
    if (productIds.length > 0) {
      await tx.update(schema.products).set({ status: "archived", updatedAt: now }).where(inArray(schema.products.id, productIds));
      // Fora da vitrine E do controle de estoque/estoque baixo do painel.
      variantsDeactivated = (
        await tx
          .update(schema.productVariants)
          .set({ isActive: false, updatedAt: now })
          .where(and(inArray(schema.productVariants.productId, productIds), eq(schema.productVariants.isActive, true)))
          .returning({ id: schema.productVariants.id })
      ).length;
      // E fora do teaser da estreia, das edições e dos links de story (a peça arquivada não filtra sozinha).
      await tx.delete(schema.dropProducts).where(inArray(schema.dropProducts.productId, productIds));
      await tx.delete(schema.cityEditionProducts).where(inArray(schema.cityEditionProducts.productId, productIds));
      await tx.update(schema.campaignLinks).set({ productId: null, updatedAt: now }).where(inArray(schema.campaignLinks.productId, productIds));
    }
    const rateIds = plan.shippingRates.map((r) => r.id);
    if (rateIds.length > 0) await tx.delete(schema.shippingRates).where(inArray(schema.shippingRates.id, rateIds));

    await tx.execute(sql.raw(`ALTER SEQUENCE "${ORDER_NUMBER_SEQUENCE}" RESTART WITH ${FIRST_REAL_ORDER_NUMBER}`));

    const [audit] = await tx
      .insert(schema.auditLog)
      .values({
        actorType: "user",
        actorId: options.userId,
        action: LAUNCH_RESET_AUDIT_ACTION,
        entityType: "maintenance",
        entityId: "launch_reset",
        before: {
          counts: plan.counts,
          outbox: plan.outbox,
          inbound: plan.inbound,
          audit: plan.audit,
          stock: {
            movementsToDelete: plan.stock.movementsToDelete,
            levels: plan.stock.levels,
            preDivergences: plan.stock.preDivergences,
          },
          coupons: plan.coupons,
          orderNumbers: plan.orderNumbers,
        },
        after: {
          deleted,
          levelsWritten,
          productsArchived: plan.products.map((p) => p.slug),
          variantsDeactivated,
          ratesDeleted: plan.shippingRates.map((r) => r.name),
          couponsReset,
          watchdogSilenced: silence.length,
          nextOrderNumber: FIRST_REAL_ORDER_NUMBER,
          storagePaths: plan.storagePaths,
        },
        reason: "Limpeza pré-inauguração (decisão da dona)",
        createdAt: now,
      })
      .returning({ id: schema.auditLog.id });

    for (const guard of GUARD_TRIGGERS) await tx.execute(sql.raw(triggerToggleSql(guard, true)));
    await assertGuardsEnabled(tx);

    return {
      plan,
      deleted,
      levelsWritten,
      productsArchived: plan.products.map((p) => p.slug),
      variantsDeactivated,
      ratesDeleted: plan.shippingRates.map((r) => r.name),
      couponsReset,
      watchdogSilenced: silence.length,
      auditLogId: Number(audit.id),
    };
  });

  // Fora da transação: a vitrine é ISR (5 min); a fila pede a revalidação
  // agora. O banco já está limpo — uma falha aqui é só aviso (ISR resolve).
  const paths = ["/", "/produtos", "/estreia", ...result.productsArchived.filter((slug) => /^[a-z0-9-]+$/.test(slug)).map((slug) => `/produto/${slug}`)];
  let revalidateEvents: number | null = 0;
  try {
    for (let i = 0; i < paths.length; i += REVALIDATE_PATHS_PER_EVENT) {
      const id = await enqueueOutboxEvent(
        db,
        {
          eventType: "store.revalidate",
          dedupeKey: `store.revalidate:launch-reset:${now.getTime()}:${i}`,
          payload: { paths: paths.slice(i, i + REVALIDATE_PATHS_PER_EVENT) },
        },
        { kick: false },
      );
      if (id) revalidateEvents += 1;
    }
    await kickOutbox();
  } catch (error) {
    console.warn(`[launch-reset] revalidação da vitrine não enfileirada (a ISR resolve em 5 min):`, error instanceof Error ? error.message : error);
    revalidateEvents = null;
  }
  return { ...result, revalidateEvents };
}
