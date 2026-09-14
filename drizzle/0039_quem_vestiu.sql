CREATE TABLE "customer_looks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid,
	"phone_e164" text NOT NULL,
	"product_id" uuid NOT NULL,
	"product_variant_id" uuid,
	"order_id" uuid,
	"display_name" text NOT NULL,
	"photo_wa_message_id" uuid,
	"photo_path" text,
	"card_path" text,
	"consent_answer" text,
	"consent_at" timestamp with time zone,
	"consent_wa_message_id" uuid,
	"approved_at" timestamp with time zone,
	"approved_by" uuid,
	"rejected_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_looks_display_name_len" CHECK (char_length("customer_looks"."display_name") <= 40),
	CONSTRAINT "customer_looks_consent_answer_check" CHECK ("customer_looks"."consent_answer" IS NULL OR "customer_looks"."consent_answer" IN ('sim', 'nao')),
	CONSTRAINT "customer_looks_revoked_by_check" CHECK ("customer_looks"."revoked_by" IS NULL OR "customer_looks"."revoked_by" IN ('customer', 'owner', 'lia', 'forget'))
);
--> statement-breakpoint
ALTER TABLE "customer_looks" ADD CONSTRAINT "customer_looks_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_looks" ADD CONSTRAINT "customer_looks_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_looks" ADD CONSTRAINT "customer_looks_product_variant_id_product_variants_id_fk" FOREIGN KEY ("product_variant_id") REFERENCES "public"."product_variants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_looks" ADD CONSTRAINT "customer_looks_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_looks" ADD CONSTRAINT "customer_looks_photo_wa_message_id_wa_messages_id_fk" FOREIGN KEY ("photo_wa_message_id") REFERENCES "public"."wa_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_looks" ADD CONSTRAINT "customer_looks_consent_wa_message_id_wa_messages_id_fk" FOREIGN KEY ("consent_wa_message_id") REFERENCES "public"."wa_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_looks" ADD CONSTRAINT "customer_looks_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_looks_product_public_idx" ON "customer_looks" USING btree ("product_id") WHERE "customer_looks"."consent_answer" = 'sim' AND "customer_looks"."approved_at" IS NOT NULL AND "customer_looks"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "customer_looks_phone_idx" ON "customer_looks" USING btree ("phone_e164");