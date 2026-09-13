CREATE TABLE "drop_waitlist" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"drop_id" uuid NOT NULL,
	"phone_e164" text NOT NULL,
	"customer_id" uuid,
	"source" text DEFAULT 'site' NOT NULL,
	"consent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notified_at" timestamp with time zone,
	"notified_wa_message_id" uuid,
	"canceled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drop_waitlist_source_check" CHECK ("drop_waitlist"."source" IN ('site', 'lia', 'admin'))
);
--> statement-breakpoint
ALTER TABLE "drop_waitlist" ADD CONSTRAINT "drop_waitlist_drop_id_drops_id_fk" FOREIGN KEY ("drop_id") REFERENCES "public"."drops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drop_waitlist" ADD CONSTRAINT "drop_waitlist_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "drop_waitlist_open_idx" ON "drop_waitlist" USING btree ("drop_id","phone_e164") WHERE "drop_waitlist"."notified_at" IS NULL AND "drop_waitlist"."canceled_at" IS NULL;--> statement-breakpoint
CREATE INDEX "drop_waitlist_drop_idx" ON "drop_waitlist" USING btree ("drop_id");--> statement-breakpoint
CREATE INDEX "drop_waitlist_phone_idx" ON "drop_waitlist" USING btree ("phone_e164");