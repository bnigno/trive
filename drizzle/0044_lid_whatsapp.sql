ALTER TABLE "wa_conversations" ADD COLUMN "lid" text;--> statement-breakpoint
CREATE INDEX "wa_conversations_lid_idx" ON "wa_conversations" USING btree ("lid");