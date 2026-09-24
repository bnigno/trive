-- Entrevista da curadora: a Lia faz UMA pergunta por dia sobre UMA peça no
-- WhatsApp da dona; a resposta vira rascunho de nota + legendas, que só vai
-- para a peça com o "ok" dela. ask_key (UNIQUE) é o árbitro do cron e o
-- índice parcial garante uma entrevista aberta por vez. Tabela nova nasce
-- com RLS (incidente de 22/09: sem RLS a chave anônima lê a tabela).
CREATE TABLE "curator_interviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ask_key" text NOT NULL,
	"product_id" uuid NOT NULL,
	"question_key" text NOT NULL,
	"question" text NOT NULL,
	"status" text DEFAULT 'asked' NOT NULL,
	"asked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"answer_wa_message_id" uuid,
	"transcript" text,
	"draft" jsonb,
	"draft_sent_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "curator_interviews_ask_key_unique" UNIQUE("ask_key"),
	CONSTRAINT "curator_interviews_status_check" CHECK ("curator_interviews"."status" IN ('asked', 'drafting', 'draft_sent', 'approved', 'skipped', 'expired', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "curator_interviews" ADD CONSTRAINT "curator_interviews_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "curator_interviews" ADD CONSTRAINT "curator_interviews_answer_wa_message_id_wa_messages_id_fk" FOREIGN KEY ("answer_wa_message_id") REFERENCES "public"."wa_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "curator_interviews_one_open_idx" ON "curator_interviews" USING btree ((true)) WHERE "curator_interviews"."status" IN ('asked', 'drafting', 'draft_sent');--> statement-breakpoint
CREATE INDEX "curator_interviews_product_idx" ON "curator_interviews" USING btree ("product_id","asked_at");--> statement-breakpoint
CREATE INDEX "curator_interviews_asked_at_idx" ON "curator_interviews" USING btree ("asked_at");--> statement-breakpoint
ALTER TABLE "curator_interviews" ENABLE ROW LEVEL SECURITY;
