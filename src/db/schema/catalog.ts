import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  type AnyPgColumn,
  unique,
  uniqueIndex,
  uuid,
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
    // Ficha da peça (Onda 5): o que a placa de museu, o cartão da caixa e a
    // Lia contam sobre tecido, cuidados e caimento. Texto livre; os cuidados
    // aceitam chaves de pictograma por linha (src/core/catalog/care.ts).
    composition: text("composition"),
    careNotes: text("care_notes"),
    fitNotes: text("fit_notes"),
    // Uma frase da curadora sobre a peça (o áudio chega em outro PR).
    curatorNote: text("curator_note"),
    /** Áudio da nota falada (bucket product-images); null = só texto. */
    curatorAudioPath: text("curator_audio_path"),
    curatorAudioMime: text("curator_audio_mime"),
    curatorAudioSeconds: integer("curator_audio_seconds"),
    /** Carimbo da última gravação/edição: fura o cache do player. */
    curatorNoteUpdatedAt: timestamp("curator_note_updated_at", { withTimezone: true }),
    /** Post 4:5 mais recente no Storage: é a prévia do link da peça. */
    postCardPath: text("post_card_path"),
    categoryId: uuid("category_id").references(() => categories.id, {
      onDelete: "restrict",
    }),
    brand: text("brand"),
    // 1 fornecedor por produto (espelha categoryId; multi-fornecedor = YAGNI).
    supplierId: uuid("supplier_id").references(() => suppliers.id, {
      onDelete: "restrict",
    }),
    status: text("status").notNull().default("draft"),
    // Lançamento: peça ativa mas escondida da vitrine até este instante
    // (só convidadas do lançamento veem antes). NULL = visível.
    visibleFrom: timestamp("visible_from", { withTimezone: true }),
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
    // Medidas da peça deitada, em cm, por variação ({bust, waist, hip,
    // length, sleeve, shoulder}); NULL = sem medida. A forma é garantida pelo
    // Zod do service (src/core/catalog/measurements.ts), não por CHECK.
    measurements: jsonb("measurements"),
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
    // O bot do WhatsApp procura o código sem diferenciar caixa (ilike): dois
    // códigos que só diferem em maiúsculas fechariam o pedido na variação
    // errada. O árbitro é o banco (regra 6), não a memória.
    uniqueIndex("product_variants_sku_lower_unique_idx").on(
      sql`lower(${table.sku})`,
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
