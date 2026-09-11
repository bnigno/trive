ALTER TABLE "wa_messages" DROP CONSTRAINT "wa_messages_kind_check";--> statement-breakpoint
ALTER TABLE "wa_messages" ADD COLUMN "media_meta" jsonb;--> statement-breakpoint
ALTER TABLE "wa_messages" ADD CONSTRAINT "wa_messages_kind_check" CHECK ("wa_messages"."kind" IN ('text', 'image', 'option_list', 'audio'));