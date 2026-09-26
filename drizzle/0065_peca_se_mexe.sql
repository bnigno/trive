-- "A peça se mexe": a foto no corpo escolhida vira vídeo curto para o
-- Instagram (FASHN image-to-video). A linha guarda o id do pedido na FASHN
-- (buscar de novo nunca paga de novo), o custo e o caminho do MP4. Nunca
-- aparece na vitrine.
CREATE TABLE "studio_videos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"candidate_id" uuid NOT NULL,
	"source_storage_path" text NOT NULL,
	"color" text,
	"duration_seconds" integer NOT NULL,
	"resolution" text NOT NULL,
	"prompt" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"vendor_job_id" text,
	"vendor" text,
	"vendor_model" text,
	"polls" integer DEFAULT 0 NOT NULL,
	"submitted_at" timestamp with time zone,
	"give_up_at" timestamp with time zone,
	"storage_path" text,
	"bytes" integer,
	"credits" integer NOT NULL,
	"usd_cents" integer DEFAULT 0 NOT NULL,
	"elapsed_ms" integer,
	"error_detail" text,
	"requested_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "studio_videos_status_check" CHECK ("studio_videos"."status" IN ('queued', 'submitting', 'processing', 'done', 'failed', 'discarded')),
	CONSTRAINT "studio_videos_duration_check" CHECK ("studio_videos"."duration_seconds" IN (5, 10)),
	CONSTRAINT "studio_videos_resolution_check" CHECK ("studio_videos"."resolution" IN ('480p', '720p', '1080p')),
	CONSTRAINT "studio_videos_money_check" CHECK ("studio_videos"."credits" >= 0 AND "studio_videos"."usd_cents" >= 0)
);--> statement-breakpoint
ALTER TABLE "studio_videos" ADD CONSTRAINT "studio_videos_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_videos" ADD CONSTRAINT "studio_videos_candidate_id_studio_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."studio_candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_videos" ADD CONSTRAINT "studio_videos_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "studio_videos_product_id_created_at_idx" ON "studio_videos" USING btree ("product_id","created_at");--> statement-breakpoint
CREATE INDEX "studio_videos_created_at_idx" ON "studio_videos" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "studio_videos_vendor_job_id_unique_idx" ON "studio_videos" USING btree ("vendor_job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "studio_videos_candidate_in_flight_unique_idx" ON "studio_videos" USING btree ("candidate_id") WHERE "studio_videos"."status" IN ('queued', 'submitting', 'processing');--> statement-breakpoint
-- Tabela nova nasce legível e apagável pela chave anônima do Supabase se
-- ninguém ligar o RLS (ver migração 0058). tests/db/rls.test.ts guarda isto.
ALTER TABLE "studio_videos" ENABLE ROW LEVEL SECURITY;
