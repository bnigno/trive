CREATE TABLE "site_carts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"source" text NOT NULL,
	"campaign_slug" text,
	"product_id" uuid,
	"variant_sku" text,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"conversation_id" uuid,
	"order_id" uuid,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "site_carts_source_check" CHECK ("site_carts"."source" IN ('pdp', 'cart', 'footer', 'campaign'))
);
--> statement-breakpoint
ALTER TABLE "site_carts" ADD CONSTRAINT "site_carts_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_carts" ADD CONSTRAINT "site_carts_conversation_id_wa_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."wa_conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_carts" ADD CONSTRAINT "site_carts_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "site_carts_code_open_unique_idx" ON "site_carts" USING btree ("code") WHERE "site_carts"."consumed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "site_carts_source_created_at_idx" ON "site_carts" USING btree ("source","created_at");--> statement-breakpoint
CREATE INDEX "site_carts_conversation_id_idx" ON "site_carts" USING btree ("conversation_id");