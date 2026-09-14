CREATE TABLE "wa_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"inbound_message_id" uuid,
	"followup_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"bubbles" jsonb NOT NULL,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tool_calls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"final_bubbles" jsonb,
	"sent_by" uuid,
	"sent_at" timestamp with time zone,
	"discarded_by" uuid,
	"discarded_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wa_suggestions_status_check" CHECK ("wa_suggestions"."status" IN ('pending', 'sent', 'discarded', 'superseded'))
);
--> statement-breakpoint
ALTER TABLE "wa_conversations" ADD COLUMN "bot_mode" text;--> statement-breakpoint
ALTER TABLE "wa_suggestions" ADD CONSTRAINT "wa_suggestions_conversation_id_wa_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."wa_conversations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_suggestions" ADD CONSTRAINT "wa_suggestions_inbound_message_id_wa_messages_id_fk" FOREIGN KEY ("inbound_message_id") REFERENCES "public"."wa_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_suggestions" ADD CONSTRAINT "wa_suggestions_followup_id_wa_followups_id_fk" FOREIGN KEY ("followup_id") REFERENCES "public"."wa_followups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_suggestions" ADD CONSTRAINT "wa_suggestions_sent_by_users_id_fk" FOREIGN KEY ("sent_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_suggestions" ADD CONSTRAINT "wa_suggestions_discarded_by_users_id_fk" FOREIGN KEY ("discarded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wa_suggestions_inbound_idx" ON "wa_suggestions" USING btree ("inbound_message_id") WHERE "wa_suggestions"."inbound_message_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "wa_suggestions_followup_idx" ON "wa_suggestions" USING btree ("followup_id") WHERE "wa_suggestions"."followup_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "wa_suggestions_conversation_status_idx" ON "wa_suggestions" USING btree ("conversation_id","status");--> statement-breakpoint
ALTER TABLE "wa_conversations" ADD CONSTRAINT "wa_conversations_bot_mode_check" CHECK ("wa_conversations"."bot_mode" IS NULL OR "wa_conversations"."bot_mode" IN ('autonomous', 'copilot'));