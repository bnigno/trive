import {
  boolean,
  char,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const customers = pgTable(
  "customers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fullName: text("full_name").notNull(),
    email: text("email"),
    phoneE164: text("phone_e164"),
    documentType: text("document_type"),
    // Só dígitos (CPF/CNPJ sem máscara).
    documentNumber: text("document_number"),
    notes: text("notes"),
    marketingOptIn: boolean("marketing_opt_in").notNull().default(false),
    anonymizedAt: timestamp("anonymized_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("customers_email_unique_idx")
      .on(table.email)
      .where(sql`${table.email} IS NOT NULL AND ${table.deletedAt} IS NULL`),
    uniqueIndex("customers_phone_e164_unique_idx")
      .on(table.phoneE164)
      .where(
        sql`${table.phoneE164} IS NOT NULL AND ${table.deletedAt} IS NULL`,
      ),
    uniqueIndex("customers_document_number_unique_idx")
      .on(table.documentNumber)
      .where(
        sql`${table.documentNumber} IS NOT NULL AND ${table.deletedAt} IS NULL`,
      ),
    check(
      "customers_phone_e164_check",
      sql`${table.phoneE164} ~ '^\\+[1-9][0-9]{7,14}$'`,
    ),
    check(
      "customers_document_type_check",
      sql`${table.documentType} IN ('cpf', 'cnpj')`,
    ),
  ],
);

export const customerAddresses = pgTable(
  "customer_addresses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    label: text("label"),
    postalCode: text("postal_code"),
    street: text("street"),
    number: text("number"),
    complement: text("complement"),
    district: text("district"),
    city: text("city"),
    state: char("state", { length: 2 }),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("customer_addresses_customer_id_idx").on(table.customerId)],
);
