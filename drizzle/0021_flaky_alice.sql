ALTER TABLE "product_variants" ADD COLUMN "measurements" jsonb;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "composition" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "care_notes" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "fit_notes" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "curator_note" text;