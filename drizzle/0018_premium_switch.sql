CREATE TABLE "stock_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_variant_id" uuid NOT NULL,
	"phone_e164" text NOT NULL,
	"customer_id" uuid,
	"conversation_id" uuid,
	"source" text NOT NULL,
	"consent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notified_at" timestamp with time zone,
	"notified_wa_message_id" uuid,
	"canceled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_alerts_source_check" CHECK ("stock_alerts"."source" IN ('lia', 'site', 'admin'))
);
--> statement-breakpoint
CREATE TABLE "stock_holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_variant_id" uuid NOT NULL,
	"phone_e164" text NOT NULL,
	"customer_id" uuid,
	"conversation_id" uuid,
	"quantity" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"reminder_sent_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"order_id" uuid,
	"created_by" text DEFAULT 'lia' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_holds_quantity_check" CHECK ("stock_holds"."quantity" BETWEEN 1 AND 2),
	CONSTRAINT "stock_holds_status_check" CHECK ("stock_holds"."status" IN ('active', 'expired', 'released', 'converted')),
	CONSTRAINT "stock_holds_created_by_check" CHECK ("stock_holds"."created_by" IN ('lia', 'admin'))
);
--> statement-breakpoint
ALTER TABLE "stock_alerts" ADD CONSTRAINT "stock_alerts_product_variant_id_product_variants_id_fk" FOREIGN KEY ("product_variant_id") REFERENCES "public"."product_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_alerts" ADD CONSTRAINT "stock_alerts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_alerts" ADD CONSTRAINT "stock_alerts_conversation_id_wa_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."wa_conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_holds" ADD CONSTRAINT "stock_holds_product_variant_id_product_variants_id_fk" FOREIGN KEY ("product_variant_id") REFERENCES "public"."product_variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_holds" ADD CONSTRAINT "stock_holds_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_holds" ADD CONSTRAINT "stock_holds_conversation_id_wa_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."wa_conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_holds" ADD CONSTRAINT "stock_holds_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "stock_alerts_open_idx" ON "stock_alerts" USING btree ("product_variant_id","phone_e164") WHERE "stock_alerts"."notified_at" IS NULL AND "stock_alerts"."canceled_at" IS NULL;--> statement-breakpoint
CREATE INDEX "stock_alerts_variant_idx" ON "stock_alerts" USING btree ("product_variant_id");--> statement-breakpoint
CREATE INDEX "stock_alerts_phone_idx" ON "stock_alerts" USING btree ("phone_e164");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_holds_active_phone_idx" ON "stock_holds" USING btree ("phone_e164") WHERE "stock_holds"."status" = 'active';--> statement-breakpoint
CREATE INDEX "stock_holds_variant_status_idx" ON "stock_holds" USING btree ("product_variant_id","status");--> statement-breakpoint
CREATE INDEX "stock_holds_expires_at_idx" ON "stock_holds" USING btree ("expires_at");