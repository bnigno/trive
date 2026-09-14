ALTER TABLE "customer_profiles" ADD COLUMN "body_measurements" jsonb;--> statement-breakpoint
ALTER TABLE "customer_profiles" ADD COLUMN "body_measured_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customer_profiles" ADD COLUMN "body_token" uuid;