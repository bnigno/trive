CREATE TABLE "coupon_categories" (
	"coupon_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	CONSTRAINT "coupon_categories_coupon_id_category_id_pk" PRIMARY KEY("coupon_id","category_id")
);
--> statement-breakpoint
CREATE TABLE "coupon_products" (
	"coupon_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	CONSTRAINT "coupon_products_coupon_id_product_id_pk" PRIMARY KEY("coupon_id","product_id")
);
--> statement-breakpoint
CREATE TABLE "coupon_redemptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"coupon_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"customer_id" uuid,
	"phone_e164" text,
	"code" text NOT NULL,
	"discount_cents" bigint DEFAULT 0 NOT NULL,
	"shipping_discount_cents" bigint DEFAULT 0 NOT NULL,
	"applied_value" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	CONSTRAINT "coupon_redemptions_order_id_unique" UNIQUE("order_id"),
	CONSTRAINT "coupon_redemptions_amounts_check" CHECK ("coupon_redemptions"."discount_cents" >= 0 AND "coupon_redemptions"."shipping_discount_cents" >= 0),
	CONSTRAINT "coupon_redemptions_applied_value_check" CHECK ("coupon_redemptions"."applied_value" IS NULL OR "coupon_redemptions"."applied_value" > 0)
);
--> statement-breakpoint
ALTER TABLE "coupons" DROP CONSTRAINT "coupons_type_check";--> statement-breakpoint
ALTER TABLE "coupons" DROP CONSTRAINT "coupons_value_check";--> statement-breakpoint
ALTER TABLE "coupons" ADD COLUMN "origin" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "coupons" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "coupons" ADD COLUMN "per_customer_limit" integer;--> statement-breakpoint
ALTER TABLE "coupons" ADD COLUMN "customer_id" uuid;--> statement-breakpoint
ALTER TABLE "coupons" ADD COLUMN "phone_e164" text;--> statement-breakpoint
ALTER TABLE "coupons" ADD COLUMN "first_purchase_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "coupons" ADD COLUMN "free_shipping_scope" text DEFAULT 'any' NOT NULL;--> statement-breakpoint
ALTER TABLE "coupons" ADD COLUMN "valid_weekdays" jsonb;--> statement-breakpoint
ALTER TABLE "coupons" ADD COLUMN "valid_from_minute" smallint;--> statement-breakpoint
ALTER TABLE "coupons" ADD COLUMN "valid_to_minute" smallint;--> statement-breakpoint
ALTER TABLE "coupons" ADD COLUMN "dedupe_key" text;--> statement-breakpoint
ALTER TABLE "coupons" ADD COLUMN "order_id" uuid;--> statement-breakpoint
ALTER TABLE "coupons" ADD COLUMN "referrer_customer_id" uuid;--> statement-breakpoint
ALTER TABLE "coupon_categories" ADD CONSTRAINT "coupon_categories_coupon_id_coupons_id_fk" FOREIGN KEY ("coupon_id") REFERENCES "public"."coupons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_categories" ADD CONSTRAINT "coupon_categories_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_products" ADD CONSTRAINT "coupon_products_coupon_id_coupons_id_fk" FOREIGN KEY ("coupon_id") REFERENCES "public"."coupons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_products" ADD CONSTRAINT "coupon_products_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_coupon_id_coupons_id_fk" FOREIGN KEY ("coupon_id") REFERENCES "public"."coupons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "coupon_redemptions_coupon_created_idx" ON "coupon_redemptions" USING btree ("coupon_id","created_at");--> statement-breakpoint
CREATE INDEX "coupon_redemptions_customer_idx" ON "coupon_redemptions" USING btree ("customer_id") WHERE "coupon_redemptions"."customer_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "coupon_redemptions_active_by_customer_idx" ON "coupon_redemptions" USING btree ("coupon_id","customer_id") WHERE "coupon_redemptions"."released_at" IS NULL;--> statement-breakpoint
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_referrer_customer_id_customers_id_fk" FOREIGN KEY ("referrer_customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "coupons_dedupe_key_unique_idx" ON "coupons" USING btree ("dedupe_key") WHERE "coupons"."dedupe_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "coupons_customer_id_idx" ON "coupons" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "coupons_order_id_idx" ON "coupons" USING btree ("order_id");--> statement-breakpoint
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_origin_check" CHECK ("coupons"."origin" IN ('manual', 'late_delivery', 'price_protection', 'look_photo', 'paper_voucher', 'lia_gift', 'referral', 'referral_reward'));--> statement-breakpoint
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_note_check" CHECK ("coupons"."note" IS NULL OR char_length("coupons"."note") <= 500);--> statement-breakpoint
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_per_customer_limit_check" CHECK ("coupons"."per_customer_limit" IS NULL OR "coupons"."per_customer_limit" > 0);--> statement-breakpoint
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_phone_e164_check" CHECK ("coupons"."phone_e164" IS NULL OR "coupons"."phone_e164" ~ '^\+[1-9][0-9]{7,14}$');--> statement-breakpoint
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_free_shipping_scope_check" CHECK ("coupons"."free_shipping_scope" IN ('any', 'motoboy', 'correios'));--> statement-breakpoint
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_valid_minutes_check" CHECK (("coupons"."valid_from_minute" IS NULL AND "coupons"."valid_to_minute" IS NULL) OR ("coupons"."valid_from_minute" BETWEEN 0 AND 1439 AND "coupons"."valid_to_minute" BETWEEN 1 AND 1440 AND "coupons"."valid_from_minute" < "coupons"."valid_to_minute"));--> statement-breakpoint
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_type_check" CHECK ("coupons"."type" IN ('percent', 'fixed', 'free_shipping'));--> statement-breakpoint
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_value_check" CHECK (("coupons"."type" = 'free_shipping' AND "coupons"."value" = 0) OR ("coupons"."type" <> 'free_shipping' AND "coupons"."value" > 0));--> statement-breakpoint
-- Backfill (à mão): um resgate por pedido que já saiu com cupom. Pedido
-- cancelado sem nunca ter sido pago nasce já "devolvido" (released_at).
INSERT INTO "coupon_redemptions" ("coupon_id", "order_id", "customer_id", "phone_e164", "code", "discount_cents", "shipping_discount_cents", "created_at", "released_at")
SELECT o."coupon_id", o."id", o."customer_id", c."phone_e164", coalesce(o."coupon_code", cp."code"), o."discount_cents", 0, o."created_at",
       CASE WHEN o."status" = 'canceled' AND o."paid_at" IS NULL THEN coalesce(o."canceled_at", o."updated_at") ELSE NULL END
FROM "orders" o
JOIN "coupons" cp ON cp."id" = o."coupon_id"
LEFT JOIN "customers" c ON c."id" = o."customer_id"
WHERE o."coupon_id" IS NOT NULL
ON CONFLICT ("order_id") DO NOTHING;--> statement-breakpoint
-- used_count passa a ser "resgates ativos" (antes um uso nunca era devolvido).
UPDATE "coupons" cp SET "used_count" = (
  SELECT count(*) FROM "coupon_redemptions" r WHERE r."coupon_id" = cp."id" AND r."released_at" IS NULL
);
