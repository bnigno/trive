import {
  check,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const suppliers = pgTable(
  "suppliers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    contactName: text("contact_name"),
    email: text("email"),
    phoneE164: text("phone_e164"),
    documentType: text("document_type"),
    // Só dígitos (CPF/CNPJ sem máscara).
    documentNumber: text("document_number"),
    // Chave Pix para PAGAR o fornecedor (não confundir com store_pix_key).
    pixKey: text("pix_key"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("suppliers_email_unique_idx")
      .on(table.email)
      .where(sql`${table.email} IS NOT NULL AND ${table.deletedAt} IS NULL`),
    uniqueIndex("suppliers_phone_e164_unique_idx")
      .on(table.phoneE164)
      .where(
        sql`${table.phoneE164} IS NOT NULL AND ${table.deletedAt} IS NULL`,
      ),
    uniqueIndex("suppliers_document_number_unique_idx")
      .on(table.documentNumber)
      .where(
        sql`${table.documentNumber} IS NOT NULL AND ${table.deletedAt} IS NULL`,
      ),
    check(
      "suppliers_phone_e164_check",
      sql`${table.phoneE164} ~ '^\\+[1-9][0-9]{7,14}$'`,
    ),
    check(
      "suppliers_document_type_check",
      sql`${table.documentType} IN ('cpf', 'cnpj')`,
    ),
  ],
);
