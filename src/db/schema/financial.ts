import {
  bigint,
  check,
  date,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { orders } from "./orders";

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
