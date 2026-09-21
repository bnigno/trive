CREATE TABLE "studio_base_photos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"model_key" text NOT NULL,
	"scene_key" text NOT NULL,
	"size_key" text NOT NULL,
	"storage_path" text NOT NULL,
	"status" text DEFAULT 'candidate' NOT NULL,
	"vendor" text NOT NULL,
	"vendor_model" text NOT NULL,
	"seed" bigint,
	"credits" integer DEFAULT 0 NOT NULL,
	"usd_cents" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"chosen_at" timestamp with time zone,
	CONSTRAINT "studio_base_photos_status_check" CHECK ("studio_base_photos"."status" IN ('candidate', 'chosen', 'discarded'))
);
--> statement-breakpoint
CREATE TABLE "studio_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"option_no" integer NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"storage_path" text,
	"judgment" jsonb,
	"score" integer,
	"passed" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'candidate' NOT NULL,
	"vendor" text,
	"vendor_model" text,
	"seed" bigint,
	"usd_cents" integer DEFAULT 0 NOT NULL,
	"chosen_image_id" uuid,
	"error_detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "studio_candidates_status_check" CHECK ("studio_candidates"."status" IN ('candidate', 'rejected', 'chosen', 'discarded', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "studio_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"color" text,
	"scene_key" text NOT NULL,
	"model_key" text NOT NULL,
	"size_key" text NOT NULL,
	"quality" text NOT NULL,
	"options_wanted" integer NOT NULL,
	"options_done" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"source" text DEFAULT 'admin' NOT NULL,
	"requested_by" uuid,
	"usd_cents_spent" integer DEFAULT 0 NOT NULL,
	"error_detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "studio_requests_status_check" CHECK ("studio_requests"."status" IN ('queued', 'done', 'failed')),
	CONSTRAINT "studio_requests_source_check" CHECK ("studio_requests"."source" IN ('admin', 'atelier', 'auto')),
	CONSTRAINT "studio_requests_quality_check" CHECK ("studio_requests"."quality" IN ('economica', 'alta')),
	CONSTRAINT "studio_requests_options_check" CHECK ("studio_requests"."options_wanted" BETWEEN 1 AND 4)
);
--> statement-breakpoint
ALTER TABLE "product_images" ADD COLUMN "origin" text DEFAULT 'upload' NOT NULL;--> statement-breakpoint
ALTER TABLE "studio_base_photos" ADD CONSTRAINT "studio_base_photos_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_candidates" ADD CONSTRAINT "studio_candidates_request_id_studio_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."studio_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_candidates" ADD CONSTRAINT "studio_candidates_chosen_image_id_product_images_id_fk" FOREIGN KEY ("chosen_image_id") REFERENCES "public"."product_images"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_requests" ADD CONSTRAINT "studio_requests_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_requests" ADD CONSTRAINT "studio_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "studio_base_photos_keys_idx" ON "studio_base_photos" USING btree ("model_key","scene_key","size_key");--> statement-breakpoint
CREATE UNIQUE INDEX "studio_base_photos_chosen_unique_idx" ON "studio_base_photos" USING btree ("model_key","scene_key","size_key") WHERE "studio_base_photos"."status" = 'chosen';--> statement-breakpoint
CREATE UNIQUE INDEX "studio_candidates_request_option_attempt_unique_idx" ON "studio_candidates" USING btree ("request_id","option_no","attempt");--> statement-breakpoint
CREATE INDEX "studio_candidates_created_at_idx" ON "studio_candidates" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "studio_requests_product_id_created_at_idx" ON "studio_requests" USING btree ("product_id","created_at");--> statement-breakpoint
CREATE INDEX "product_images_product_id_origin_idx" ON "product_images" USING btree ("product_id","origin");--> statement-breakpoint
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_origin_check" CHECK ("product_images"."origin" IN ('upload', 'ai'));