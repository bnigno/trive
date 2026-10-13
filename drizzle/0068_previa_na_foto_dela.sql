-- "Me vê com ela": a cliente manda a foto e a Lia devolve ela vestindo a
-- peça. Uma linha por pedido de prévia (da oferta ao envio); nenhuma imagem
-- é guardada — nem aqui nem no Storage.
CREATE TABLE "tryon_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"customer_id" uuid,
	"phone_e164" text NOT NULL,
	"product_id" uuid NOT NULL,
	"color" text,
	"photo_wa_message_id" uuid,
	"status" text DEFAULT 'offered' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"vendor_job_id" text,
	"credits" integer DEFAULT 0 NOT NULL,
	"usd_cents" integer DEFAULT 0 NOT NULL,
	"photo_check" jsonb,
	"verdict" jsonb,
	"failure_reason" text,
	"consent_version" text,
	"offered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_at" timestamp with time zone,
	"declined_at" timestamp with time zone,
	"queued_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tryon_requests_status_check" CHECK ("tryon_requests"."status" IN ('offered', 'declined', 'awaiting_photo', 'queued', 'submitting', 'processing', 'sent', 'photo_rejected', 'failed')),
	CONSTRAINT "tryon_requests_attempts_check" CHECK ("tryon_requests"."attempts" >= 0 AND "tryon_requests"."attempts" <= 2),
	CONSTRAINT "tryon_requests_money_check" CHECK ("tryon_requests"."credits" >= 0 AND "tryon_requests"."usd_cents" >= 0)
);
--> statement-breakpoint
ALTER TABLE "tryon_requests" ADD CONSTRAINT "tryon_requests_conversation_id_wa_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."wa_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tryon_requests" ADD CONSTRAINT "tryon_requests_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tryon_requests" ADD CONSTRAINT "tryon_requests_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tryon_requests" ADD CONSTRAINT "tryon_requests_photo_wa_message_id_wa_messages_id_fk" FOREIGN KEY ("photo_wa_message_id") REFERENCES "public"."wa_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tryon_requests_phone_created_at_idx" ON "tryon_requests" USING btree ("phone_e164","created_at");--> statement-breakpoint
CREATE INDEX "tryon_requests_conversation_created_at_idx" ON "tryon_requests" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "tryon_requests_created_at_idx" ON "tryon_requests" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tryon_requests_vendor_job_id_unique_idx" ON "tryon_requests" USING btree ("vendor_job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tryon_requests_conversation_in_flight_unique_idx" ON "tryon_requests" USING btree ("conversation_id") WHERE "tryon_requests"."status" IN ('queued', 'submitting', 'processing');--> statement-breakpoint
-- Tabela nova nasce legível e apagável pela chave anônima do Supabase se
-- ninguém ligar o RLS (ver migração 0058). tests/db/rls.test.ts guarda isto.
ALTER TABLE "tryon_requests" ENABLE ROW LEVEL SECURITY;
