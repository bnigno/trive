CREATE TABLE "atelier_intakes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"trigger_wa_message_id" uuid NOT NULL,
	"note_kind" text DEFAULT 'text' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"photo_wa_message_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"photos_count" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"product_id" uuid,
	"parsed" jsonb,
	"error_detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "atelier_intakes_trigger_wa_message_id_unique" UNIQUE("trigger_wa_message_id"),
	CONSTRAINT "atelier_intakes_status_check" CHECK ("atelier_intakes"."status" IN ('queued', 'done', 'failed')),
	CONSTRAINT "atelier_intakes_note_kind_check" CHECK ("atelier_intakes"."note_kind" IN ('text', 'audio', 'caption'))
);
--> statement-breakpoint
ALTER TABLE "atelier_intakes" ADD CONSTRAINT "atelier_intakes_conversation_id_wa_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."wa_conversations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "atelier_intakes" ADD CONSTRAINT "atelier_intakes_trigger_wa_message_id_wa_messages_id_fk" FOREIGN KEY ("trigger_wa_message_id") REFERENCES "public"."wa_messages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "atelier_intakes" ADD CONSTRAINT "atelier_intakes_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "atelier_intakes_conversation_id_created_at_idx" ON "atelier_intakes" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "atelier_intakes_product_id_idx" ON "atelier_intakes" USING btree ("product_id");