// Ateliê pelo WhatsApp: a dona manda fotos e um recado do celular dela para
// o número da maison e a peça nasce em rascunho, com as fotos. Cada linha é
// uma "chegada": o recado que disparou (trigger, UNIQUE — a reentrega do
// webhook não cria duas), as fotos do lote e o produto que saiu daí. O
// recado interpretado (grade, custo, fornecedor) entra em `parsed` (C-B).
import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { products } from "./catalog";
import { financialEntries } from "./financial";
import { suppliers } from "./suppliers";
import { waConversations, waMessages } from "./whatsapp";

export const atelierIntakes = pgTable(
  "atelier_intakes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => waConversations.id, { onDelete: "restrict" }),
    /** A mensagem que fechou o lote: o recado (texto, áudio transcrito ou legenda da foto). */
    triggerWaMessageId: uuid("trigger_wa_message_id")
      .notNull()
      .unique()
      .references(() => waMessages.id, { onDelete: "restrict" }),
    noteKind: text("note_kind").notNull().default("text"),
    note: text("note").notNull().default(""),
    /** ids de wa_messages das fotos desta chegada — reivindicadas ao abrir (nenhuma outra chegada as usa). */
    photoWaMessageIds: jsonb("photo_wa_message_ids").$type<string[]>().notNull().default([]),
    /** Das fotos acima, as que já entraram na ficha (a retomada sobe só o que falta). */
    uploadedWaMessageIds: jsonb("uploaded_wa_message_ids").$type<string[]>().notNull().default([]),
    photosCount: integer("photos_count").notNull().default(0),
    status: text("status").notNull().default("queued"),
    productId: uuid("product_id").references(() => products.id, { onDelete: "set null" }),
    /** Proposta interpretada do recado (C-B): grade, custo, fornecedor, uso do modelo. */
    parsed: jsonb("parsed"),
    /** A compra que a chegada virou (C-C): fornecedor, conta a pagar e o cartão enviado à dona. */
    supplierId: uuid("supplier_id").references(() => suppliers.id, { onDelete: "restrict" }),
    financialEntryId: uuid("financial_entry_id").references(() => financialEntries.id, { onDelete: "restrict" }),
    cardPath: text("card_path"),
    /** Quantas vezes a dona mandou refazer (entra nas chaves de dedupe de cada rodada). */
    redoCount: integer("redo_count").notNull().default(0),
    /** O rascunho arquivado pelo "Refazer": a rodada nova reaproveita as fotos dele (a URL da Z-API expira). */
    previousProductId: uuid("previous_product_id").references(() => products.id, { onDelete: "set null" }),
    errorDetail: text("error_detail"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (table) => [
    index("atelier_intakes_conversation_id_created_at_idx").on(table.conversationId, table.createdAt),
    index("atelier_intakes_product_id_idx").on(table.productId),
    check("atelier_intakes_status_check", sql`${table.status} IN ('queued', 'done', 'failed')`),
    check("atelier_intakes_note_kind_check", sql`${table.noteKind} IN ('text', 'audio', 'caption')`),
  ],
);

// Entrevista da curadora: uma pergunta por dia sobre uma peça, no WhatsApp
// da dona; a resposta (áudio ou "resposta: …") vira rascunho de nota e
// legendas, que só vão para a peça com o "ok" dela. `ask_key` é o árbitro do
// cron (um por dia; "agora:<id>" quando ela pede pelo painel) e o índice
// parcial garante UMA entrevista aberta por vez — a resposta nunca fica
// ambígua entre duas perguntas.
export const curatorInterviews = pgTable(
  "curator_interviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    askKey: text("ask_key").notNull().unique(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    questionKey: text("question_key").notNull(),
    question: text("question").notNull(),
    status: text("status").notNull().default("asked"),
    askedAt: timestamp("asked_at", { withTimezone: true }).notNull().defaultNow(),
    /** A mensagem da dona que respondeu (o áudio vira a voz da curadora no "ok voz"). */
    answerWaMessageId: uuid("answer_wa_message_id").references(() => waMessages.id, { onDelete: "set null" }),
    transcript: text("transcript"),
    draft: jsonb("draft").$type<{ note: string; captions: string[]; model?: string | null }>(),
    draftSentAt: timestamp("draft_sent_at", { withTimezone: true }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "curator_interviews_status_check",
      sql`${table.status} IN ('asked', 'drafting', 'draft_sent', 'approved', 'skipped', 'expired', 'failed')`,
    ),
    uniqueIndex("curator_interviews_one_open_idx")
      .on(sql`(true)`)
      .where(sql`${table.status} IN ('asked', 'drafting', 'draft_sent')`),
    index("curator_interviews_product_idx").on(table.productId, table.askedAt),
    index("curator_interviews_asked_at_idx").on(table.askedAt),
  ],
);
