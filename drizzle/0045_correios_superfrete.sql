CREATE TABLE "shipping_quotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text DEFAULT 'superfrete' NOT NULL,
	"request_key" text NOT NULL,
	"batch_id" uuid NOT NULL,
	"service_code" text NOT NULL,
	"name" text NOT NULL,
	"cep_from" char(8) NOT NULL,
	"cep_to" char(8) NOT NULL,
	"weight_grams" integer NOT NULL,
	"package" jsonb NOT NULL,
	"provider_price_cents" bigint NOT NULL,
	"surcharge_cents" bigint DEFAULT 0 NOT NULL,
	"price_cents" bigint NOT NULL,
	"delivery_days_min" integer NOT NULL,
	"delivery_days_max" integer NOT NULL,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "shipping_quotes_service_code_check" CHECK ("shipping_quotes"."service_code" IN ('1', '2')),
	CONSTRAINT "shipping_quotes_price_check" CHECK ("shipping_quotes"."provider_price_cents" >= 0 AND "shipping_quotes"."surcharge_cents" >= 0 AND "shipping_quotes"."price_cents" >= 0),
	CONSTRAINT "shipping_quotes_days_check" CHECK ("shipping_quotes"."delivery_days_min" <= "shipping_quotes"."delivery_days_max")
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "shipping_service" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "shipping_quote_id" uuid;--> statement-breakpoint
CREATE INDEX "shipping_quotes_request_key_idx" ON "shipping_quotes" USING btree ("request_key","created_at");--> statement-breakpoint
CREATE INDEX "shipping_quotes_expires_at_idx" ON "shipping_quotes" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_shipping_quote_id_shipping_quotes_id_fk" FOREIGN KEY ("shipping_quote_id") REFERENCES "public"."shipping_quotes"("id") ON DELETE set null ON UPDATE no action;