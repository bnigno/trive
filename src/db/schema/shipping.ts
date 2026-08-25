import {
  bigint,
  boolean,
  char,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// Tabela de frete por faixa de CEP e peso. O cálculo escolhe a regra ativa
// cuja faixa contém o CEP do cliente e o peso total do pedido, ordenando por
// sort_order (menor primeiro) para desempatar.
export const shippingRates = pgTable(
  "shipping_rates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    // Faixa de CEP em dígitos (sem hífen); padrão cobre o Brasil inteiro.
    cepStart: char("cep_start", { length: 8 }).notNull().default("00000000"),
    cepEnd: char("cep_end", { length: 8 }).notNull().default("99999999"),
    weightMinGrams: integer("weight_min_grams").notNull().default(0),
    weightMaxGrams: integer("weight_max_grams").notNull().default(30000),
    priceCents: bigint("price_cents", { mode: "number" }).notNull(),
    deliveryDaysMin: integer("delivery_days_min").notNull().default(3),
    deliveryDaysMax: integer("delivery_days_max").notNull().default(10),
    isActive: boolean("is_active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("shipping_rates_is_active_idx").on(table.isActive),
    check("shipping_rates_price_cents_check", sql`${table.priceCents} >= 0`),
    check(
      "shipping_rates_cep_range_check",
      sql`${table.cepStart} <= ${table.cepEnd}`,
    ),
    check(
      "shipping_rates_weight_range_check",
      sql`${table.weightMinGrams} <= ${table.weightMaxGrams}`,
    ),
  ],
);
