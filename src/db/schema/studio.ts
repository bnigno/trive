// Ensaio "foto no corpo": as fotos-base das modelos da casa (uma escolhida
// por modelo × cena × corpo), os pedidos de ensaio de uma peça e as
// candidatas que cada pedido gerou (aprovadas ou não pelo portão de
// fidelidade). A escolhida vira product_images com origin = 'ai'; a
// proveniência e o custo ficam aqui e no audit_log, mesmo que a loja não
// rotule a foto.
import { sql } from "drizzle-orm";
import { bigint, boolean, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { productImages, products } from "./catalog";
import { users } from "./governance";

export const STUDIO_BASE_PHOTO_STATUSES = ["candidate", "chosen", "discarded"] as const;
export const STUDIO_REQUEST_STATUSES = ["queued", "done", "failed"] as const;
export const STUDIO_REQUEST_SOURCES = ["admin", "atelier", "auto"] as const;
export const STUDIO_CANDIDATE_STATUSES = ["candidate", "rejected", "chosen", "discarded", "failed"] as const;

export const studioBasePhotos = pgTable(
  "studio_base_photos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    modelKey: text("model_key").notNull(),
    sceneKey: text("scene_key").notNull(),
    sizeKey: text("size_key").notNull(),
    storagePath: text("storage_path").notNull(),
    status: text("status").notNull().default("candidate"),
    vendor: text("vendor").notNull(),
    vendorModel: text("vendor_model").notNull(),
    seed: bigint("seed", { mode: "number" }),
    credits: integer("credits").notNull().default(0),
    usdCents: integer("usd_cents").notNull().default(0),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    chosenAt: timestamp("chosen_at", { withTimezone: true }),
  },
  (table) => [
    index("studio_base_photos_keys_idx").on(table.modelKey, table.sceneKey, table.sizeKey),
    // Uma foto-base escolhida por modelo × cena × corpo: o árbitro é o banco.
    uniqueIndex("studio_base_photos_chosen_unique_idx")
      .on(table.modelKey, table.sceneKey, table.sizeKey)
      .where(sql`${table.status} = 'chosen'`),
    check("studio_base_photos_status_check", sql`${table.status} IN ('candidate', 'chosen', 'discarded')`),
  ],
);

export const studioRequests = pgTable(
  "studio_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    /** Cor da grade (valor normalizado); NULL = peça sem eixo de cor. */
    color: text("color"),
    sceneKey: text("scene_key").notNull(),
    modelKey: text("model_key").notNull(),
    sizeKey: text("size_key").notNull(),
    quality: text("quality").notNull(),
    optionsWanted: integer("options_wanted").notNull(),
    /** Opções que chegaram a um fim (aprovada, reprovada sem nova tentativa ou falha). */
    optionsDone: integer("options_done").notNull().default(0),
    status: text("status").notNull().default("queued"),
    source: text("source").notNull().default("admin"),
    requestedBy: uuid("requested_by").references(() => users.id, { onDelete: "set null" }),
    usdCentsSpent: integer("usd_cents_spent").notNull().default(0),
    errorDetail: text("error_detail"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    index("studio_requests_product_id_created_at_idx").on(table.productId, table.createdAt),
    check("studio_requests_status_check", sql`${table.status} IN ('queued', 'done', 'failed')`),
    check("studio_requests_source_check", sql`${table.source} IN ('admin', 'atelier', 'auto')`),
    check("studio_requests_quality_check", sql`${table.quality} IN ('economica', 'alta')`),
    check("studio_requests_options_check", sql`${table.optionsWanted} BETWEEN 1 AND 4`),
  ],
);

export const studioCandidates = pgTable(
  "studio_candidates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => studioRequests.id, { onDelete: "cascade" }),
    optionNo: integer("option_no").notNull(),
    attempt: integer("attempt").notNull().default(0),
    /** NULL quando o vendor falhou antes de devolver imagem. */
    storagePath: text("storage_path"),
    /** O JSON do portão; NULL = sem julgamento (portão indisponível ou falha antes dele). */
    judgment: jsonb("judgment"),
    score: integer("score"),
    passed: boolean("passed").notNull().default(false),
    status: text("status").notNull().default("candidate"),
    vendor: text("vendor"),
    vendorModel: text("vendor_model"),
    seed: bigint("seed", { mode: "number" }),
    /** Geração + julgamento, em centavos de dólar. */
    usdCents: integer("usd_cents").notNull().default(0),
    chosenImageId: uuid("chosen_image_id").references(() => productImages.id, { onDelete: "set null" }),
    errorDetail: text("error_detail"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Handler idempotente: a mesma opção/tentativa nunca vira duas candidatas.
    uniqueIndex("studio_candidates_request_option_attempt_unique_idx").on(table.requestId, table.optionNo, table.attempt),
    index("studio_candidates_created_at_idx").on(table.createdAt),
    check("studio_candidates_status_check", sql`${table.status} IN ('candidate', 'rejected', 'chosen', 'discarded', 'failed')`),
  ],
);
