import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { productVariants } from "./catalog";
import { users } from "./governance";

// Append-only: UPDATE/DELETE bloqueados por trigger (migração fase1_guards).
export const variantCosts = pgTable(
  "variant_costs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productVariantId: uuid("product_variant_id")
      .notNull()
      .references(() => productVariants.id, { onDelete: "restrict" }),
    costCents: bigint("cost_cents", { mode: "number" }).notNull(),
    source: text("source").notNull(),
    note: text("note"),
    effectiveFrom: timestamp("effective_from", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "restrict",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("variant_costs_product_variant_id_idx").on(table.productVariantId),
    index("variant_costs_created_by_idx").on(table.createdBy),
    check(
      "variant_costs_source_check",
      sql`${table.source} IN ('manual', 'purchase', 'avg_calc')`,
    ),
  ],
);

// Vigente = effective_to IS NULL. Nunca editar taxa: encerra a vigência
// (preenche effective_to) e cria nova linha.
export const paymentFeeRules = pgTable(
  "payment_fee_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    paymentMethod: text("payment_method").notNull(),
    installmentsMax: integer("installments_max").notNull().default(1),
    percentRate: numeric("percent_rate", { precision: 7, scale: 4 }).notNull(),
    fixedFeeCents: bigint("fixed_fee_cents", { mode: "number" })
      .notNull()
      .default(0),
    settlementDays: integer("settlement_days").notNull().default(0),
    isReferenceForPricing: boolean("is_reference_for_pricing")
      .notNull()
      .default(false),
    effectiveFrom: timestamp("effective_from", { withTimezone: true })
      .notNull()
      .defaultNow(),
    effectiveTo: timestamp("effective_to", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "payment_fee_rules_payment_method_check",
      sql`${table.paymentMethod} IN ('pix', 'credit_card', 'boleto')`,
    ),
  ],
);

export const pricingPolicies = pgTable(
  "pricing_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    scopeType: text("scope_type").notNull().default("global"),
    scopeId: uuid("scope_id"),
    targetMarginRate: numeric("target_margin_rate", {
      precision: 7,
      scale: 4,
    }).notNull(),
    minMarginRate: numeric("min_margin_rate", {
      precision: 7,
      scale: 4,
    }).notNull(),
    otherCostsFixedCents: bigint("other_costs_fixed_cents", { mode: "number" })
      .notNull()
      .default(0),
    otherCostsRate: numeric("other_costs_rate", { precision: 7, scale: 4 })
      .notNull()
      .default("0"),
    roundingMode: text("rounding_mode").notNull().default("to_90"),
    roundingDirection: text("rounding_direction").notNull().default("up"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "pricing_policies_scope_type_check",
      sql`${table.scopeType} IN ('global', 'category', 'product', 'variant')`,
    ),
    check(
      "pricing_policies_rounding_mode_check",
      sql`${table.roundingMode} IN ('none', 'to_90', 'to_99', 'to_50', 'integer')`,
    ),
    check(
      "pricing_policies_rounding_direction_check",
      sql`${table.roundingDirection} IN ('up', 'nearest')`,
    ),
  ],
);

export const priceVersions = pgTable(
  "price_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productVariantId: uuid("product_variant_id")
      .notNull()
      .references(() => productVariants.id, { onDelete: "restrict" }),
    versionNumber: integer("version_number").notNull(),
    status: text("status").notNull().default("draft"),
    priceCents: bigint("price_cents", { mode: "number" }).notNull(),
    previousPriceCents: bigint("previous_price_cents", { mode: "number" }),
    compareAtPriceCents: bigint("compare_at_price_cents", { mode: "number" }),
    origin: text("origin").notNull().default("manual"),
    breakdown: jsonb("breakdown").notNull(),
    costSnapshotCents: bigint("cost_snapshot_cents", {
      mode: "number",
    }).notNull(),
    feeRuleId: uuid("fee_rule_id").references(() => paymentFeeRules.id, {
      onDelete: "restrict",
    }),
    policyId: uuid("policy_id").references(() => pricingPolicies.id, {
      onDelete: "restrict",
    }),
    computedMarginRate: numeric("computed_margin_rate", {
      precision: 7,
      scale: 4,
    }).notNull(),
    requiresApproval: boolean("requires_approval").notNull().default(false),
    approvalReasons: text("approval_reasons")
      .array()
      .default(sql`'{}'::text[]`),
    batchId: uuid("batch_id"),
    createdBy: uuid("created_by"),
    approvedBy: uuid("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    rejectedAt: timestamp("rejected_at", { withTimezone: true }),
    rejectionReason: text("rejection_reason"),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("price_versions_variant_version_unique").on(
      table.productVariantId,
      table.versionNumber,
    ),
    // CONSTRAINT CENTRAL DO PROJETO: no máximo um preço ativo por variante.
    uniqueIndex("price_versions_variant_active_unique_idx")
      .on(table.productVariantId)
      .where(sql`${table.status} = 'active'`),
    index("price_versions_status_idx").on(table.status),
    index("price_versions_batch_id_idx").on(table.batchId),
    index("price_versions_fee_rule_id_idx").on(table.feeRuleId),
    index("price_versions_policy_id_idx").on(table.policyId),
    check(
      "price_versions_status_check",
      sql`${table.status} IN ('draft', 'pending_approval', 'approved', 'active', 'rejected', 'superseded')`,
    ),
    check("price_versions_price_cents_check", sql`${table.priceCents} > 0`),
    check(
      "price_versions_origin_check",
      sql`${table.origin} IN ('manual', 'auto_cost_change', 'auto_fee_change', 'bulk_update', 'initial')`,
    ),
  ],
);
