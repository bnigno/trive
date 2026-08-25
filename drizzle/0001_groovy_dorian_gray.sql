CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"parent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "categories_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "product_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid,
	"storage_path" text NOT NULL,
	"alt_text" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"sku" text NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb,
	"barcode_ean" text,
	"weight_grams" integer,
	"length_mm" integer,
	"width_mm" integer,
	"height_mm" integer,
	"cost_cents" bigint DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "product_variants_sku_unique" UNIQUE("sku"),
	CONSTRAINT "product_variants_product_id_attributes_unique" UNIQUE("product_id","attributes")
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"category_id" uuid,
	"brand" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"attributes_schema" jsonb DEFAULT '[]'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "products_slug_unique" UNIQUE("slug"),
	CONSTRAINT "products_status_check" CHECK ("products"."status" IN ('draft', 'active', 'archived'))
);
--> statement-breakpoint
CREATE TABLE "customer_addresses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"label" text,
	"postal_code" text,
	"street" text,
	"number" text,
	"complement" text,
	"district" text,
	"city" text,
	"state" char(2),
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"full_name" text NOT NULL,
	"email" text,
	"phone_e164" text,
	"document_type" text,
	"document_number" text,
	"notes" text,
	"marketing_opt_in" boolean DEFAULT false NOT NULL,
	"anonymized_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "customers_phone_e164_check" CHECK ("customers"."phone_e164" ~ '^\+[1-9][0-9]{7,14}$'),
	CONSTRAINT "customers_document_type_check" CHECK ("customers"."document_type" IN ('cpf', 'cnpj'))
);
--> statement-breakpoint
CREATE TABLE "financial_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"direction" text NOT NULL,
	"category" text NOT NULL,
	"description" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"due_date" date,
	"settled_at" timestamp with time zone,
	"order_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "financial_entries_direction_check" CHECK ("financial_entries"."direction" IN ('receivable', 'payable')),
	CONSTRAINT "financial_entries_amount_cents_check" CHECK ("financial_entries"."amount_cents" > 0),
	CONSTRAINT "financial_entries_status_check" CHECK ("financial_entries"."status" IN ('pending', 'settled', 'canceled'))
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"product_variant_id" uuid NOT NULL,
	"sku_snapshot" text NOT NULL,
	"name_snapshot" text NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price_cents" bigint NOT NULL,
	"unit_cost_cents" bigint NOT NULL,
	"price_version_id" uuid,
	"total_cents" bigint NOT NULL,
	CONSTRAINT "order_items_quantity_check" CHECK ("order_items"."quantity" > 0),
	CONSTRAINT "order_items_total_consistency_check" CHECK ("order_items"."total_cents" = "order_items"."unit_price_cents" * "order_items"."quantity")
);
--> statement-breakpoint
CREATE TABLE "order_status_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"changed_by" uuid,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_number" bigserial NOT NULL,
	"customer_id" uuid NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"channel" text DEFAULT 'manual' NOT NULL,
	"subtotal_cents" bigint DEFAULT 0 NOT NULL,
	"discount_cents" bigint DEFAULT 0 NOT NULL,
	"shipping_cents" bigint DEFAULT 0 NOT NULL,
	"total_cents" bigint DEFAULT 0 NOT NULL,
	"payment_method" text,
	"mp_payment_id" text,
	"mp_fee_cents" bigint,
	"installments" integer,
	"shipping_address" jsonb,
	"shipping_tracking_code" text,
	"note" text,
	"paid_at" timestamp with time zone,
	"shipped_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"canceled_at" timestamp with time zone,
	"cancel_reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_order_number_unique" UNIQUE("order_number"),
	CONSTRAINT "orders_status_check" CHECK ("orders"."status" IN ('draft', 'pending_payment', 'paid', 'preparing', 'shipped', 'delivered', 'canceled', 'refunded')),
	CONSTRAINT "orders_channel_check" CHECK ("orders"."channel" IN ('store', 'whatsapp', 'manual')),
	CONSTRAINT "orders_payment_method_check" CHECK ("orders"."payment_method" IN ('pix', 'credit_card', 'boleto')),
	CONSTRAINT "orders_total_consistency_check" CHECK ("orders"."total_cents" = "orders"."subtotal_cents" - "orders"."discount_cents" + "orders"."shipping_cents"),
	CONSTRAINT "orders_amounts_non_negative_check" CHECK ("orders"."subtotal_cents" >= 0 AND "orders"."discount_cents" >= 0 AND "orders"."shipping_cents" >= 0 AND "orders"."total_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "payment_fee_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_method" text NOT NULL,
	"installments_max" integer DEFAULT 1 NOT NULL,
	"percent_rate" numeric(7, 4) NOT NULL,
	"fixed_fee_cents" bigint DEFAULT 0 NOT NULL,
	"settlement_days" integer DEFAULT 0 NOT NULL,
	"is_reference_for_pricing" boolean DEFAULT false NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"effective_to" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_fee_rules_payment_method_check" CHECK ("payment_fee_rules"."payment_method" IN ('pix', 'credit_card', 'boleto'))
);
--> statement-breakpoint
CREATE TABLE "price_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_variant_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"price_cents" bigint NOT NULL,
	"previous_price_cents" bigint,
	"compare_at_price_cents" bigint,
	"origin" text DEFAULT 'manual' NOT NULL,
	"breakdown" jsonb NOT NULL,
	"cost_snapshot_cents" bigint NOT NULL,
	"fee_rule_id" uuid,
	"policy_id" uuid,
	"computed_margin_rate" numeric(7, 4) NOT NULL,
	"requires_approval" boolean DEFAULT false NOT NULL,
	"approval_reasons" text[] DEFAULT '{}'::text[],
	"batch_id" uuid,
	"created_by" uuid,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"rejected_at" timestamp with time zone,
	"rejection_reason" text,
	"activated_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_versions_variant_version_unique" UNIQUE("product_variant_id","version_number"),
	CONSTRAINT "price_versions_status_check" CHECK ("price_versions"."status" IN ('draft', 'pending_approval', 'approved', 'active', 'rejected', 'superseded')),
	CONSTRAINT "price_versions_price_cents_check" CHECK ("price_versions"."price_cents" > 0),
	CONSTRAINT "price_versions_origin_check" CHECK ("price_versions"."origin" IN ('manual', 'auto_cost_change', 'auto_fee_change', 'bulk_update', 'initial'))
);
--> statement-breakpoint
CREATE TABLE "pricing_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"scope_type" text DEFAULT 'global' NOT NULL,
	"scope_id" uuid,
	"target_margin_rate" numeric(7, 4) NOT NULL,
	"min_margin_rate" numeric(7, 4) NOT NULL,
	"other_costs_fixed_cents" bigint DEFAULT 0 NOT NULL,
	"other_costs_rate" numeric(7, 4) DEFAULT '0' NOT NULL,
	"rounding_mode" text DEFAULT 'to_90' NOT NULL,
	"rounding_direction" text DEFAULT 'up' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pricing_policies_scope_type_check" CHECK ("pricing_policies"."scope_type" IN ('global', 'category', 'product', 'variant')),
	CONSTRAINT "pricing_policies_rounding_mode_check" CHECK ("pricing_policies"."rounding_mode" IN ('none', 'to_90', 'to_99', 'to_50', 'integer')),
	CONSTRAINT "pricing_policies_rounding_direction_check" CHECK ("pricing_policies"."rounding_direction" IN ('up', 'nearest'))
);
--> statement-breakpoint
CREATE TABLE "stock_levels" (
	"product_variant_id" uuid PRIMARY KEY NOT NULL,
	"on_hand" integer DEFAULT 0 NOT NULL,
	"reserved" integer DEFAULT 0 NOT NULL,
	"low_stock_threshold" integer DEFAULT 3 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_levels_on_hand_check" CHECK ("stock_levels"."on_hand" >= 0),
	CONSTRAINT "stock_levels_reserved_check" CHECK ("stock_levels"."reserved" >= 0),
	CONSTRAINT "stock_levels_available_check" CHECK (("stock_levels"."on_hand" - "stock_levels"."reserved") >= 0)
);
--> statement-breakpoint
CREATE TABLE "stock_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_variant_id" uuid NOT NULL,
	"type" text NOT NULL,
	"quantity_delta" integer NOT NULL,
	"unit_cost_cents" bigint,
	"reference_type" text,
	"reference_id" uuid,
	"idempotency_key" text,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_movements_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "stock_movements_type_check" CHECK ("stock_movements"."type" IN ('purchase_in', 'sale_out', 'reservation', 'reservation_release', 'adjustment', 'return_in', 'loss')),
	CONSTRAINT "stock_movements_quantity_delta_check" CHECK ("stock_movements"."quantity_delta" <> 0)
);
--> statement-breakpoint
CREATE TABLE "variant_costs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_variant_id" uuid NOT NULL,
	"cost_cents" bigint NOT NULL,
	"source" text NOT NULL,
	"note" text,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "variant_costs_source_check" CHECK ("variant_costs"."source" IN ('manual', 'purchase', 'avg_calc'))
);
--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_id_categories_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_addresses" ADD CONSTRAINT "customer_addresses_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_entries" ADD CONSTRAINT "financial_entries_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_product_variant_id_product_variants_id_fk" FOREIGN KEY ("product_variant_id") REFERENCES "public"."product_variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_price_version_id_price_versions_id_fk" FOREIGN KEY ("price_version_id") REFERENCES "public"."price_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_status_history" ADD CONSTRAINT "order_status_history_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_versions" ADD CONSTRAINT "price_versions_product_variant_id_product_variants_id_fk" FOREIGN KEY ("product_variant_id") REFERENCES "public"."product_variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_versions" ADD CONSTRAINT "price_versions_fee_rule_id_payment_fee_rules_id_fk" FOREIGN KEY ("fee_rule_id") REFERENCES "public"."payment_fee_rules"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_versions" ADD CONSTRAINT "price_versions_policy_id_pricing_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."pricing_policies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_levels" ADD CONSTRAINT "stock_levels_product_variant_id_product_variants_id_fk" FOREIGN KEY ("product_variant_id") REFERENCES "public"."product_variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_product_variant_id_product_variants_id_fk" FOREIGN KEY ("product_variant_id") REFERENCES "public"."product_variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variant_costs" ADD CONSTRAINT "variant_costs_product_variant_id_product_variants_id_fk" FOREIGN KEY ("product_variant_id") REFERENCES "public"."product_variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variant_costs" ADD CONSTRAINT "variant_costs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "categories_parent_id_idx" ON "categories" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "product_images_product_id_idx" ON "product_images" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "product_images_variant_id_idx" ON "product_images" USING btree ("variant_id");--> statement-breakpoint
CREATE INDEX "product_variants_product_id_idx" ON "product_variants" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "products_category_id_idx" ON "products" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "customer_addresses_customer_id_idx" ON "customer_addresses" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_email_unique_idx" ON "customers" USING btree ("email") WHERE "customers"."email" IS NOT NULL AND "customers"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "customers_phone_e164_unique_idx" ON "customers" USING btree ("phone_e164") WHERE "customers"."phone_e164" IS NOT NULL AND "customers"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "customers_document_number_unique_idx" ON "customers" USING btree ("document_number") WHERE "customers"."document_number" IS NOT NULL AND "customers"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "financial_entries_status_due_date_idx" ON "financial_entries" USING btree ("status","due_date");--> statement-breakpoint
CREATE INDEX "financial_entries_order_id_idx" ON "financial_entries" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "order_items_order_id_idx" ON "order_items" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "order_items_product_variant_id_idx" ON "order_items" USING btree ("product_variant_id");--> statement-breakpoint
CREATE INDEX "order_items_price_version_id_idx" ON "order_items" USING btree ("price_version_id");--> statement-breakpoint
CREATE INDEX "order_status_history_order_id_created_at_idx" ON "order_status_history" USING btree ("order_id","created_at");--> statement-breakpoint
CREATE INDEX "orders_status_idx" ON "orders" USING btree ("status");--> statement-breakpoint
CREATE INDEX "orders_customer_id_idx" ON "orders" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "orders_created_at_idx" ON "orders" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_mp_payment_id_unique_idx" ON "orders" USING btree ("mp_payment_id") WHERE "orders"."mp_payment_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "price_versions_variant_active_unique_idx" ON "price_versions" USING btree ("product_variant_id") WHERE "price_versions"."status" = 'active';--> statement-breakpoint
CREATE INDEX "price_versions_status_idx" ON "price_versions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "price_versions_batch_id_idx" ON "price_versions" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "price_versions_fee_rule_id_idx" ON "price_versions" USING btree ("fee_rule_id");--> statement-breakpoint
CREATE INDEX "price_versions_policy_id_idx" ON "price_versions" USING btree ("policy_id");--> statement-breakpoint
CREATE INDEX "stock_movements_product_variant_id_created_at_idx" ON "stock_movements" USING btree ("product_variant_id","created_at");--> statement-breakpoint
CREATE INDEX "variant_costs_product_variant_id_idx" ON "variant_costs" USING btree ("product_variant_id");--> statement-breakpoint
CREATE INDEX "variant_costs_created_by_idx" ON "variant_costs" USING btree ("created_by");