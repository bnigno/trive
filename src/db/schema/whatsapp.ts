import {
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { customers } from "./customers";
import { orders } from "./orders";

// Conversa por telefone: no máximo UMA conversa não-fechada por número
// (unique parcial). customer_id é SET NULL para a conversa sobreviver à
// anonimização/remoção do cliente (LGPD) — o histórico fica sem vínculo.
export const waConversations = pgTable(
  "wa_conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    phoneE164: text("phone_e164").notNull(),
    customerId: uuid("customer_id").references(() => customers.id, {
      onDelete: "set null",
    }),
    // open: fluxo normal; human: dono assumiu a conversa; closed: encerrada.
    status: text("status").notNull().default("open"),
    lastInboundAt: timestamp("last_inbound_at", { withTimezone: true }),
    lastOutboundAt: timestamp("last_outbound_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("wa_conversations_phone_e164_active_unique_idx")
      .on(table.phoneE164)
      .where(sql`${table.status} <> 'closed'`),
    check(
      "wa_conversations_status_check",
      sql`${table.status} IN ('open', 'human', 'closed')`,
    ),
  ],
);

// Mensagens são histórico: FKs RESTRICT impedem apagar conversa/pedido com
// mensagens. dedupe_key UNIQUE dá idempotência no envio (retry do outbox);
// zapi_message_id UNIQUE dá idempotência nos webhooks de status.
export const waMessages = pgTable(
  "wa_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => waConversations.id, { onDelete: "restrict" }),
    direction: text("direction").notNull(),
    zapiMessageId: text("zapi_message_id").unique(),
    body: text("body").notNull(),
    templateKey: text("template_key"),
    dedupeKey: text("dedupe_key").unique(),
    status: text("status").notNull().default("queued"),
    outboxEventId: uuid("outbox_event_id"),
    orderId: uuid("order_id").references(() => orders.id, {
      onDelete: "restrict",
    }),
    errorDetail: text("error_detail"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    readAt: timestamp("read_at", { withTimezone: true }),
  },
  (table) => [
    index("wa_messages_conversation_id_idx").on(table.conversationId),
    index("wa_messages_status_idx").on(table.status),
    check(
      "wa_messages_direction_check",
      sql`${table.direction} IN ('inbound', 'outbound')`,
    ),
    check(
      "wa_messages_status_check",
      sql`${table.status} IN ('queued', 'sent', 'delivered', 'read', 'failed')`,
    ),
  ],
);

// Templates editáveis pelo dono no admin; variables lista os nomes das
// chaves {{...}} disponíveis no corpo (render em src/core/whatsapp/render.ts).
export const waTemplates = pgTable("wa_templates", {
  key: text("key").primaryKey(),
  label: text("label").notNull(),
  bodyTemplate: text("body_template").notNull(),
  variables: jsonb("variables").notNull().default([]),
  isActive: boolean("is_active").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
