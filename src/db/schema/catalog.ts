import {
  boolean,
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { suppliers } from "./suppliers";

export const categories = pgTable(
  "categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    slug: text("slug").unique().notNull(),
    parentId: uuid("parent_id").references((): AnyPgColumn => categories.id, {
      onDelete: "restrict",
    }),
    // Foto de capa da sala: path -full.webp no Storage (md/thumb por
    // convenção). O foco vertical (0–100, object-position) existe porque a
    // mesma foto serve ao card 4:5 da home e à faixa larga da coleção.
    coverPath: text("cover_path"),
    coverFocalY: smallint("cover_focal_y").notNull().default(50),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("categories_parent_id_idx").on(table.parentId)],
);

export const products = pgTable(
  "products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    slug: text("slug").unique().notNull(),
    description: text("description"),
    categoryId: uuid("category_id").references(() => categories.id, {
      onDelete: "restrict",
    }),
    brand: text("brand"),
    // 1 fornecedor por produto (espelha categoryId; multi-fornecedor = YAGNI).
    supplierId: uuid("supplier_id").references(() => suppliers.id, {
      onDelete: "restrict",
    }),
    status: text("status").notNull().default("draft"),
    // Eixos de variação do produto, ex.: ["cor","tamanho"].
    attributesSchema: jsonb("attributes_schema").default([]),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    index("products_category_id_idx").on(table.categoryId),
    index("products_supplier_id_idx").on(table.supplierId),
    check(
      "products_status_check",
      sql`${table.status} IN ('draft', 'active', 'archived')`,
    ),
  ],
);

export const productVariants = pgTable(
  "product_variants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    sku: text("sku").unique().notNull(),
    // NOT NULL é o que dá dente ao unique (product_id, attributes): em SQL,
    // NULL nunca conflita com NULL, então duas variantes sem atributos
    // duplicariam a grade cor×tamanho em silêncio.
    attributes: jsonb("attributes").notNull().default({}),
    barcodeEan: text("barcode_ean"),
    weightGrams: integer("weight_grams"),
    lengthMm: integer("length_mm"),
    widthMm: integer("width_mm"),
    heightMm: integer("height_mm"),
    // Denormalização do variant_costs mais recente.
    costCents: bigint("cost_cents", { mode: "number" }).notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    index("product_variants_product_id_idx").on(table.productId),
    unique("product_variants_product_id_attributes_unique").on(
      table.productId,
      table.attributes,
    ),
  ],
);

export const productImages = pgTable(
  "product_images",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // ON DELETE CASCADE: dependente puro do produto/variante.
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    variantId: uuid("variant_id").references(() => productVariants.id, {
      onDelete: "cascade",
    }),
    storagePath: text("storage_path").notNull(),
    altText: text("alt_text"),
    // Cor à qual esta foto pertence; NULL = foto do produto inteiro, aparece
    // em qualquer escolha. Pareia com o primeiro eixo de attributes_schema.
    color: text("color"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("product_images_product_id_idx").on(table.productId),
    index("product_images_variant_id_idx").on(table.variantId),
    index("product_images_product_id_color_idx").on(
      table.productId,
      table.color,
    ),
  ],
);
