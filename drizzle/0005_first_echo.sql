CREATE TABLE "wa_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone_e164" text NOT NULL,
	"customer_id" uuid,
	"status" text DEFAULT 'open' NOT NULL,
	"last_inbound_at" timestamp with time zone,
	"last_outbound_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wa_conversations_status_check" CHECK ("wa_conversations"."status" IN ('open', 'human', 'closed'))
);
--> statement-breakpoint
CREATE TABLE "wa_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"zapi_message_id" text,
	"body" text NOT NULL,
	"template_key" text,
	"dedupe_key" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"outbox_event_id" uuid,
	"order_id" uuid,
	"error_detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	CONSTRAINT "wa_messages_zapi_message_id_unique" UNIQUE("zapi_message_id"),
	CONSTRAINT "wa_messages_dedupe_key_unique" UNIQUE("dedupe_key"),
	CONSTRAINT "wa_messages_direction_check" CHECK ("wa_messages"."direction" IN ('inbound', 'outbound')),
	CONSTRAINT "wa_messages_status_check" CHECK ("wa_messages"."status" IN ('queued', 'sent', 'delivered', 'read', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "wa_templates" (
	"key" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"body_template" text NOT NULL,
	"variables" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wa_conversations" ADD CONSTRAINT "wa_conversations_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_messages" ADD CONSTRAINT "wa_messages_conversation_id_wa_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."wa_conversations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_messages" ADD CONSTRAINT "wa_messages_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wa_conversations_phone_e164_active_unique_idx" ON "wa_conversations" USING btree ("phone_e164") WHERE "wa_conversations"."status" <> 'closed';--> statement-breakpoint
CREATE INDEX "wa_messages_conversation_id_idx" ON "wa_messages" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "wa_messages_status_idx" ON "wa_messages" USING btree ("status");