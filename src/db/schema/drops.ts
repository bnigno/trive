import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { products } from "./catalog";
import { customers } from "./customers";

// Lançamento com janela VIP: as peças ficam escondidas (products.visible_from
// = publish_at) e, vip_window_hours antes, as convidadas (drop_invites,
// materializadas ao agendar) recebem o convite com o link do token.
export const drops = pgTable(
  "drops",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    status: text("status").notNull().default("draft"),
    publishAt: timestamp("publish_at", { withTimezone: true }).notNull(),
    vipWindowHours: integer("vip_window_hours").notNull().default(24),
    audienceLimit: integer("audience_limit").notNull().default(60),
    messageOverride: text("message_override"),
    vipSentAt: timestamp("vip_sent_at", { withTimezone: true }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    canceledAt: timestamp("canceled_at", { withTimezone: true }),
    /** Última imagem de story gerada (Storage): atrás do véu e aberta. */
    storyTeaserPath: text("story_teaser_path"),
    storyOpenPath: text("story_open_path"),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("drops_status_publish_at_idx").on(table.status, table.publishAt),
    check(
      "drops_status_check",
      sql`${table.status} IN ('draft', 'scheduled', 'vip_sent', 'published', 'canceled')`,
    ),
    check("drops_vip_window_hours_check", sql`${table.vipWindowHours} BETWEEN 1 AND 168`),
    check("drops_audience_limit_check", sql`${table.audienceLimit} BETWEEN 1 AND 500`),
  ],
);

export const dropProducts = pgTable(
  "drop_products",
  {
    dropId: uuid("drop_id")
      .notNull()
      .references(() => drops.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.dropId, table.productId] }), index("drop_products_product_idx").on(table.productId)],
);

export const dropInvites = pgTable(
  "drop_invites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dropId: uuid("drop_id")
      .notNull()
      .references(() => drops.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    phoneE164: text("phone_e164").notNull(),
    token: uuid("token").notNull().defaultRandom(),
    score: integer("score").notNull().default(0),
    reasons: jsonb("reasons").notNull().default([]),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    waMessageId: uuid("wa_message_id"),
    firstVisitAt: timestamp("first_visit_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("drop_invites_drop_customer_idx").on(table.dropId, table.customerId),
    uniqueIndex("drop_invites_token_idx").on(table.token),
    index("drop_invites_customer_idx").on(table.customerId),
  ],
);

// Lista "me avisa quando a cortina abrir" da estreia pública (/estreia): um
// telefone por lançamento enquanto ainda não foi avisado; ao publicar, cada
// linha vira uma mensagem (dentro da janela de envio, escalonada).
export const dropWaitlist = pgTable(
  "drop_waitlist",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dropId: uuid("drop_id")
      .notNull()
      .references(() => drops.id, { onDelete: "cascade" }),
    phoneE164: text("phone_e164").notNull(),
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "set null" }),
    /** De onde veio o pedido: 'site' (/estreia), 'lia' ou 'admin'. */
    source: text("source").notNull().default("site"),
    /** A cliente marcou "quero receber no WhatsApp" — consentimento literal. */
    consentAt: timestamp("consent_at", { withTimezone: true }).notNull().defaultNow(),
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
    notifiedWaMessageId: uuid("notified_wa_message_id"),
    canceledAt: timestamp("canceled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("drop_waitlist_open_idx")
      .on(table.dropId, table.phoneE164)
      .where(sql`${table.notifiedAt} IS NULL AND ${table.canceledAt} IS NULL`),
    index("drop_waitlist_drop_idx").on(table.dropId),
    index("drop_waitlist_phone_idx").on(table.phoneE164),
    check("drop_waitlist_source_check", sql`${table.source} IN ('site', 'lia', 'admin')`),
  ],
);
