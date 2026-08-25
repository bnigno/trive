CREATE TABLE "shipping_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"cep_start" char(8) DEFAULT '00000000' NOT NULL,
	"cep_end" char(8) DEFAULT '99999999' NOT NULL,
	"weight_min_grams" integer DEFAULT 0 NOT NULL,
	"weight_max_grams" integer DEFAULT 30000 NOT NULL,
	"price_cents" bigint NOT NULL,
	"delivery_days_min" integer DEFAULT 3 NOT NULL,
	"delivery_days_max" integer DEFAULT 10 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shipping_rates_price_cents_check" CHECK ("shipping_rates"."price_cents" >= 0),
	CONSTRAINT "shipping_rates_cep_range_check" CHECK ("shipping_rates"."cep_start" <= "shipping_rates"."cep_end"),
	CONSTRAINT "shipping_rates_weight_range_check" CHECK ("shipping_rates"."weight_min_grams" <= "shipping_rates"."weight_max_grams")
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "public_token" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "payment_due_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "shipping_rates_is_active_idx" ON "shipping_rates" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "orders_payment_due_at_idx" ON "orders" USING btree ("payment_due_at");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_public_token_unique" UNIQUE("public_token");