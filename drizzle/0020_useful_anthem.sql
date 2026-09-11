CREATE TABLE "drop_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"drop_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"phone_e164" text NOT NULL,
	"token" uuid DEFAULT gen_random_uuid() NOT NULL,
	"score" integer DEFAULT 0 NOT NULL,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sent_at" timestamp with time zone,
	"wa_message_id" uuid,
	"first_visit_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drop_products" (
	"drop_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	CONSTRAINT "drop_products_drop_id_product_id_pk" PRIMARY KEY("drop_id","product_id")
);
--> statement-breakpoint
CREATE TABLE "drops" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"publish_at" timestamp with time zone NOT NULL,
	"vip_window_hours" integer DEFAULT 24 NOT NULL,
	"audience_limit" integer DEFAULT 60 NOT NULL,
	"message_override" text,
	"vip_sent_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"canceled_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drops_status_check" CHECK ("drops"."status" IN ('draft', 'scheduled', 'vip_sent', 'published', 'canceled')),
	CONSTRAINT "drops_vip_window_hours_check" CHECK ("drops"."vip_window_hours" BETWEEN 1 AND 168),
	CONSTRAINT "drops_audience_limit_check" CHECK ("drops"."audience_limit" BETWEEN 1 AND 500)
);
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "visible_from" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "drop_invites" ADD CONSTRAINT "drop_invites_drop_id_drops_id_fk" FOREIGN KEY ("drop_id") REFERENCES "public"."drops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drop_invites" ADD CONSTRAINT "drop_invites_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drop_products" ADD CONSTRAINT "drop_products_drop_id_drops_id_fk" FOREIGN KEY ("drop_id") REFERENCES "public"."drops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drop_products" ADD CONSTRAINT "drop_products_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "drop_invites_drop_customer_idx" ON "drop_invites" USING btree ("drop_id","customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "drop_invites_token_idx" ON "drop_invites" USING btree ("token");--> statement-breakpoint
CREATE INDEX "drop_invites_customer_idx" ON "drop_invites" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "drop_products_product_idx" ON "drop_products" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "drops_status_publish_at_idx" ON "drops" USING btree ("status","publish_at");