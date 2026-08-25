import {
  bigint,
  boolean,
  check,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// Cupons de desconto da loja. O código é armazenado SEMPRE em UPPERCASE
// (normalização no serviço) e é único. `value` depende do tipo:
//   - percent: 1..100 (percentual sobre o subtotal, arredondado para baixo)
//   - fixed:   centavos (nunca desconta mais que o subtotal)
// used_count é incrementado com guard atômico (redeemCouponInTx) para o
// limite max_uses nunca ser ultrapassado, mesmo com pedidos simultâneos.
export const coupons = pgTable(
  "coupons",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull().unique(),
    type: text("type").notNull(),
    value: integer("value").notNull(),
    minOrderCents: bigint("min_order_cents", { mode: "number" })
      .notNull()
      .default(0),
    startsAt: timestamp("starts_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    maxUses: integer("max_uses"),
    usedCount: integer("used_count").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check("coupons_type_check", sql`${table.type} IN ('percent', 'fixed')`),
    check("coupons_value_check", sql`${table.value} > 0`),
    check(
      "coupons_percent_range_check",
      sql`${table.type} <> 'percent' OR ${table.value} <= 100`,
    ),
    check("coupons_min_order_check", sql`${table.minOrderCents} >= 0`),
    check("coupons_used_count_check", sql`${table.usedCount} >= 0`),
    check(
      "coupons_max_uses_check",
      sql`${table.maxUses} IS NULL OR ${table.maxUses} > 0`,
    ),
  ],
);
