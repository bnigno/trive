import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { customers } from "./customers";

// Thread por chave de agrupamento: no máximo UMA thread não-arquivada por
// thread_key (unique parcial) — é esse índice que permite o upsert do
// inbound. customer_id é SET NULL para a thread sobreviver à
// anonimização/remoção do cliente (LGPD) — o histórico fica sem vínculo.
export const emailThreads = pgTable(
  "email_threads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Derivada dos cabeçalhos References/In-Reply-To; sem eles, do assunto
    // normalizado (sem os prefixos Re:/Enc:/Fwd:).
    threadKey: text("thread_key").notNull(),
    subject: text("subject").notNull(),
    participantEmail: text("participant_email").notNull(),
    participantName: text("participant_name"),
    customerId: uuid("customer_id").references(() => customers.id, {
      onDelete: "set null",
    }),
    // open: na caixa de entrada do painel; archived: fora dela.
    status: text("status").notNull().default("open"),
    lastInboundAt: timestamp("last_inbound_at", { withTimezone: true }),
    lastOutboundAt: timestamp("last_outbound_at", { withTimezone: true }),
    // Marca d'água de não-lidas: mensagem posterior a este instante conta como
    // nova. Evita uma coluna is_read por mensagem (mesmo desenho de
    // wa_conversations.owner_last_seen_at). Atualizada SEM bumpar updated_at,
    // senão a lista reordenaria a cada leitura.
    ownerLastSeenAt: timestamp("owner_last_seen_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("email_threads_thread_key_active_unique_idx")
      .on(table.threadKey)
      .where(sql`${table.status} <> 'archived'`),
    check(
      "email_threads_status_check",
      sql`${table.status} IN ('open', 'archived')`,
    ),
  ],
);

// Mensagens são histórico: FK RESTRICT impede apagar thread com mensagens.
// message_id UNIQUE (o Message-ID da RFC 5322) dá idempotência na ingestão —
// reler a mesma caixa não duplica; dedupe_key UNIQUE dá idempotência no
// envio (retry do outbox).
export const emailMessages = pgTable(
  "email_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => emailThreads.id, { onDelete: "restrict" }),
    direction: text("direction").notNull(),
    messageId: text("message_id").unique(),
    inReplyTo: text("in_reply_to"),
    // Cadeia completa do cabeçalho References, do mais antigo ao mais recente.
    referencesIds: jsonb("references_ids").notNull().default([]),
    fromAddress: text("from_address").notNull(),
    fromName: text("from_name"),
    toAddresses: jsonb("to_addresses").notNull().default([]),
    ccAddresses: jsonb("cc_addresses").notNull().default([]),
    subject: text("subject").notNull(),
    textBody: text("text_body").notNull().default(""),
    htmlBody: text("html_body"),
    // Prévia curta já recortada para a lista do painel.
    snippet: text("snippet").notNull().default(""),
    // Cada item: { storagePath, filename, contentType, sizeBytes }.
    attachments: jsonb("attachments").notNull().default([]),
    dedupeKey: text("dedupe_key").unique(),
    status: text("status").notNull().default("queued"),
    providerMessageId: text("provider_message_id"),
    // UID do IMAP: cursor de ingestão da caixa de entrada.
    imapUid: integer("imap_uid"),
    errorDetail: text("error_detail"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (table) => [
    index("email_messages_thread_id_idx").on(table.threadId),
    index("email_messages_status_idx").on(table.status),
    check(
      "email_messages_direction_check",
      sql`${table.direction} IN ('inbound', 'outbound')`,
    ),
    check(
      "email_messages_status_check",
      sql`${table.status} IN ('queued', 'sent', 'failed')`,
    ),
  ],
);
