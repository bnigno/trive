import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

export const outboxEvents = pgTable(
  "outbox_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventType: text("event_type").notNull(),
    aggregateType: text("aggregate_type"),
    aggregateId: uuid("aggregate_id"),
    payload: jsonb("payload").notNull().default({}),
    dedupeKey: text("dedupe_key").unique(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(8),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: text("locked_by"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (table) => [
    index("outbox_events_status_next_attempt_at_idx").on(
      table.status,
      table.nextAttemptAt,
    ),
    index("outbox_events_aggregate_type_aggregate_id_idx").on(
      table.aggregateType,
      table.aggregateId,
    ),
  ],
);

export const inboundEvents = pgTable(
  "inbound_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    source: text("source").notNull(),
    externalEventId: text("external_event_id").notNull(),
    eventType: text("event_type"),
    payload: jsonb("payload").notNull(),
    signatureValid: boolean("signature_valid"),
    status: text("status").notNull().default("received"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastError: text("last_error"),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (table) => [
    unique("inbound_events_source_external_event_id_unique").on(
      table.source,
      table.externalEventId,
    ),
  ],
);
