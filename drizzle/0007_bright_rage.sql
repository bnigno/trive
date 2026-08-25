ALTER TABLE "wa_conversations" ADD COLUMN "bot_state" jsonb;--> statement-breakpoint
ALTER TABLE "wa_conversations" ADD COLUMN "bot_disabled_until" timestamp with time zone;