import {
  bigint,
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

// id mirrors Supabase auth.users.id — no defaultRandom on purpose.
export const users = pgTable("users", {
  id: uuid("id").primaryKey(),
  email: text("email").unique().notNull(),
  fullName: text("full_name"),
  role: text("role").notNull().default("staff"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedBy: uuid("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const auditLog = pgTable(
  "audit_log",
  {
    id: bigint("id", { mode: "number" })
      .generatedAlwaysAsIdentity()
      .primaryKey(),
    actorType: text("actor_type").notNull(),
    actorId: uuid("actor_id"),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    before: jsonb("before"),
    after: jsonb("after"),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("audit_log_entity_type_entity_id_created_at_idx").on(
      table.entityType,
      table.entityId,
      table.createdAt,
    ),
  ],
);
