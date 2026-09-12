// A ponte do site para a Lia: cada toque em "Falar com a Lia" (página da peça,
// sacola, rodapé ou link de story) grava aqui o que a cliente estava vendo,
// com um código curto que vai na mensagem do WhatsApp ("#K7F2"). Quando a
// primeira mensagem chega, a Lia consome a linha (consumed_at), liga à
// conversa e, depois, ao pedido — é o funil "de onde vieram".
import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { products } from "./catalog";
import { orders } from "./orders";
import { waConversations } from "./whatsapp";

export const siteCarts = pgTable(
  "site_carts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** 4 letras/números sem ambiguidade (sem 0/O, 1/I/L); único entre pontes abertas. */
    code: text("code").notNull(),
    source: text("source").notNull(),
    /** Slug do link de story quando source = 'campaign'. */
    campaignSlug: text("campaign_slug"),
    productId: uuid("product_id").references(() => products.id, { onDelete: "set null" }),
    variantSku: text("variant_sku"),
    /** Retrato da sacola/peça no toque: [{sku, name, variation, quantity, priceCents}]. */
    items: jsonb("items").notNull().default([]),
    conversationId: uuid("conversation_id").references(() => waConversations.id, { onDelete: "set null" }),
    orderId: uuid("order_id").references(() => orders.id, { onDelete: "set null" }),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // O código só precisa ser único entre pontes ainda abertas: consumida, o
    // código volta ao bolo (30^4 combinações; a geração tenta de novo se colidir).
    uniqueIndex("site_carts_code_open_unique_idx").on(table.code).where(sql`${table.consumedAt} IS NULL`),
    // O funil agrupa por origem e período.
    index("site_carts_source_created_at_idx").on(table.source, table.createdAt),
    // Painel da conversa e funil ligam ponte → conversa.
    index("site_carts_conversation_id_idx").on(table.conversationId),
    // Funil por link de story (toques, conversas, pedidos por campanha e período).
    index("site_carts_campaign_slug_created_at_idx").on(table.campaignSlug, table.createdAt),
    check("site_carts_source_check", sql`${table.source} IN ('pdp', 'cart', 'footer', 'campaign')`),
  ],
);
