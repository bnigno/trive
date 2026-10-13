// "Me vê com ela": a cliente manda a foto e a Lia devolve ela vestindo a
// peça (FASHN try-on). Uma linha por pedido de prévia, da oferta da Lia ao
// envio. NENHUMA imagem fica aqui nem no Storage: a foto dela é baixada da
// Z-API na hora do trabalho e a prévia vai embutida para a Z-API. O toque em
// "Quero me ver" é o consentimento DESTA prévia (accepted_at + versão do
// texto); nada vale para a próxima.
import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { products } from "./catalog";
import { customers } from "./customers";
import { waConversations, waMessages } from "./whatsapp";

/** Espelha TRYON_STATUSES do core (um teste prende os dois juntos). */
export const TRYON_REQUEST_STATUSES = [
  "offered",
  "declined",
  "awaiting_photo",
  "queued",
  "submitting",
  "processing",
  "sent",
  "photo_rejected",
  "failed",
] as const;

export const tryonRequests = pgTable(
  "tryon_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => waConversations.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "set null" }),
    phoneE164: text("phone_e164").notNull(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    color: text("color"),
    /** A mensagem com a foto dela (a fila baixa daí na hora; a imagem nunca é guardada). */
    photoWaMessageId: uuid("photo_wa_message_id").references(() => waMessages.id, { onDelete: "set null" }),
    status: text("status").notNull().default("offered"),
    /** Envios à FASHN (no máximo 2: a segunda só se a primeira saiu infiel). */
    attempts: integer("attempts").notNull().default(0),
    /** Id do pedido em andamento na FASHN: com ele, buscar de novo nunca paga de novo. */
    vendorJobId: text("vendor_job_id"),
    /** Créditos da FASHN gastos neste pedido (somando as tentativas). */
    credits: integer("credits").notNull().default(0),
    /** Gasto registrado em centavos de dólar (FASHN + portões). */
    usdCents: integer("usd_cents").notNull().default(0),
    /** O que a checagem viu na foto (pessoas, enquadramento…) — nunca a foto. */
    photoCheck: jsonb("photo_check"),
    /** Os portões da última tentativa (peça e pessoa). */
    verdict: jsonb("verdict"),
    /** Código do motivo quando terminou sem prévia (core/tryon/rules: TRYON_FAILURE_REASONS ou o problema da foto). */
    failureReason: text("failure_reason"),
    /** Versão do texto que ela aceitou ao tocar "Quero me ver". */
    consentVersion: text("consent_version"),
    offeredAt: timestamp("offered_at", { withTimezone: true }).notNull().defaultNow(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    declinedAt: timestamp("declined_at", { withTimezone: true }),
    queuedAt: timestamp("queued_at", { withTimezone: true }),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("tryon_requests_phone_created_at_idx").on(table.phoneE164, table.createdAt),
    index("tryon_requests_conversation_created_at_idx").on(table.conversationId, table.createdAt),
    index("tryon_requests_created_at_idx").on(table.createdAt),
    // Um pedido da FASHN = uma linha: o árbitro contra pagar duas vezes.
    uniqueIndex("tryon_requests_vendor_job_id_unique_idx").on(table.vendorJobId),
    // Uma prévia sendo feita por conversa de cada vez: o árbitro é o banco.
    uniqueIndex("tryon_requests_conversation_in_flight_unique_idx")
      .on(table.conversationId)
      .where(sql`${table.status} IN ('queued', 'submitting', 'processing')`),
    check(
      "tryon_requests_status_check",
      sql`${table.status} IN ('offered', 'declined', 'awaiting_photo', 'queued', 'submitting', 'processing', 'sent', 'photo_rejected', 'failed')`,
    ),
    check("tryon_requests_attempts_check", sql`${table.attempts} >= 0 AND ${table.attempts} <= 2`),
    check("tryon_requests_money_check", sql`${table.credits} >= 0 AND ${table.usdCents} >= 0`),
  ],
);
