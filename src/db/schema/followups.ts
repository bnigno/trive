// Retornos combinados da Lia: "me chama amanhã às 10" → com o sim da cliente
// a Lia agenda e, no horário (sempre dentro da janela 9–21), manda uma
// mensagem proativa retomando a conversa. Uma linha por combinado; a fila
// (wa.bot_followup, next_attempt_at = due_at) entrega. `kind` separa o
// retorno pedido pela cliente ('customer') de retomadas automáticas futuras
// ('idle_cart' — uma por conversa, para sempre).
import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { customers } from "./customers";
import { users } from "./governance";
import { waConversations, waMessages } from "./whatsapp";

export const waFollowups = pgTable(
  "wa_followups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => waConversations.id, { onDelete: "restrict" }),
    phoneE164: text("phone_e164").notNull(),
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "set null" }),
    /** customer | idle_cart */
    kind: text("kind").notNull(),
    /** O que combinar quando voltar ("ver se decidiu o Longo Dunas"). */
    reason: text("reason").notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    /** scheduled | sent | canceled | superseded | skipped */
    status: text("status").notNull().default("scheduled"),
    /** A mensagem dela com o "sim" (prova do consentimento). */
    consentWaMessageId: uuid("consent_wa_message_id").references(() => waMessages.id, { onDelete: "set null" }),
    /** lia | system */
    requestedBy: text("requested_by").notNull().default("lia"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    sentWaMessageId: uuid("sent_wa_message_id").references(() => waMessages.id, { onDelete: "set null" }),
    canceledAt: timestamp("canceled_at", { withTimezone: true }),
    /** dono | cliente | substituido | sair | conversa_humana | conversa_fechada | bot_desligado | superada | sem_resposta */
    canceledReason: text("canceled_reason"),
    canceledBy: uuid("canceled_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Um retorno agendado por conversa e tipo: agendar de novo substitui.
    uniqueIndex("wa_followups_scheduled_idx").on(table.conversationId, table.kind).where(sql`${table.status} = 'scheduled'`),
    // A retomada de sacola parada acontece UMA vez por conversa, para sempre.
    uniqueIndex("wa_followups_idle_cart_once_idx").on(table.conversationId).where(sql`${table.kind} = 'idle_cart'`),
    index("wa_followups_status_due_idx").on(table.status, table.dueAt),
    index("wa_followups_phone_idx").on(table.phoneE164),
    check("wa_followups_kind_check", sql`${table.kind} IN ('customer', 'idle_cart')`),
    check("wa_followups_status_check", sql`${table.status} IN ('scheduled', 'sent', 'canceled', 'superseded', 'skipped')`),
  ],
);
