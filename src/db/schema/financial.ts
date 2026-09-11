import {
  bigint,
  check,
  date,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { orders } from "./orders";
import { suppliers } from "./suppliers";

export const financialEntries = pgTable(
  "financial_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    direction: text("direction").notNull(),
    // Ex.: sale, mp_fee, shipping_cost, supplier, refund, other.
    category: text("category").notNull(),
    description: text("description").notNull(),
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    status: text("status").notNull().default("pending"),
    dueDate: date("due_date"),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    orderId: uuid("order_id").references(() => orders.id, {
      onDelete: "restrict",
    }),
    supplierId: uuid("supplier_id").references(() => suppliers.id, {
      onDelete: "restrict",
    }),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("financial_entries_status_due_date_idx").on(
      table.status,
      table.dueDate,
    ),
    index("financial_entries_order_id_idx").on(table.orderId),
    index("financial_entries_supplier_id_idx").on(table.supplierId),
    // Uma taxa do Mercado Pago por pedido: o banco é o árbitro da duplicata
    // (webhook reenviado, conciliação diária), não a memória.
    uniqueIndex("financial_entries_order_mp_fee_unique_idx")
      .on(table.orderId)
      .where(sql`${table.category} = 'mp_fee' AND ${table.status} <> 'canceled'`),
    // Previsão "a receber por data": taxas pendentes ordenadas pelo repasse.
    index("financial_entries_category_due_date_idx")
      .on(table.category, table.dueDate)
      .where(sql`${table.status} = 'pending'`),
    check(
      "financial_entries_direction_check",
      sql`${table.direction} IN ('receivable', 'payable')`,
    ),
    check(
      "financial_entries_amount_cents_check",
      sql`${table.amountCents} > 0`,
    ),
    check(
      "financial_entries_status_check",
      sql`${table.status} IN ('pending', 'settled', 'canceled')`,
    ),
  ],
);
