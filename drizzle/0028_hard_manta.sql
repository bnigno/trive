CREATE TABLE "campaign_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"label" text NOT NULL,
	"product_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaign_links_slug_unique" UNIQUE("slug"),
	CONSTRAINT "campaign_links_slug_check" CHECK ("campaign_links"."slug" ~ '^[a-z0-9-]{2,40}$')
);
--> statement-breakpoint
ALTER TABLE "campaign_links" ADD CONSTRAINT "campaign_links_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "campaign_links_product_id_idx" ON "campaign_links" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "site_carts_campaign_slug_created_at_idx" ON "site_carts" USING btree ("campaign_slug","created_at");