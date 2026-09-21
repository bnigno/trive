ALTER TABLE "coupons" ADD COLUMN "growth_per_redeemer" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "coupons" ADD COLUMN "growth_cap" integer;--> statement-breakpoint
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_growth_check" CHECK ("coupons"."growth_per_redeemer" >= 0 AND ("coupons"."growth_per_redeemer" = 0 OR "coupons"."growth_cap" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_growth_cap_check" CHECK ("coupons"."growth_cap" IS NULL OR ("coupons"."growth_cap" >= "coupons"."value" AND ("coupons"."type" <> 'percent' OR "coupons"."growth_cap" <= 100)));--> statement-breakpoint
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_one_mechanic_check" CHECK ("coupons"."value_schedule" IS NULL OR "coupons"."growth_per_redeemer" = 0);