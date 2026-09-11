import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { productVariants } from "./catalog";
import { customers } from "./customers";
import { orders } from "./orders";
import { waConversations } from "./whatsapp";

// Reserva gentil: a peça fica segurada para um telefone por algumas horas,
// SEM pedido. O estoque continua no ledger (movimento 'reservation' com
// reference_type='hold'); esta tabela só diz para quem e até quando. UMA
// reserva ativa por telefone, arbitrada pelo banco (unique parcial).
export const stockHolds = pgTable(
  "stock_holds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productVariantId: uuid("product_variant_id")
      .notNull()
      .references(() => productVariants.id, { onDelete: "restrict" }),
    phoneE164: text("phone_e164").notNull(),
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "set null" }),
    conversationId: uuid("conversation_id").references(() => waConversations.id, {
      onDelete: "set null",
    }),
    quantity: integer("quantity").notNull().default(1),
    status: text("status").notNull().default("active"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    reminderSentAt: timestamp("reminder_sent_at", { withTimezone: true }),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    // Pedido que consumiu a reserva (status 'converted').
    orderId: uuid("order_id").references(() => orders.id, { onDelete: "set null" }),
    createdBy: text("created_by").notNull().default("lia"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("stock_holds_active_phone_idx")
      .on(table.phoneE164)
      .where(sql`${table.status} = 'active'`),
    index("stock_holds_variant_status_idx").on(table.productVariantId, table.status),
    index("stock_holds_expires_at_idx").on(table.expiresAt),
    check("stock_holds_quantity_check", sql`${table.quantity} BETWEEN 1 AND 2`),
    check(
      "stock_holds_status_check",
      sql`${table.status} IN ('active', 'expired', 'released', 'converted')`,
    ),
    check("stock_holds_created_by_check", sql`${table.createdBy} IN ('lia', 'admin')`),
  ],
);

// "Me avisa quando voltar": UMA mensagem quando a peça volta ao estoque.
// Consentimento explícito (consent_at); depois de avisar ou cancelar, a
// linha fica como histórico e um novo pedido cria outra.
export const stockAlerts = pgTable(
  "stock_alerts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productVariantId: uuid("product_variant_id")
      .notNull()
      .references(() => productVariants.id, { onDelete: "cascade" }),
    phoneE164: text("phone_e164").notNull(),
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "set null" }),
    conversationId: uuid("conversation_id").references(() => waConversations.id, {
      onDelete: "set null",
    }),
    source: text("source").notNull(),
    consentAt: timestamp("consent_at", { withTimezone: true }).notNull().defaultNow(),
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
    notifiedWaMessageId: uuid("notified_wa_message_id"),
    canceledAt: timestamp("canceled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("stock_alerts_open_idx")
      .on(table.productVariantId, table.phoneE164)
      .where(sql`${table.notifiedAt} IS NULL AND ${table.canceledAt} IS NULL`),
    index("stock_alerts_variant_idx").on(table.productVariantId),
    index("stock_alerts_phone_idx").on(table.phoneE164),
    check("stock_alerts_source_check", sql`${table.source} IN ('lia', 'site', 'admin')`),
  ],
);
