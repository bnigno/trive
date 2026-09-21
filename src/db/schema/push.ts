// Inscrições de Web Push do painel: uma por aparelho/navegador, presa ao
// usuário que ligou o aviso. O endpoint é a identidade da inscrição (o
// navegador troca o endpoint quando renova — o UPSERT reaproveita a linha).
// 404/410 no envio apaga a linha: a inscrição morreu (app desinstalado,
// permissão revogada, iOS que expirou).
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { users } from "./governance";

export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull().unique(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    /** Último envio aceito pelo servidor de push. */
    lastOkAt: timestamp("last_ok_at", { withTimezone: true }),
    /** Última falha transitória (texto curto) — diagnóstico, não decisão. */
    lastError: text("last_error"),
  },
  (table) => [index("push_subscriptions_user_id_idx").on(table.userId)],
);
