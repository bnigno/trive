import {
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

// Cartela de estilo ("espelho de estilo"): tamanhos, cores, caimento,
// ocasiões e para quem compra — o que a cliente contou no quiz da vitrine,
// à vendedora ou ao dono. Identidade sem login = telefone E.164 (UNIQUE
// parcial enquanto não "esquecida"); site_token é a chave do navegador;
// consent_at nunca rebaixa; "esquecer" zera os campos e carimba forgotten_at.
export const customerProfiles = pgTable(
  "customer_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    phoneE164: text("phone_e164").notNull(),
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "set null" }),
    siteToken: uuid("site_token").notNull().defaultRandom(),
    profile: jsonb("profile").notNull().default({}),
    paletteName: text("palette_name"),
    source: text("source").notNull(),
    consentAt: timestamp("consent_at", { withTimezone: true }),
    /** Medidas do corpo (busto/cintura/quadril em cm) — coluna própria, fora do perfil de estilo; nunca no histórico da Lia. */
    bodyMeasurements: jsonb("body_measurements"),
    bodyMeasuredAt: timestamp("body_measured_at", { withTimezone: true }),
    /** Credencial própria das medidas: sai UMA vez para o navegador que gravou (o token da cartela não prova posse). */
    bodyToken: uuid("body_token"),
    forgottenAt: timestamp("forgotten_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("customer_profiles_phone_active_idx")
      .on(table.phoneE164)
      .where(sql`${table.forgottenAt} IS NULL`),
    uniqueIndex("customer_profiles_site_token_idx").on(table.siteToken),
    index("customer_profiles_customer_id_idx").on(table.customerId),
    check("customer_profiles_source_check", sql`${table.source} IN ('quiz', 'lia', 'admin', 'checkout')`),
  ],
);
