// "Me ajuda a escolher?": a cliente em dúvida manda às amigas um link
// (/v/<token>) com 2 ou 3 peças; cada amiga vota com um toque. A rodada nasce
// SEMPRE numa conversa com a Lia (o placar volta por ela). A amiga não deixa
// telefone: `voter_key` é o hash de um identificador aleatório do aparelho
// dela (o UNIQUE barra o voto repetido) e tudo some 30 dias depois do fim.
import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { waConversations } from "./whatsapp";

export const friendRounds = pgTable(
  "friend_rounds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** O que vai no link público: longo e aleatório (não se adivinha a rodada de outra pessoa). */
    token: text("token").notNull().unique(),
    kind: text("kind").notNull().default("decisao"),
    /** A mensagem da cliente que pediu (lastInboundId do turno): o retry do turno reencontra a MESMA rodada. */
    createKey: text("create_key").notNull().unique(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => waConversations.id, { onDelete: "cascade" }),
    /** Primeiro nome como a cliente quis aparecer ("Qual fica melhor na Ana?"). */
    displayName: text("display_name").notNull(),
    /** [{productId, name, detail, slug, imagePath}] — retrato da peça na criação. */
    options: jsonb("options")
      .$type<{ productId: string; name: string; detail: string | null; slug: string; imagePath: string | null }[]>()
      .notNull(),
    closesAt: timestamp("closes_at", { withTimezone: true }).notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("friend_rounds_kind_check", sql`${table.kind} IN ('decisao')`),
    check("friend_rounds_display_name_check", sql`char_length(${table.displayName}) BETWEEN 1 AND 30`),
    index("friend_rounds_conversation_idx").on(table.conversationId, table.createdAt),
    index("friend_rounds_closes_at_idx").on(table.closesAt).where(sql`${table.closedAt} IS NULL`),
  ],
);

export const friendAnswers = pgTable(
  "friend_answers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    roundId: uuid("round_id")
      .notNull()
      .references(() => friendRounds.id, { onDelete: "cascade" }),
    /** sha256 do identificador aleatório do aparelho (nunca o telefone). */
    voterKey: text("voter_key").notNull(),
    choice: integer("choice").notNull(),
    note: text("note"),
    nickname: text("nickname"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("friend_answers_round_voter_unique_idx").on(table.roundId, table.voterKey),
    check("friend_answers_choice_check", sql`${table.choice} BETWEEN 0 AND 2`),
    check("friend_answers_note_check", sql`${table.note} IS NULL OR char_length(${table.note}) <= 140`),
    check("friend_answers_nickname_check", sql`${table.nickname} IS NULL OR char_length(${table.nickname}) <= 30`),
  ],
);
