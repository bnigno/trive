ALTER TABLE "products" ADD COLUMN "curator_audio_path" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "curator_audio_mime" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "curator_audio_seconds" integer;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "curator_note_updated_at" timestamp with time zone;