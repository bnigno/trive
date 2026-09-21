// Provador TRIVÉ — grupos de WhatsApp da marca. O grupo é o palco (3 posts
// rituais por semana: chegadas, enquete, quem vestiu); a venda acontece no
// privado com a Lia. Aqui ficam as salas, quem está nelas (sincronizado do
// metadata da Z-API), os posts agendados/enviados e os SINAIS que o grupo
// devolve (voto, reação, menção) — a matéria-prima da segmentação.
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { campaignLinks } from "./campaign-links";
import { cityEditions } from "./city-editions";
import { customers } from "./customers";
import { drops } from "./drops";
import { users } from "./governance";

export const WA_GROUP_KINDS = ["provador", "turma"] as const;
export type WaGroupKind = (typeof WA_GROUP_KINDS)[number];

export const WA_GROUP_POST_KINDS = ["chegadas", "enquete", "quem_vestiu", "cortina", "livre"] as const;
export type WaGroupPostKind = (typeof WA_GROUP_POST_KINDS)[number];

export const WA_GROUP_POST_STATUSES = ["draft", "scheduled", "sent", "skipped", "canceled"] as const;
export type WaGroupPostStatus = (typeof WA_GROUP_POST_STATUSES)[number];

export const WA_GROUP_SIGNAL_KINDS = ["poll_vote", "reaction", "mention", "message"] as const;
export type WaGroupSignalKind = (typeof WA_GROUP_SIGNAL_KINDS)[number];

export const WA_GROUP_MEMBER_SOURCES = ["lia", "link", "sync"] as const;
export type WaGroupMemberSource = (typeof WA_GROUP_MEMBER_SOURCES)[number];

export const waGroups = pgTable(
  "wa_groups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Id do grupo como a Z-API o entrega ('120363019502650977-group'). */
    providerGroupId: text("provider_group_id").notNull().unique(),
    name: text("name").notNull(),
    /** provador | turma */
    kind: text("kind").notNull().default("provador"),
    /** Sala de uma cidade/edição (Provador Belém); nula = geral. */
    cityEditionId: uuid("city_edition_id").references(() => cityEditions.id, { onDelete: "set null" }),
    /** Link de convite (só a Lia entrega, depois do opt-in). */
    invitationLink: text("invitation_link"),
    isActive: boolean("is_active").notNull().default(true),
    /** Kill switch: posts agendados até aqui ficam 'skipped' e a dona é avisada. */
    pausedUntil: timestamp("paused_until", { withTimezone: true }),
    pausedReason: text("paused_reason"),
    /** Última contagem vinda do metadata da Z-API. */
    memberCount: integer("member_count").notNull().default(0),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("wa_groups_active_idx").on(table.isActive),
    check("wa_groups_kind_check", sql`${table.kind} IN ('provador', 'turma')`),
    check("wa_groups_member_count_check", sql`${table.memberCount} >= 0`),
  ],
);

export const waGroupMembers = pgTable(
  "wa_group_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => waGroups.id, { onDelete: "cascade" }),
    /** Endereço como em wa_conversations: E.164 ('+5591…') ou LID ('…@lid'). */
    phoneE164: text("phone_e164").notNull(),
    /** LID à parte quando o metadata traz os dois. */
    lid: text("lid"),
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "set null" }),
    isAdmin: boolean("is_admin").notNull().default(false),
    /** lia (entrou pela porta da Lia) | link (entrou pelo link, sem passar pela Lia) | sync (já estava) */
    source: text("source").notNull().default("sync"),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
    leftAt: timestamp("left_at", { withTimezone: true }),
    /** saiu | removida | so_privado */
    leftReason: text("left_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Uma linha por pessoa e sala: voltar a entrar limpa left_at.
    uniqueIndex("wa_group_members_group_phone_idx").on(table.groupId, table.phoneE164),
    index("wa_group_members_phone_idx").on(table.phoneE164),
    index("wa_group_members_customer_idx").on(table.customerId),
    check("wa_group_members_source_check", sql`${table.source} IN ('lia', 'link', 'sync')`),
    check(
      "wa_group_members_left_reason_check",
      sql`${table.leftReason} IS NULL OR ${table.leftReason} IN ('saiu', 'removida', 'so_privado')`,
    ),
  ],
);

export const waGroupPosts = pgTable(
  "wa_group_posts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => waGroups.id, { onDelete: "cascade" }),
    /** chegadas | enquete | quem_vestiu | cortina | livre */
    kind: text("kind").notNull(),
    /** draft | scheduled | sent | skipped | canceled */
    status: text("status").notNull().default("draft"),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    /** O texto como sai no grupo (já renderizado; a pré-visualização do painel é ele). */
    body: text("body").notNull(),
    imageUrl: text("image_url"),
    /** Enquete: opções na ordem (2–12) e quantas cada pessoa marca. */
    pollOptions: jsonb("poll_options").$type<string[]>(),
    pollMaxOptions: smallint("poll_max_options"),
    /** Peças do post (chegadas/cortina): é por elas que a afinidade no privado é calculada. */
    productIds: jsonb("product_ids").$type<string[]>(),
    /** Looks de cliente do "quem vestiu". */
    lookIds: jsonb("look_ids").$type<string[]>(),
    dropId: uuid("drop_id").references(() => drops.id, { onDelete: "set null" }),
    /** Link rastreável do post: é ele que liga toques → conversas → pedidos em "De onde vieram". */
    campaignLinkId: uuid("campaign_link_id").references(() => campaignLinks.id, { onDelete: "set null" }),
    /** Id da mensagem no WhatsApp depois de enviada (reações e votos apontam para ele). */
    providerMessageId: text("provider_message_id"),
    /** Árbitro de duplicata do envio pela fila. */
    dedupeKey: text("dedupe_key").notNull().unique(),
    /** fora_da_cadencia | sala_pausada | sala_inativa | sem_peca | provedor */
    skippedReason: text("skipped_reason"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("wa_group_posts_group_status_idx").on(table.groupId, table.status, table.scheduledAt),
    uniqueIndex("wa_group_posts_provider_message_idx")
      .on(table.providerMessageId)
      .where(sql`${table.providerMessageId} IS NOT NULL`),
    check(
      "wa_group_posts_kind_check",
      sql`${table.kind} IN ('chegadas', 'enquete', 'quem_vestiu', 'cortina', 'livre')`,
    ),
    check(
      "wa_group_posts_status_check",
      sql`${table.status} IN ('draft', 'scheduled', 'sent', 'skipped', 'canceled')`,
    ),
    check(
      "wa_group_posts_poll_max_check",
      sql`${table.pollMaxOptions} IS NULL OR ${table.pollMaxOptions} BETWEEN 1 AND 12`,
    ),
  ],
);

export const waGroupSignals = pgTable(
  "wa_group_signals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => waGroups.id, { onDelete: "cascade" }),
    /** O post a que o sinal responde (voto na enquete, reação no post); nulo quando é conversa solta. */
    postId: uuid("post_id").references(() => waGroupPosts.id, { onDelete: "set null" }),
    /** Endereço de quem sinalizou: E.164 ou LID, como em wa_conversations. */
    participantPhone: text("participant_phone").notNull(),
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "set null" }),
    /** poll_vote | reaction | mention | message */
    kind: text("kind").notNull(),
    /**
     * poll_vote: opção escolhida (vazio = voto retirado); reaction: o emoji
     * (vazio = reação removida); mention: o texto da pergunta; message: vazio
     * (só o fato conta — LGPD: conversa de grupo não é guardada).
     */
    value: text("value").notNull().default(""),
    /** Id da mensagem do WhatsApp que trouxe o sinal (o evento do webhook). */
    providerMessageId: text("provider_message_id").notNull(),
    /** Enquete ou post a que o sinal se refere (pollMessageId / referencedMessage.messageId). */
    referencedMessageId: text("referenced_message_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // O último voto/reação da pessoa vale: uma linha por (mensagem referida,
    // pessoa, tipo) — votar na enquete E reagir a ela são dois sinais.
    uniqueIndex("wa_group_signals_vote_idx")
      .on(table.referencedMessageId, table.participantPhone, table.kind)
      .where(sql`${table.kind} IN ('poll_vote', 'reaction')`),
    // Menção e mensagem: o evento do webhook é único (replay não duplica).
    uniqueIndex("wa_group_signals_event_idx")
      .on(table.providerMessageId, table.kind)
      .where(sql`${table.kind} IN ('mention', 'message')`),
    index("wa_group_signals_group_kind_idx").on(table.groupId, table.kind, table.createdAt),
    index("wa_group_signals_post_idx").on(table.postId),
    index("wa_group_signals_participant_idx").on(table.participantPhone),
    check("wa_group_signals_kind_check", sql`${table.kind} IN ('poll_vote', 'reaction', 'mention', 'message')`),
  ],
);
