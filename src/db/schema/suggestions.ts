// Modo copiloto: a Lia sugere e a dona aprova na Central. Cada turno em
// copiloto vira uma sugestão (os balões + os anexos que a Lia mandaria); a
// dona envia, edita e envia, ou descarta. Uma por mensagem recebida (a
// reentrada da fila não cria outra); a nova mensagem da cliente supera a
// pendente. `followup_id`: o retorno combinado que virou sugestão.
import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { waFollowups } from "./followups";
import { users } from "./governance";
import { waConversations, waMessages } from "./whatsapp";

export const waSuggestions = pgTable(
  "wa_suggestions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => waConversations.id, { onDelete: "restrict" }),
    /** A mensagem dela que gerou a sugestão (null quando veio de um retorno combinado). */
    inboundMessageId: uuid("inbound_message_id").references(() => waMessages.id, { onDelete: "set null" }),
    followupId: uuid("followup_id").references(() => waFollowups.id, { onDelete: "set null" }),
    /** pending | sent | discarded | superseded */
    status: text("status").notNull().default("pending"),
    /** Os balões como a Lia mandaria (string[]). */
    bubbles: jsonb("bubbles").notNull(),
    /** Lista tocável / foto que iriam antes do texto (BotAttachment[]). */
    attachments: jsonb("attachments").notNull().default(sql`'[]'::jsonb`),
    /** Ferramentas que rodaram no turno ({name, ok}[]) — trilha para o painel. */
    toolCalls: jsonb("tool_calls").notNull().default(sql`'[]'::jsonb`),
    /** O que a dona mandou de fato quando editou (string[]); null = os balões originais. */
    finalBubbles: jsonb("final_bubbles"),
    sentBy: uuid("sent_by").references(() => users.id, { onDelete: "set null" }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    discardedBy: uuid("discarded_by").references(() => users.id, { onDelete: "set null" }),
    discardedAt: timestamp("discarded_at", { withTimezone: true }),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("wa_suggestions_inbound_idx").on(table.inboundMessageId).where(sql`${table.inboundMessageId} IS NOT NULL`),
    uniqueIndex("wa_suggestions_followup_idx").on(table.followupId).where(sql`${table.followupId} IS NOT NULL`),
    index("wa_suggestions_conversation_status_idx").on(table.conversationId, table.status),
    check("wa_suggestions_status_check", sql`${table.status} IN ('pending', 'sent', 'discarded', 'superseded')`),
  ],
);
