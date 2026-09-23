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
    // Sem unique de coluna: o endereço só é único entre as peças VIVAS
    // (índice parcial abaixo), senão excluir uma peça prenderia o slug.
    slug: text("slug").notNull(),
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
    /** Carimbo da última mudança do TEXTO da nota (a tela remonta o campo por ele). */
    curatorNoteUpdatedAt: timestamp("curator_note_updated_at", { withTimezone: true }),
    /** Post 4:5 mais recente no Storage: é a prévia do link da peça. */
    postCardPath: text("post_card_path"),
    categoryId: uuid("category_id").references(() => categories.id, {
      onDelete: "restrict",
    }),
    // Tipo de peça (vestido, corset, bolsa…): lista fixa em
    // core/catalog/piece-types.ts, garantida por Zod no service. É por ele
    // que a Lia acha "um corset" numa categoria larga como Vestuário.
    pieceType: text("piece_type"),
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
    // Excluir uma peça devolve o endereço dela: quem recadastrar a peça certa
    // usa o mesmo slug. Peça excluída sai da vitrine, então não há colisão de
    // URL — e o parcial é o único jeito de o banco concordar com o service.
    uniqueIndex("products_slug_unique_idx")
      .on(table.slug)
      .where(sql`${table.deletedAt} is null`),
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
    // Sem unique de coluna: o código só é único entre as variações VIVAS
    // (índice parcial abaixo). Quem já foi vendido continua barrado pelo
    // service (assertSkuAvailable olha order_items.sku_snapshot).
    sku: text("sku").notNull(),
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
    uniqueIndex("product_variants_sku_lower_unique_idx")
      .on(sql`lower(${table.sku})`)
      .where(sql`${table.deletedAt} is null`),
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
    // Impressão digital da foto (dHash de 64 bits, core/images/phash.ts) em 16
    // hexadecimais: a Lia compara com a foto que a cliente manda para saber
    // QUAL peça é. Texto, não inteiro: Postgres não tem 64 bits sem sinal e a
    // busca é varredura em memória (centenas de fotos). NULL = ainda não
    // calculada (scripts/backfill-image-hashes.ts preenche).
    phash: text("phash"),
    // Proveniência: 'upload' = foto real subida pela equipe; 'ai' = ensaio
    // gerado (a peça no corpo de uma modelo da casa). A vitrine só mostra
    // 'ai' com o setting ai_photos_in_store; o post do Instagram e os
    // cartões da Lia preferem a 'ai'; a busca por foto (phash) ignora 'ai'.
    origin: text("origin").notNull().default("upload"),
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
    index("product_images_phash_idx").on(table.phash),
    index("product_images_product_id_origin_idx").on(table.productId, table.origin),
    check("product_images_origin_check", sql`${table.origin} IN ('upload', 'ai')`),
  ],
);

export const PRODUCT_IMAGE_ORIGINS = ["upload", "ai"] as const;
export type ProductImageOrigin = (typeof PRODUCT_IMAGE_ORIGINS)[number];
