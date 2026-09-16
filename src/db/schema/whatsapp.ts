import {
  boolean,
  integer,
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
    // O ENDEREÇO de WhatsApp da conversa: E.164 ('+5591…') ou, quando o
    // WhatsApp esconde o número, o LID ('…@lid') — a Z-API entrega e aceita
    // os dois no campo `phone`. isWaLid() distingue.
    phoneE164: text("phone_e164").notNull(),
    // LID conhecido desta pessoa mesmo quando o endereço é o telefone: uma
    // mensagem que chegue só com o LID reencontra a conversa em vez de abrir outra.
    lid: text("lid"),
    customerId: uuid("customer_id").references(() => customers.id, {
      onDelete: "set null",
    }),
    // open: fluxo normal; human: dono assumiu a conversa; closed: encerrada.
    status: text("status").notNull().default("open"),
    // Contexto compacto do bot de vendas (endereço parcial, carrinho, etc.).
    botState: jsonb("bot_state"),
    // Silêncio do bot após transferir para atendente humano.
    botDisabledUntil: timestamp("bot_disabled_until", { withTimezone: true }),
    // Modo da vendedora SÓ nesta conversa (autonomous | copilot); null = o da loja (setting bot_mode).
    botMode: text("bot_mode"),
    lastInboundAt: timestamp("last_inbound_at", { withTimezone: true }),
    lastOutboundAt: timestamp("last_outbound_at", { withTimezone: true }),
    // Telemetria de leitura do painel: última vez que o dono viu esta thread.
    // Atualizada por markConversationSeen SEM bumpar updated_at (senão a
    // lista reordenaria a cada leitura). Sem índice: ~centenas de conversas.
    ownerLastSeenAt: timestamp("owner_last_seen_at", { withTimezone: true }),
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
    index("wa_conversations_lid_idx").on(table.lid),
    check(
      "wa_conversations_status_check",
      sql`${table.status} IN ('open', 'human', 'closed')`,
    ),
    check("wa_conversations_bot_mode_check", sql`${table.botMode} IS NULL OR ${table.botMode} IN ('autonomous', 'copilot')`),
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
    // text: mensagem comum; image: body é a legenda; option_list: body é o
    // texto da lista já renderizado com as opções (histórico do bot/admin);
    // audio: inbound da cliente, body é a transcrição (ou o marcador).
    kind: text("kind").notNull().default("text"),
    body: text("body").notNull(),
    // URL pública da mídia (imagem enviada; foto/áudio recebidos da Z-API).
    mediaUrl: text("media_url"),
    // Metadados da mídia recebida: mimeType, seconds, width/height e o
    // resultado da transcrição ({ status, ms, model, chars }).
    mediaMeta: jsonb("media_meta"),
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
    check(
      "wa_messages_kind_check",
      sql`${table.kind} IN ('text', 'image', 'option_list', 'audio')`,
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

// Cartões editoriais já renderizados (vitrine/look em imagem) — cache por
// chave determinística (sha256 das peças, fotos e preços): a mesma vitrine
// nunca é desenhada duas vezes. Só metadados; o JPEG vive no Storage.
export const botCards = pgTable("bot_cards", {
  key: text("key").primaryKey(),
  kind: text("kind").notNull(),
  storagePath: text("storage_path").notNull(),
  productSlugs: jsonb("product_slugs").notNull().default([]),
  renderMs: integer("render_ms"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
