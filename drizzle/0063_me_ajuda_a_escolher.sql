-- "Me ajuda a escolher?": a cliente em dúvida entre 2 ou 3 peças manda às
-- amigas um link com a votação; cada amiga vota com um toque (sem telefone:
-- voter_key é o hash de um identificador aleatório do aparelho, UNIQUE por
-- rodada). Os votos somem 30 dias depois do fim (fila friends.purge). A
-- ponte do site ganha a origem 'amigas' e a rodada de onde a amiga veio.
-- Tabelas novas nascem com RLS (incidente de 22/09).
CREATE TABLE "friend_answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"round_id" uuid NOT NULL,
	"voter_key" text NOT NULL,
	"choice" integer NOT NULL,
	"note" text,
	"nickname" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "friend_answers_choice_check" CHECK ("friend_answers"."choice" BETWEEN 0 AND 2),
	CONSTRAINT "friend_answers_note_check" CHECK ("friend_answers"."note" IS NULL OR char_length("friend_answers"."note") <= 140),
	CONSTRAINT "friend_answers_nickname_check" CHECK ("friend_answers"."nickname" IS NULL OR char_length("friend_answers"."nickname") <= 30)
);
--> statement-breakpoint
CREATE TABLE "friend_rounds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token" text NOT NULL,
	"kind" text DEFAULT 'decisao' NOT NULL,
	"create_key" text NOT NULL,
	"conversation_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"options" jsonb NOT NULL,
	"closes_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "friend_rounds_token_unique" UNIQUE("token"),
	CONSTRAINT "friend_rounds_create_key_unique" UNIQUE("create_key"),
	CONSTRAINT "friend_rounds_kind_check" CHECK ("friend_rounds"."kind" IN ('decisao')),
	CONSTRAINT "friend_rounds_display_name_check" CHECK (char_length("friend_rounds"."display_name") BETWEEN 1 AND 30)
);
--> statement-breakpoint
ALTER TABLE "site_carts" DROP CONSTRAINT "site_carts_source_check";--> statement-breakpoint
ALTER TABLE "site_carts" ADD COLUMN "round_id" uuid;--> statement-breakpoint
ALTER TABLE "friend_answers" ADD CONSTRAINT "friend_answers_round_id_friend_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."friend_rounds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "friend_rounds" ADD CONSTRAINT "friend_rounds_conversation_id_wa_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."wa_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "friend_answers_round_voter_unique_idx" ON "friend_answers" USING btree ("round_id","voter_key");--> statement-breakpoint
CREATE INDEX "friend_rounds_conversation_idx" ON "friend_rounds" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "friend_rounds_closes_at_idx" ON "friend_rounds" USING btree ("closes_at") WHERE "friend_rounds"."closed_at" IS NULL;--> statement-breakpoint
ALTER TABLE "site_carts" ADD CONSTRAINT "site_carts_round_id_friend_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."friend_rounds"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_carts" ADD CONSTRAINT "site_carts_source_check" CHECK ("site_carts"."source" IN ('pdp', 'cart', 'footer', 'campaign', 'amigas'));--> statement-breakpoint
ALTER TABLE "friend_rounds" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "friend_answers" ENABLE ROW LEVEL SECURITY;
