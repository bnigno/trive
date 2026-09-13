import { boolean, check, date, index, integer, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { products } from "./catalog";

// Edições de Belém — a curadoria com data e lugar ("Edição Círio", "Chuva
// das 14h"): frase de abertura, parágrafo da dona, bairros, capa, vigência
// (período e/ou faixa de hora) e as peças escolhidas. NÃO confundir com
// `core/edition` (singular), que é o cartão da caixa / setting edition_name.
export const cityEditions = pgTable(
  "city_editions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    /** Frase curta de abertura ("Vestida para o Círio"). */
    openingLine: text("opening_line"),
    /** Parágrafo da curadora (texto corrido; quebras de linha viram parágrafos). */
    body: text("body"),
    /** Bairros atendidos, um por linha (texto livre da dona). */
    districts: text("districts"),
    coverPath: text("cover_path"),
    /** Vigência por período ('YYYY-MM-DD', dia de São Paulo, inclusivo). Nulos = sempre. */
    startsOn: date("starts_on"),
    endsOn: date("ends_on"),
    /** Vigência por hora do dia (0–23, hourEnd exclusivo). Nulos = o dia inteiro. */
    hourStart: integer("hour_start"),
    hourEnd: integer("hour_end"),
    isActive: boolean("is_active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("city_editions_active_idx").on(table.isActive, table.sortOrder),
    check(
      "city_editions_hours_check",
      sql`(${table.hourStart} IS NULL AND ${table.hourEnd} IS NULL) OR (${table.hourStart} BETWEEN 0 AND 23 AND ${table.hourEnd} BETWEEN 1 AND 24 AND ${table.hourStart} < ${table.hourEnd})`,
    ),
    check("city_editions_period_check", sql`${table.startsOn} IS NULL OR ${table.endsOn} IS NULL OR ${table.startsOn} <= ${table.endsOn}`),
  ],
);

export const cityEditionProducts = pgTable(
  "city_edition_products",
  {
    cityEditionId: uuid("city_edition_id")
      .notNull()
      .references(() => cityEditions.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.cityEditionId, table.productId] }),
    index("city_edition_products_product_idx").on(table.productId),
  ],
);
