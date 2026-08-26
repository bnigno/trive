CREATE TABLE "email_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"message_id" text,
	"in_reply_to" text,
	"references_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"from_address" text NOT NULL,
	"from_name" text,
	"to_addresses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cc_addresses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"subject" text NOT NULL,
	"text_body" text DEFAULT '' NOT NULL,
	"html_body" text,
	"snippet" text DEFAULT '' NOT NULL,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"dedupe_key" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"provider_message_id" text,
	"imap_uid" integer,
	"error_detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "email_messages_message_id_unique" UNIQUE("message_id"),
	CONSTRAINT "email_messages_dedupe_key_unique" UNIQUE("dedupe_key"),
	CONSTRAINT "email_messages_direction_check" CHECK ("email_messages"."direction" IN ('inbound', 'outbound')),
	CONSTRAINT "email_messages_status_check" CHECK ("email_messages"."status" IN ('queued', 'sent', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "email_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_key" text NOT NULL,
	"subject" text NOT NULL,
	"participant_email" text NOT NULL,
	"participant_name" text,
	"customer_id" uuid,
	"status" text DEFAULT 'open' NOT NULL,
	"last_inbound_at" timestamp with time zone,
	"last_outbound_at" timestamp with time zone,
	"owner_last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_threads_status_check" CHECK ("email_threads"."status" IN ('open', 'archived'))
);
--> statement-breakpoint
-- SQL manual: saneamento antes do SET NOT NULL. Linha com attributes NULL nunca
-- conflitava no UNIQUE (product_id, attributes) — é esse furo que fechamos aqui.
UPDATE "product_variants" SET "attributes" = '{}'::jsonb WHERE "attributes" IS NULL;--> statement-breakpoint
ALTER TABLE "product_variants" ALTER COLUMN "attributes" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "product_images" ADD COLUMN "color" text;--> statement-breakpoint
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_thread_id_email_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."email_threads"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_threads" ADD CONSTRAINT "email_threads_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_messages_thread_id_idx" ON "email_messages" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "email_messages_status_idx" ON "email_messages" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "email_threads_thread_key_active_unique_idx" ON "email_threads" USING btree ("thread_key") WHERE "email_threads"."status" <> 'archived';--> statement-breakpoint
CREATE INDEX "product_images_product_id_color_idx" ON "product_images" USING btree ("product_id","color");--> statement-breakpoint
-- SQL manual (drizzle-kit não gera trigger): função set_updated_at existe desde a 0002.
CREATE TRIGGER email_threads_set_updated_at
  BEFORE UPDATE ON email_threads
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();