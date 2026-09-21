import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { categories, products } from "./catalog";
import { customers } from "./customers";
import { orders } from "./orders";

// Cupons de desconto da loja. O código é armazenado SEMPRE em UPPERCASE
// (normalização no serviço) e é único. `value` depende do tipo:
//   - percent:       1..100 (percentual sobre o subtotal ELEGÍVEL, para baixo)
//   - fixed:         centavos (nunca desconta mais que o subtotal elegível)
//   - free_shipping: value = 0; o frete cobrado vira 0 (o perdoado fica no resgate)
// used_count = resgates ativos (coupon_redemptions sem released_at): o guard
// atômico de redeemCouponInTx segura o max_uses com pedidos simultâneos, e o
// cancelamento de um pedido nunca pago devolve o uso.
//
// A regra do que um cupom vale para uma sacola mora em core/coupons/evaluate.
export const COUPON_TYPES = ["percent", "fixed", "free_shipping"] as const;
export const FREE_SHIPPING_SCOPES = ["any", "motoboy", "correios"] as const;
// Quem emitiu o cupom: a dona (manual) ou uma rotina da casa. Os automáticos
// nascem com dedupe_key (o árbitro de "já emiti") e, quase sempre, com dono
// (customer_id) e pedido de origem (order_id).
export const COUPON_ORIGINS = [
  "manual",
  "late_delivery",
  "price_protection",
  "look_photo",
  "paper_voucher",
  "lia_gift",
  "referral",
  "referral_reward",
] as const;

export const coupons = pgTable(
  "coupons",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull().unique(),
    type: text("type").notNull(),
    value: integer("value").notNull(),
    minOrderCents: bigint("min_order_cents", { mode: "number" })
      .notNull()
      .default(0),
    startsAt: timestamp("starts_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    maxUses: integer("max_uses"),
    usedCount: integer("used_count").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    origin: text("origin").notNull().default("manual"),
    // Nota interna (motivo da gentileza, peça que baixou de preço…); nunca vai à cliente.
    note: text("note"),
    // Quantas vezes a MESMA cliente pode usar (NULL = sem limite; 1 = uma vez).
    perCustomerLimit: integer("per_customer_limit"),
    // Cupom pessoal: só esta cliente (por cadastro e/ou por telefone) usa.
    customerId: uuid("customer_id").references(() => customers.id, {
      onDelete: "restrict",
    }),
    phoneE164: text("phone_e164"),
    firstPurchaseOnly: boolean("first_purchase_only").notNull().default(false),
    freeShippingScope: text("free_shipping_scope").notNull().default("any"),
    // Janela de validade no relógio de São Paulo: dias da semana (0 = domingo…
    // 6 = sábado) e minutos do dia [de, até) — "chuva das duas" = 840..900.
    validWeekdays: jsonb("valid_weekdays").$type<number[]>(),
    validFromMinute: smallint("valid_from_minute"),
    validToMinute: smallint("valid_to_minute"),
    // Emissão automática: uma chave por evento ("late_delivery:<orderId>") —
    // a UNIQUE é quem garante que a rotina não emite duas vezes.
    dedupeKey: text("dedupe_key"),
    // Pedido que originou o cupom (atraso, proteção de preço, vale na caixa).
    orderId: uuid("order_id").references((): AnyPgColumn => orders.id, {
      onDelete: "set null",
    }),
    // Vale "para uma amiga": quem indicou (ganha o prêmio quando a amiga paga).
    referrerCustomerId: uuid("referrer_customer_id").references(() => customers.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("coupons_dedupe_key_unique_idx")
      .on(table.dedupeKey)
      .where(sql`${table.dedupeKey} IS NOT NULL`),
    index("coupons_customer_id_idx").on(table.customerId),
    index("coupons_order_id_idx").on(table.orderId),
    check(
      "coupons_type_check",
      sql`${table.type} IN ('percent', 'fixed', 'free_shipping')`,
    ),
    check(
      "coupons_value_check",
      sql`(${table.type} = 'free_shipping' AND ${table.value} = 0) OR (${table.type} <> 'free_shipping' AND ${table.value} > 0)`,
    ),
    check(
      "coupons_percent_range_check",
      sql`${table.type} <> 'percent' OR ${table.value} <= 100`,
    ),
    check("coupons_min_order_check", sql`${table.minOrderCents} >= 0`),
    check("coupons_used_count_check", sql`${table.usedCount} >= 0`),
    check(
      "coupons_max_uses_check",
      sql`${table.maxUses} IS NULL OR ${table.maxUses} > 0`,
    ),
    check(
      "coupons_origin_check",
      sql`${table.origin} IN ('manual', 'late_delivery', 'price_protection', 'look_photo', 'paper_voucher', 'lia_gift', 'referral', 'referral_reward')`,
    ),
    check(
      "coupons_note_check",
      sql`${table.note} IS NULL OR char_length(${table.note}) <= 500`,
    ),
    check(
      "coupons_per_customer_limit_check",
      sql`${table.perCustomerLimit} IS NULL OR ${table.perCustomerLimit} > 0`,
    ),
    check(
      "coupons_phone_e164_check",
      sql`${table.phoneE164} IS NULL OR ${table.phoneE164} ~ '^\\+[1-9][0-9]{7,14}$'`,
    ),
    check(
      "coupons_free_shipping_scope_check",
      sql`${table.freeShippingScope} IN ('any', 'motoboy', 'correios')`,
    ),
    check(
      "coupons_valid_minutes_check",
      sql`(${table.validFromMinute} IS NULL AND ${table.validToMinute} IS NULL) OR (${table.validFromMinute} BETWEEN 0 AND 1439 AND ${table.validToMinute} BETWEEN 1 AND 1440 AND ${table.validFromMinute} < ${table.validToMinute})`,
    ),
  ],
);

// Cupom restrito a peças: o desconto só incide sobre estas (o pedido pode ter outras).
export const couponProducts = pgTable(
  "coupon_products",
  {
    couponId: uuid("coupon_id")
      .notNull()
      .references(() => coupons.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
  },
  (table) => [primaryKey({ columns: [table.couponId, table.productId] })],
);

// Cupom restrito a categorias (só a categoria direta da peça; subcategoria não herda).
export const couponCategories = pgTable(
  "coupon_categories",
  {
    couponId: uuid("coupon_id")
      .notNull()
      .references(() => coupons.id, { onDelete: "cascade" }),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "restrict" }),
  },
  (table) => [primaryKey({ columns: [table.couponId, table.categoryId] })],
);

// Quem usou o cupom, em qual pedido e quanto valeu. Um resgate por pedido
// (UNIQUE). released_at marca o uso devolvido: o pedido foi cancelado sem
// nunca ter sido pago — a cliente não gastou o cupom de verdade.
export const couponRedemptions = pgTable(
  "coupon_redemptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    couponId: uuid("coupon_id")
      .notNull()
      .references(() => coupons.id, { onDelete: "restrict" }),
    orderId: uuid("order_id")
      .notNull()
      .unique()
      .references((): AnyPgColumn => orders.id, { onDelete: "restrict" }),
    customerId: uuid("customer_id").references(() => customers.id, {
      onDelete: "set null",
    }),
    phoneE164: text("phone_e164"),
    // Snapshot do código (o cupom pode ser renomeado ou some).
    code: text("code").notNull(),
    // Desconto sobre as peças e frete perdoado, em centavos.
    discountCents: bigint("discount_cents", { mode: "number" }).notNull().default(0),
    shippingDiscountCents: bigint("shipping_discount_cents", { mode: "number" })
      .notNull()
      .default(0),
    // O valor do cupom no momento do uso (10 = "10%", 2000 = R$ 20,00) — cupom
    // que muda com o tempo ou com a turma guarda aqui o que valeu.
    appliedValue: integer("applied_value"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    releasedAt: timestamp("released_at", { withTimezone: true }),
  },
  (table) => [
    index("coupon_redemptions_coupon_created_idx").on(table.couponId, table.createdAt),
    index("coupon_redemptions_customer_idx")
      .on(table.customerId)
      .where(sql`${table.customerId} IS NOT NULL`),
    index("coupon_redemptions_active_by_customer_idx")
      .on(table.couponId, table.customerId)
      .where(sql`${table.releasedAt} IS NULL`),
    check(
      "coupon_redemptions_amounts_check",
      sql`${table.discountCents} >= 0 AND ${table.shippingDiscountCents} >= 0`,
    ),
    check(
      "coupon_redemptions_applied_value_check",
      sql`${table.appliedValue} IS NULL OR ${table.appliedValue} > 0`,
    ),
  ],
);
