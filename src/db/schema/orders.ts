import {
  bigint,
  bigserial,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { coupons } from "./coupons";
import { customers } from "./customers";
import { productVariants } from "./catalog";
import { priceVersions } from "./pricing";

export const orders = pgTable(
  "orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Número legível para o dono citar ("#1042"); sequência começa em 1000
    // (migração fase1_guards).
    orderNumber: bigserial("order_number", { mode: "number" })
      .unique()
      .notNull(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    status: text("status").notNull().default("draft"),
    channel: text("channel").notNull().default("manual"),
    // Rastreio público da loja: a página /pedido/[token] mostra status SEM
    // dados pessoais (o link pode vazar em encaminhamento de WhatsApp).
    publicToken: uuid("public_token")
      .notNull()
      .unique()
      .default(sql`gen_random_uuid()`),
    // Prazo da reserva de estoque em pending_payment; expiração cancela e
    // devolve a reserva (setting stock_reservation_ttl_minutes).
    paymentDueAt: timestamp("payment_due_at", { withTimezone: true }),
    subtotalCents: bigint("subtotal_cents", { mode: "number" })
      .notNull()
      .default(0),
    discountCents: bigint("discount_cents", { mode: "number" })
      .notNull()
      .default(0),
    // Cupom aplicado no checkout. coupon_code é SNAPSHOT (sobrevive à exclusão
    // do cupom — FK SET NULL); o valor efetivo do desconto fica em
    // discount_cents, calculado no momento do pedido.
    couponId: uuid("coupon_id").references(() => coupons.id, {
      onDelete: "set null",
    }),
    couponCode: text("coupon_code"),
    shippingCents: bigint("shipping_cents", { mode: "number" })
      .notNull()
      .default(0),
    totalCents: bigint("total_cents", { mode: "number" }).notNull().default(0),
    paymentMethod: text("payment_method"),
    // Última preference do Checkout Pro criada para este pedido. O init_point
    // NÃO é recuperável depois — recriamos a preference a cada "Pagar agora"
    // e este campo guarda apenas a mais recente (idempotência de pagamento
    // vem do external_reference = orders.id, não da preference).
    mpPreferenceId: text("mp_preference_id"),
    mpPaymentId: text("mp_payment_id"),
    mpFeeCents: bigint("mp_fee_cents", { mode: "number" }),
    installments: integer("installments"),
    // Snapshot do endereço no momento do pedido.
    shippingAddress: jsonb("shipping_address"),
    shippingTrackingCode: text("shipping_tracking_code"),
    /**
     * Entrega por motoboy: janela escolhida no fechamento {dayKey,start,end,cutoff,rateName,label}
     * + dispatchedAt (ISO) quando a peça saiu com o motoboy — é o que marca a saída de um
     * pedido em dinheiro na entrega, que só vira "paid" quando o dinheiro chega.
     */
    deliveryWindow: jsonb("delivery_window").$type<{
      dayKey: string;
      start: string;
      end: string;
      cutoff: string;
      rateName: string;
      label: string;
      dispatchedAt?: string;
    }>(),
    /** Data marcada: dia em que a peça precisa estar com a cliente (o presente com data também grava aqui). */
    neededBy: date("needed_by"),
    /** "aniversário da mãe", "Círio" — ≤ 60 caracteres. */
    occasion: text("occasion"),
    /** Dia-limite para a peça sair (needed_by − prazo máximo em dias úteis; motoboy = dia da janela). */
    shipBy: date("ship_by"),
    note: text("note"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    // Comprovante de pagamento em imagem (receipts/<id>/comprovante.jpg),
    // gerado quando o pagamento confirma; o dono abre pelo admin.
    receiptPath: text("receipt_path"),
    // Foto do pacote (packages/<id>/embalagem.jpg) tirada pelo dono ao
    // embalar; vai à cliente pelo WhatsApp e aparece na página do pedido.
    // UMA foto por pedido: refazer sobrescreve o mesmo path.
    packagePhotoPath: text("package_photo_path"),
    packedAt: timestamp("packed_at", { withTimezone: true }),
    // Presente (Onda 4): para quem é, o bilhete que a compradora escreveu
    // (≤ 280), a data desejada (só informativa) e a imagem do bilhete
    // publicada em gifts/<id>/bilhete.jpg. Presente = sem preço no pacote.
    isGift: boolean("is_gift").notNull().default(false),
    giftRecipientName: text("gift_recipient_name"),
    giftMessage: text("gift_message"),
    giftDeliverBy: date("gift_deliver_by"),
    giftNotePath: text("gift_note_path"),
    // Cartões da edição (Onda 5): um por peça do pedido, publicados em
    // editions/<orderId>/<productId>.jpg (por id, não slug: sobrevive a
    // renome) quando a dona gera; o carimbo é o cache-busting do "Imprimir"
    // e diz ao painel que já existem. A impressão digital é o hash do que
    // foi desenhado: se o que o cartão diria hoje é outro, ele ficou velho
    // (o updated_at da peça sobe por gatilho a cada UPDATE e não serve).
    editionCardsAt: timestamp("edition_cards_at", { withTimezone: true }),
    editionCardsFingerprint: jsonb("edition_cards_fingerprint").$type<Record<string, string>>(),
    shippedAt: timestamp("shipped_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    /** Foto da entrega (pacote na mão da cliente/portaria): deliveries/<orderId>/entrega.jpg. */
    deliveredPhotoPath: text("delivered_photo_path"),
    /** Quem recebeu (só o primeiro nome; aparece na página pública do pedido). */
    receivedBy: text("received_by"),
    /** Quem confirmou a entrega: a dona (owner), a cliente (customer) ou a Lia. */
    deliveryConfirmedBy: text("delivery_confirmed_by"),
    canceledAt: timestamp("canceled_at", { withTimezone: true }),
    cancelReason: text("cancel_reason"),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("orders_status_idx").on(table.status),
    check(
      "orders_gift_message_len_check",
      sql`${table.giftMessage} IS NULL OR char_length(${table.giftMessage}) <= 280`,
    ),
    index("orders_customer_id_idx").on(table.customerId),
    index("orders_created_at_idx").on(table.createdAt),
    index("orders_payment_due_at_idx").on(table.paymentDueAt),
    // Rota do dia: pedidos com entrega por motoboy num dia (SP).
    index("orders_ship_by_idx").on(table.shipBy).where(sql`${table.shipBy} IS NOT NULL`),
    check("orders_occasion_length_check", sql`${table.occasion} IS NULL OR char_length(${table.occasion}) <= 60`),
    index("orders_delivery_window_day_idx")
      .on(sql`(${table.deliveryWindow}->>'dayKey')`)
      .where(sql`${table.deliveryWindow} IS NOT NULL`),
    uniqueIndex("orders_mp_payment_id_unique_idx")
      .on(table.mpPaymentId)
      .where(sql`${table.mpPaymentId} IS NOT NULL`),
    check("orders_received_by_check", sql`${table.receivedBy} IS NULL OR char_length(${table.receivedBy}) <= 60`),
    check(
      "orders_delivery_confirmed_by_check",
      sql`${table.deliveryConfirmedBy} IS NULL OR ${table.deliveryConfirmedBy} IN ('owner', 'customer', 'lia')`,
    ),
    check(
      "orders_status_check",
      sql`${table.status} IN ('draft', 'pending_payment', 'paid', 'preparing', 'shipped', 'delivered', 'canceled', 'refunded')`,
    ),
    check(
      "orders_channel_check",
      sql`${table.channel} IN ('store', 'whatsapp', 'manual')`,
    ),
    check(
      "orders_payment_method_check",
      sql`${table.paymentMethod} IN ('pix', 'credit_card', 'boleto', 'pix_manual', 'cash')`,
    ),
    check(
      "orders_total_consistency_check",
      sql`${table.totalCents} = ${table.subtotalCents} - ${table.discountCents} + ${table.shippingCents}`,
    ),
    check(
      "orders_amounts_non_negative_check",
      sql`${table.subtotalCents} >= 0 AND ${table.discountCents} >= 0 AND ${table.shippingCents} >= 0 AND ${table.totalCents} >= 0`,
    ),
  ],
);

export const orderItems = pgTable(
  "order_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "restrict" }),
    productVariantId: uuid("product_variant_id")
      .notNull()
      .references(() => productVariants.id, { onDelete: "restrict" }),
    skuSnapshot: text("sku_snapshot").notNull(),
    nameSnapshot: text("name_snapshot").notNull(),
    quantity: integer("quantity").notNull(),
    unitPriceCents: bigint("unit_price_cents", { mode: "number" }).notNull(),
    unitCostCents: bigint("unit_cost_cents", { mode: "number" }).notNull(),
    priceVersionId: uuid("price_version_id").references(() => priceVersions.id, {
      onDelete: "restrict",
    }),
    totalCents: bigint("total_cents", { mode: "number" }).notNull(),
  },
  (table) => [
    index("order_items_order_id_idx").on(table.orderId),
    index("order_items_product_variant_id_idx").on(table.productVariantId),
    index("order_items_price_version_id_idx").on(table.priceVersionId),
    check("order_items_quantity_check", sql`${table.quantity} > 0`),
    check(
      "order_items_total_consistency_check",
      sql`${table.totalCents} = ${table.unitPriceCents} * ${table.quantity}`,
    ),
  ],
);

export const orderStatusHistory = pgTable(
  "order_status_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "restrict" }),
    fromStatus: text("from_status"),
    toStatus: text("to_status").notNull(),
    changedBy: uuid("changed_by"),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("order_status_history_order_id_created_at_idx").on(
      table.orderId,
      table.createdAt,
    ),
  ],
);
