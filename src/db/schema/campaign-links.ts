// Links de story: a dona cria "dunas" → trivemaison.com.br/ig/dunas, cola no
// sticker do story e quem toca cai no WhatsApp da Lia com a mensagem pronta.
// Cada toque nasce em site_carts (source 'campaign', campaign_slug = slug):
// é de lá que o funil conta toques → conversas → pedidos por link.
import { sql } from "drizzle-orm";
import { boolean, check, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { products } from "./catalog";

/** Mesma regra do core (normalizeCampaignSlug): a CHECK do banco é a última barreira. */
export const CAMPAIGN_SLUG_PATTERN = "^[a-z0-9-]{2,40}$";

export const campaignLinks = pgTable(
  "campaign_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** O que vai na URL: minúsculo, sem acento, 2–40 chars. Único para sempre (o link já foi colado por aí). */
    slug: text("slug").notNull().unique(),
    /** Nome humano ("Dunas no story do Círio"): é a origem que o painel e a Lia mostram. */
    label: text("label").notNull(),
    /** A peça do story (opcional: link genérico vai sem peça). */
    productId: uuid("product_id").references(() => products.id, { onDelete: "set null" }),
    isActive: boolean("is_active").notNull().default(true),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("campaign_links_product_id_idx").on(table.productId),
    check("campaign_links_slug_check", sql`${table.slug} ~ ${sql.raw(`'${CAMPAIGN_SLUG_PATTERN}'`)}`),
  ],
);
