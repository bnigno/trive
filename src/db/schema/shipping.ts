import {
  bigint,
  boolean,
  char,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// Tabela de frete por faixa de CEP e peso. O cálculo escolhe a regra ativa
// cuja faixa contém o CEP do cliente e o peso total do pedido, ordenando por
// sort_order (menor primeiro) para desempatar.
export const shippingRates = pgTable(
  "shipping_rates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    // Faixa de CEP em dígitos (sem hífen); padrão cobre o Brasil inteiro.
    cepStart: char("cep_start", { length: 8 }).notNull().default("00000000"),
    cepEnd: char("cep_end", { length: 8 }).notNull().default("99999999"),
    weightMinGrams: integer("weight_min_grams").notNull().default(0),
    weightMaxGrams: integer("weight_max_grams").notNull().default(30000),
    priceCents: bigint("price_cents", { mode: "number" }).notNull(),
    deliveryDaysMin: integer("delivery_days_min").notNull().default(3),
    deliveryDaysMax: integer("delivery_days_max").notNull().default(10),
    /** 'correios' (prazo em dias) ou 'motoboy' (janelas do dia com hora-limite). */
    kind: text("kind").notNull().default("correios"),
    /** Motoboy: [{start:'19:00', end:'21:00', cutoff:'13:00'}]; Correios: []. */
    deliveryWindows: jsonb("delivery_windows").$type<{ start: string; end: string; cutoff: string }[]>().notNull().default([]),
    isActive: boolean("is_active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("shipping_rates_is_active_idx").on(table.isActive),
    check("shipping_rates_kind_check", sql`${table.kind} IN ('correios', 'motoboy')`),
    check("shipping_rates_price_cents_check", sql`${table.priceCents} >= 0`),
    check(
      "shipping_rates_cep_range_check",
      sql`${table.cepStart} <= ${table.cepEnd}`,
    ),
    check(
      "shipping_rates_weight_range_check",
      sql`${table.weightMinGrams} <= ${table.weightMaxGrams}`,
    ),
  ],
);

/**
 * Cotações dos Correios vindas do provedor (SuperFrete): uma linha por
 * serviço (PAC/SEDEX) por chamada — as linhas da mesma chamada compartilham
 * `batch_id`. Servem de cache (a mesma pergunta em até 12 h reaproveita o
 * lote mais recente) e de referência do pedido: o id da linha é o `rateId`
 * que a sacola e a Lia carregam, e `orders.shipping_quote_id` aponta para
 * cá. `price_cents` = `provider_price_cents` + `surcharge_cents` (embalagem):
 * é o valor que a cliente vê e paga.
 */
export const shippingQuotes = pgTable(
  "shipping_quotes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider").notNull().default("superfrete"),
    /** superfrete|<cep_from>|<cep_to>|<peso_g>|<h>x<w>x<l>|s<acréscimo>|PAC,SEDEX — ver quoteRequestKey (core). */
    requestKey: text("request_key").notNull(),
    batchId: uuid("batch_id").notNull(),
    /** Códigos da SuperFrete: '1' = PAC, '2' = SEDEX. */
    serviceCode: text("service_code").notNull(),
    name: text("name").notNull(),
    cepFrom: char("cep_from", { length: 8 }).notNull(),
    cepTo: char("cep_to", { length: 8 }).notNull(),
    /** Peso COBRADO (já com o mínimo de 300 g), o mesmo enviado ao provedor. */
    weightGrams: integer("weight_grams").notNull(),
    package: jsonb("package").$type<{ heightCm: number; widthCm: number; lengthCm: number }>().notNull(),
    providerPriceCents: bigint("provider_price_cents", { mode: "number" }).notNull(),
    surchargeCents: bigint("surcharge_cents", { mode: "number" }).notNull().default(0),
    priceCents: bigint("price_cents", { mode: "number" }).notNull(),
    /** Dias úteis a partir da postagem. */
    deliveryDaysMin: integer("delivery_days_min").notNull(),
    deliveryDaysMax: integer("delivery_days_max").notNull(),
    /** O item bruto da resposta do provedor (auditoria da re-pesagem). */
    raw: jsonb("raw"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Até quando a cotação fecha pedido (24 h). */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("shipping_quotes_request_key_idx").on(table.requestKey, table.createdAt),
    index("shipping_quotes_expires_at_idx").on(table.expiresAt),
    check("shipping_quotes_service_code_check", sql`${table.serviceCode} IN ('1', '2')`),
    check(
      "shipping_quotes_price_check",
      sql`${table.providerPriceCents} >= 0 AND ${table.surchargeCents} >= 0 AND ${table.priceCents} >= 0`,
    ),
    check("shipping_quotes_days_check", sql`${table.deliveryDaysMin} <= ${table.deliveryDaysMax}`),
  ],
);
