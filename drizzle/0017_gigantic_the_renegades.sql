ALTER TABLE "orders" ADD COLUMN "is_gift" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "gift_recipient_name" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "gift_message" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "gift_deliver_by" date;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "gift_note_path" text;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_gift_message_len_check" CHECK ("orders"."gift_message" IS NULL OR char_length("orders"."gift_message") <= 280);--> statement-breakpoint
UPDATE "wa_templates"
SET "body_template" = "body_template" || '{{presente}}',
    "variables" = "variables" || '["presente"]'::jsonb
WHERE "key" = 'owner_new_order' AND "body_template" NOT LIKE '%{{presente}}%';
