CREATE TABLE "wa_followups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"phone_e164" text NOT NULL,
	"customer_id" uuid,
	"kind" text NOT NULL,
	"reason" text NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"consent_wa_message_id" uuid,
	"requested_by" text DEFAULT 'lia' NOT NULL,
	"sent_at" timestamp with time zone,
	"sent_wa_message_id" uuid,
	"canceled_at" timestamp with time zone,
	"canceled_reason" text,
	"canceled_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wa_followups_kind_check" CHECK ("wa_followups"."kind" IN ('customer', 'idle_cart')),
	CONSTRAINT "wa_followups_status_check" CHECK ("wa_followups"."status" IN ('scheduled', 'sent', 'canceled', 'superseded', 'skipped'))
);
--> statement-breakpoint
ALTER TABLE "wa_followups" ADD CONSTRAINT "wa_followups_conversation_id_wa_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."wa_conversations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_followups" ADD CONSTRAINT "wa_followups_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_followups" ADD CONSTRAINT "wa_followups_consent_wa_message_id_wa_messages_id_fk" FOREIGN KEY ("consent_wa_message_id") REFERENCES "public"."wa_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_followups" ADD CONSTRAINT "wa_followups_sent_wa_message_id_wa_messages_id_fk" FOREIGN KEY ("sent_wa_message_id") REFERENCES "public"."wa_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_followups" ADD CONSTRAINT "wa_followups_canceled_by_users_id_fk" FOREIGN KEY ("canceled_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wa_followups_scheduled_idx" ON "wa_followups" USING btree ("conversation_id","kind") WHERE "wa_followups"."status" = 'scheduled';--> statement-breakpoint
CREATE UNIQUE INDEX "wa_followups_idle_cart_once_idx" ON "wa_followups" USING btree ("conversation_id") WHERE "wa_followups"."kind" = 'idle_cart';--> statement-breakpoint
CREATE INDEX "wa_followups_status_due_idx" ON "wa_followups" USING btree ("status","due_at");--> statement-breakpoint
CREATE INDEX "wa_followups_phone_idx" ON "wa_followups" USING btree ("phone_e164");