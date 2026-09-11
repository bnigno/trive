CREATE TABLE "customer_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone_e164" text NOT NULL,
	"customer_id" uuid,
	"site_token" uuid DEFAULT gen_random_uuid() NOT NULL,
	"profile" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"palette_name" text,
	"source" text NOT NULL,
	"consent_at" timestamp with time zone,
	"forgotten_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_profiles_source_check" CHECK ("customer_profiles"."source" IN ('quiz', 'lia', 'admin', 'checkout'))
);
--> statement-breakpoint
ALTER TABLE "customer_profiles" ADD CONSTRAINT "customer_profiles_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_profiles_phone_active_idx" ON "customer_profiles" USING btree ("phone_e164") WHERE "customer_profiles"."forgotten_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_profiles_site_token_idx" ON "customer_profiles" USING btree ("site_token");--> statement-breakpoint
CREATE INDEX "customer_profiles_customer_id_idx" ON "customer_profiles" USING btree ("customer_id");