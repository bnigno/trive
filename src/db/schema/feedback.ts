// "Chegou bem?": um dia depois da entrega a cliente recebe UMA lista tocável
// (Amei / Ficou grande / Ficou pequeno / Veio com defeito / Quero falar com
// alguém). Uma linha por pedido (UNIQUE): nasce quando a pergunta sai e
// ganha a resposta quando o toque volta. A variação entra quando o pedido
// tem uma peça só — é o que vira o sinal de caimento por tamanho.
import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { productVariants } from "./catalog";
import { customers } from "./customers";
import { orders } from "./orders";
import { waMessages } from "./whatsapp";

export const deliveryFeedback = pgTable(
  "delivery_feedback",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .unique()
      .references(() => orders.id, { onDelete: "restrict" }),
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "set null" }),
    phoneE164: text("phone_e164").notNull(),
    /** A peça do pedido quando ele tem uma só (o sinal de caimento é por tamanho). */
    productVariantId: uuid("product_variant_id").references(() => productVariants.id, { onDelete: "set null" }),
    /** amei | grande | pequeno | defeito | falar — null enquanto não respondeu. */
    answer: text("answer"),
    askedAt: timestamp("asked_at", { withTimezone: true }).notNull().defaultNow(),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    /** A mensagem recebida com o toque (rastro no painel). */
    answerWaMessageId: uuid("answer_wa_message_id").references(() => waMessages.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("delivery_feedback_variant_answer_idx").on(table.productVariantId, table.answer),
    index("delivery_feedback_phone_idx").on(table.phoneE164),
    check("delivery_feedback_answer_check", sql`${table.answer} IS NULL OR ${table.answer} IN ('amei', 'grande', 'pequeno', 'defeito', 'falar')`),
  ],
);
