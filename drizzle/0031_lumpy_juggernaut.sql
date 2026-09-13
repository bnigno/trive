ALTER TABLE "orders" ADD COLUMN "delivery_window" jsonb;--> statement-breakpoint
ALTER TABLE "shipping_rates" ADD COLUMN "kind" text DEFAULT 'correios' NOT NULL;--> statement-breakpoint
ALTER TABLE "shipping_rates" ADD COLUMN "delivery_windows" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
CREATE INDEX "orders_delivery_window_day_idx" ON "orders" USING btree (("delivery_window"->>'dayKey')) WHERE "orders"."delivery_window" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "shipping_rates" ADD CONSTRAINT "shipping_rates_kind_check" CHECK ("shipping_rates"."kind" IN ('correios', 'motoboy'));