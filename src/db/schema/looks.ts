// "Quem já vestiu": a foto que a cliente mandou usando a peça. Nasce quando
// a Lia registra (registrar_foto_com_a_peca); a fila baixa a foto, desenha o
// cartão "Ana veste Longo Dunas" e faz a pergunta tocável de consentimento.
// Só aparece na vitrine com consent_answer = 'sim' E aprovação da dona E sem
// revogação — a cliente pode retirar quando quiser (retirar_minha_foto,
// "esquecer minha cartela") e a dona também.
import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { productVariants, products } from "./catalog";
import { coupons } from "./coupons";
import { customers } from "./customers";
import { users } from "./governance";
import { orders } from "./orders";
import { waMessages } from "./whatsapp";

export const customerLooks = pgTable(
  "customer_looks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "set null" }),
    phoneE164: text("phone_e164").notNull(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    productVariantId: uuid("product_variant_id").references(() => productVariants.id, { onDelete: "set null" }),
    /** O pedido entregue com a peça, quando existe (rastro; a foto vale sem ele). */
    orderId: uuid("order_id").references(() => orders.id, { onDelete: "set null" }),
    // O mimo pela foto (cupom pessoal emitido no registro), quando houve.
    couponId: uuid("coupon_id").references(() => coupons.id, { onDelete: "set null" }),
    /** Primeiro nome, como sai no cartão e na vitrine ("Ana veste …"). */
    displayName: text("display_name").notNull(),
    /** A mensagem com a foto (a fila baixa dela; a URL da Z-API expira em semanas). */
    photoWaMessageId: uuid("photo_wa_message_id").references(() => waMessages.id, { onDelete: "set null" }),
    /** looks/<id>/photo.jpg — só depois de baixada e normalizada. */
    photoPath: text("photo_path"),
    /** looks/<id>/card.jpg — o cartão desenhado. */
    cardPath: text("card_path"),
    /** sim | nao — null enquanto ela não tocou. */
    consentAnswer: text("consent_answer"),
    consentAt: timestamp("consent_at", { withTimezone: true }),
    consentWaMessageId: uuid("consent_wa_message_id").references(() => waMessages.id, { onDelete: "set null" }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedBy: uuid("approved_by").references(() => users.id, { onDelete: "set null" }),
    rejectedAt: timestamp("rejected_at", { withTimezone: true }),
    /** Retirada (pela cliente, pela dona ou pelo "esquecer"): some da vitrine para sempre. */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: text("revoked_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("customer_looks_product_public_idx")
      .on(table.productId)
      .where(sql`${table.consentAnswer} = 'sim' AND ${table.approvedAt} IS NOT NULL AND ${table.revokedAt} IS NULL`),
    index("customer_looks_phone_idx").on(table.phoneE164),
    index("customer_looks_customer_idx").on(table.customerId),
    // A mesma foto (mensagem) nunca vira duas linhas: o árbitro é o banco.
    uniqueIndex("customer_looks_photo_message_idx").on(table.photoWaMessageId).where(sql`${table.photoWaMessageId} IS NOT NULL`),
    check("customer_looks_display_name_len", sql`char_length(${table.displayName}) <= 40`),
    check("customer_looks_consent_answer_check", sql`${table.consentAnswer} IS NULL OR ${table.consentAnswer} IN ('sim', 'nao')`),
    check("customer_looks_revoked_by_check", sql`${table.revokedBy} IS NULL OR ${table.revokedBy} IN ('customer', 'owner', 'lia', 'forget')`),
  ],
);
