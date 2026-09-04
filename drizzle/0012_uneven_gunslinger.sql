ALTER TABLE "categories" ADD COLUMN "cover_path" text;--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "cover_focal_y" smallint DEFAULT 50 NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "receipt_path" text;