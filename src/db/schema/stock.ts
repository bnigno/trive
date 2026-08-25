import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { productVariants } from "./catalog";

// Append-only: UPDATE/DELETE bloqueados por trigger (migração fase1_guards).
export const stockMovements = pgTable(
  "stock_movements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productVariantId: uuid("product_variant_id")
      .notNull()
      .references(() => productVariants.id, { onDelete: "restrict" }),
    type: text("type").notNull(),
    quantityDelta: integer("quantity_delta").notNull(),
    unitCostCents: bigint("unit_cost_cents", { mode: "number" }),
    referenceType: text("reference_type"),
    referenceId: uuid("reference_id"),
    idempotencyKey: text("idempotency_key").unique(),
    note: text("note"),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("stock_movements_product_variant_id_created_at_idx").on(
      table.productVariantId,
      table.createdAt,
    ),
    check(
      "stock_movements_type_check",
      sql`${table.type} IN ('purchase_in', 'sale_out', 'reservation', 'reservation_release', 'adjustment', 'return_in', 'loss')`,
    ),
    check(
      "stock_movements_quantity_delta_check",
      sql`${table.quantityDelta} <> 0`,
    ),
  ],
);

export const stockLevels = pgTable(
  "stock_levels",
  {
    productVariantId: uuid("product_variant_id")
      .primaryKey()
      .references(() => productVariants.id, { onDelete: "restrict" }),
    onHand: integer("on_hand").notNull().default(0),
    reserved: integer("reserved").notNull().default(0),
    lowStockThreshold: integer("low_stock_threshold").notNull().default(3),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check("stock_levels_on_hand_check", sql`${table.onHand} >= 0`),
    check("stock_levels_reserved_check", sql`${table.reserved} >= 0`),
    check(
      "stock_levels_available_check",
      sql`(${table.onHand} - ${table.reserved}) >= 0`,
    ),
  ],
);
