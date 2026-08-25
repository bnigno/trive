CREATE TABLE "coupons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"type" text NOT NULL,
	"value" integer NOT NULL,
	"min_order_cents" bigint DEFAULT 0 NOT NULL,
	"starts_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"max_uses" integer,
	"used_count" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coupons_code_unique" UNIQUE("code"),
	CONSTRAINT "coupons_type_check" CHECK ("coupons"."type" IN ('percent', 'fixed')),
	CONSTRAINT "coupons_value_check" CHECK ("coupons"."value" > 0),
	CONSTRAINT "coupons_percent_range_check" CHECK ("coupons"."type" <> 'percent' OR "coupons"."value" <= 100),
	CONSTRAINT "coupons_min_order_check" CHECK ("coupons"."min_order_cents" >= 0),
	CONSTRAINT "coupons_used_count_check" CHECK ("coupons"."used_count" >= 0),
	CONSTRAINT "coupons_max_uses_check" CHECK ("coupons"."max_uses" IS NULL OR "coupons"."max_uses" > 0)
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "coupon_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "coupon_code" text;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_coupon_id_coupons_id_fk" FOREIGN KEY ("coupon_id") REFERENCES "public"."coupons"("id") ON DELETE set null ON UPDATE no action;