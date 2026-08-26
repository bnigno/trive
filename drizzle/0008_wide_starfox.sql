ALTER TABLE "wa_messages" ADD COLUMN "kind" text DEFAULT 'text' NOT NULL;--> statement-breakpoint
ALTER TABLE "wa_messages" ADD COLUMN "media_url" text;--> statement-breakpoint
ALTER TABLE "wa_messages" ADD CONSTRAINT "wa_messages_kind_check" CHECK ("wa_messages"."kind" IN ('text', 'image', 'option_list'));